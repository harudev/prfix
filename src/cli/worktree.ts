import { execFileSync } from 'child_process';
import { basename, dirname, join } from 'path';

import type { PrContext } from '../types/agent.js';

import type { PrMeta } from './github.js';
import { getGitRoot } from './utils.js';

interface GroveWorktree {
  branch: string;
  path: string;
}

/**
 * PR head 브랜치가 체크아웃된 워크트리를 확보한다.
 *
 * grove가 있으면 `grove init <PR URL>`에 맡긴다 (local-files 복사, post-checkout 실행까지
 * 수행하므로 직접 만드는 것보다 낫다). 없으면 `git worktree add`로 대체한다.
 */
export function preparePrWorktree(prUrl: string, prMeta: PrMeta): PrContext {
  const gitRoot = getGitRoot();
  const remote = resolveRemote(gitRoot);

  if (prMeta.isCrossRepository) {
    throw new Error(
      'Fork에서 올라온 PR은 아직 지원하지 않습니다. head 브랜치가 origin에 없어 수정 커밋을 push할 수 없습니다.',
    );
  }

  const existing = findWorktreeForBranch(gitRoot, prMeta.headRefName);
  if (existing) {
    return { repoPath: existing, headBranch: prMeta.headRefName, remote, prUrl };
  }

  const created = hasGrove()
    ? createWithGrove(gitRoot, prUrl, prMeta.headRefName)
    : createWithGit(gitRoot, remote, prMeta.headRefName);

  return { repoPath: created, headBranch: prMeta.headRefName, remote, prUrl };
}

/**
 * 시작 시점에 리뷰 워크트리를 리모트 head에 맞춘다.
 *
 * 세션 중에는 로컬에 커밋을 쌓기만 하므로, 어긋남은 여기서 한 번만 정리한다.
 * 로컬에 이미 안 올라간 커밋이 있으면 ff-only가 실패하는데, 그건 사용자가 판단할 일이라
 * 경고만 남기고 넘어간다.
 */
export function syncWorktreeWithRemote(context: PrContext): void {
  const run = (args: string[]) =>
    execFileSync('git', args, {
      cwd: context.repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  try {
    run(['fetch', context.remote, context.headBranch]);
    run(['merge', '--ff-only', `${context.remote}/${context.headBranch}`]);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : 'Unknown error';
    console.warn(`Warning: 리모트 head와 동기화하지 못했습니다 (그대로 진행): ${detail}`);
  }
}

/**
 * 링크에 담긴 리비전이 로컬에 있는지 확인하고, 없으면 PR 히스토리를 끌어온다.
 *
 * force-push 전 커밋처럼 브랜치에서 닿지 않는 SHA도 `refs/pull/<N>/head`로는 받아올 수 있다.
 * 그래도 없는 리비전을 돌려준다.
 */
export function ensureRevisionsAvailable(
  context: PrContext,
  pullNumber: number,
  revisions: string[],
): string[] {
  const missing = revisions.filter((revision) => !revisionExists(context.repoPath, revision));
  if (missing.length === 0) {
    return [];
  }

  try {
    execFileSync('git', ['fetch', context.remote, `refs/pull/${pullNumber}/head`], {
      cwd: context.repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // fetch 실패는 아래 재확인에서 미해결 리비전으로 드러난다.
  }

  return missing.filter((revision) => !revisionExists(context.repoPath, revision));
}

function revisionExists(repoPath: string, revision: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], {
      cwd: repoPath,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** grove와 git 양쪽을 훑어 해당 브랜치가 체크아웃된 워크트리 경로를 찾는다. */
function findWorktreeForBranch(repoPath: string, branch: string): string | null {
  return (
    listGroveWorktrees(repoPath).find((entry) => entry.branch === branch)?.path ??
    listGitWorktrees(repoPath).find((entry) => entry.branch === branch)?.path ??
    null
  );
}

function listGroveWorktrees(repoPath: string): GroveWorktree[] {
  if (!hasGrove()) {
    return [];
  }

  try {
    const stdout = execFileSync('grove', ['list', '--json'], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(stdout) as GroveWorktree[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** `git worktree list --porcelain` 파싱. 메인 워크트리도 포함한다. */
export function parseGitWorktreeList(porcelain: string): GroveWorktree[] {
  const entries: GroveWorktree[] = [];
  let path: string | null = null;

  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      path = line.slice('worktree '.length).trim();
      continue;
    }

    if (line.startsWith('branch ') && path) {
      entries.push({ path, branch: line.slice('branch refs/heads/'.length).trim() });
      path = null;
    }
  }

  return entries;
}

function listGitWorktrees(repoPath: string): GroveWorktree[] {
  try {
    const stdout = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return parseGitWorktreeList(stdout);
  } catch {
    return [];
  }
}

function createWithGrove(repoPath: string, prUrl: string, branch: string): string {
  console.log(`🌳 grove로 워크트리를 만듭니다: ${prUrl}`);
  execFileSync('grove', ['init', prUrl], { cwd: repoPath, stdio: 'inherit' });

  const created = findWorktreeForBranch(repoPath, branch);
  if (!created) {
    throw new Error(`grove init 후에도 ${branch} 워크트리를 찾지 못했습니다.`);
  }

  return created;
}

function createWithGit(repoPath: string, remote: string, branch: string): string {
  const worktreePath = join(
    dirname(repoPath),
    `${basename(repoPath)}-worktrees`,
    branch.replaceAll('/', '-'),
  );

  console.log(`🌳 git worktree를 만듭니다: ${worktreePath}`);
  execFileSync('git', ['fetch', remote, branch], { cwd: repoPath, stdio: 'inherit' });
  execFileSync(
    'git',
    ['worktree', 'add', '--track', '-b', branch, worktreePath, `${remote}/${branch}`],
    { cwd: repoPath, stdio: 'inherit' },
  );

  return worktreePath;
}

function resolveRemote(repoPath: string): string {
  try {
    const stdout = execFileSync('git', ['remote'], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const remotes = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return remotes.includes('origin') ? 'origin' : (remotes[0] ?? 'origin');
  } catch {
    return 'origin';
  }
}

function hasGrove(): boolean {
  try {
    execFileSync('grove', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
