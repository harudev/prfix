import { spawn } from 'child_process';
import { basename, dirname, join } from 'path';

import { simpleGit } from 'simple-git';

import type { AgentDefinition, AgentTask, PrContext } from '../types/agent.js';
import type { DiffCommentPosition } from '../types/diff.js';

import { summarizeInstruction } from './trigger-parser.js';

export interface FixPipelineHooks {
  log(stream: 'system' | 'stdout' | 'stderr', text: string): void;
  /** 취소 시 프로세스를 죽일 수 있도록 실행 중인 자식을 등록한다. */
  registerProcess(kill: () => void): void;
}

export interface FixPipelineOptions {
  postFixCommands?: string[];
  /** 에이전트 실행 제한 시간. 기본 20분. */
  timeoutMs?: number;
  /** 작업마다 바로 push한다. 기본은 로컬에 쌓아두고 사용자가 한 번에 올린다. */
  autoPush?: boolean;
}

export interface FixPipelineResult {
  status: 'merged' | 'committed' | 'no-change';
  branch: string;
  worktreePath: string;
  commitSha?: string;
  changedFiles?: string[];
}

/**
 * 코멘트 하나를 수정 커밋으로 만든다.
 *
 * head 브랜치에서 딴 fp 브랜치 워크트리에서 에이전트를 돌리고, 변경이 있으면 커밋한 뒤
 * 리뷰 워크트리의 head 브랜치로 머지·푸시한다. 실패하면 워크트리를 남겨 이어서 손볼 수 있게 한다.
 */
export async function runFixPipeline(
  task: AgentTask,
  agent: AgentDefinition,
  context: PrContext,
  hooks: FixPipelineHooks,
  options: FixPipelineOptions = {},
): Promise<FixPipelineResult> {
  const branch = `fp/${context.headBranch}/${task.id}`;
  const repoGit = simpleGit(context.repoPath);
  const worktreePath = join(await resolveWorktreeRoot(context.repoPath), `fp-${task.id}`);

  hooks.log('system', `fetch ${context.remote}/${context.headBranch}`);
  await repoGit.fetch(context.remote, context.headBranch);

  hooks.log('system', `worktree add ${worktreePath} (${branch})`);
  await repoGit.raw([
    'worktree',
    'add',
    '-b',
    branch,
    worktreePath,
    `${context.remote}/${context.headBranch}`,
  ]);

  const worktreeGit = simpleGit(worktreePath);
  const prompt = buildPrompt(task);
  hooks.log('system', `${agent.command} ${agent.args.join(' ')}`);

  if (task.dryRun) {
    await runDryRunStub(worktreePath, task, hooks);
  } else {
    await runAgent(agent, prompt, worktreePath, hooks, options.timeoutMs ?? 20 * 60 * 1000);
  }

  for (const command of options.postFixCommands ?? []) {
    hooks.log('system', `post-fix: ${command}`);
    await runShellCommand(command, worktreePath, hooks);
  }

  const status = await worktreeGit.status();
  if (status.isClean()) {
    hooks.log('system', '변경 없음 — 커밋하지 않습니다.');
    await cleanupWorktree(repoGit, worktreePath, branch, hooks);
    return { status: 'no-change', branch, worktreePath };
  }

  const changedFiles = status.files.map((file) => file.path);
  await worktreeGit.add(['-A']);
  // 새 워크트리에는 의존성이 깔려 있지 않아 husky 등 로컬 훅이 깨진다.
  // lint·format은 postFixCommands로 명시적으로 돌린다.
  await worktreeGit.commit(buildCommitMessage(task), undefined, { '--no-verify': null });
  const commitSha = (await worktreeGit.revparse(['HEAD'])).trim();
  hooks.log('system', `commit ${commitSha.slice(0, 8)} (${changedFiles.length} files)`);

  if (task.noMerge) {
    hooks.log('system', `--no-merge: ${branch} 브랜치와 워크트리를 남겨둡니다.`);
    return { status: 'committed', branch, worktreePath, commitSha, changedFiles };
  }

  await mergeIntoHead(context, branch, hooks);
  await cleanupWorktree(repoGit, worktreePath, branch, hooks);

  if (options.autoPush) {
    hooks.log('system', `push ${context.remote} ${context.headBranch}`);
    await simpleGit(context.repoPath).push(context.remote, context.headBranch);
  } else {
    hooks.log('system', `로컬 ${context.headBranch}에 머지했습니다. push는 따로 하세요.`);
  }

  return { status: 'merged', branch, worktreePath, commitSha, changedFiles };
}

/** 리뷰 워크트리의 로컬 head 브랜치에 머지한다. push는 하지 않는다. */
async function mergeIntoHead(
  context: PrContext,
  branch: string,
  hooks: FixPipelineHooks,
): Promise<void> {
  const git = simpleGit(context.repoPath);

  const current = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  if (current !== context.headBranch) {
    throw new Error(
      `리뷰 워크트리가 ${context.headBranch}가 아닌 ${current}에 있습니다. 머지를 중단합니다.`,
    );
  }

  const status = await git.status();
  if (!status.isClean()) {
    throw new Error('리뷰 워크트리에 커밋되지 않은 변경이 있어 머지할 수 없습니다.');
  }

  hooks.log('system', `merge --no-ff ${branch}`);
  await git.raw(['merge', '--no-ff', '-m', `merge ${branch}`, branch]);

  // git merge는 충돌해도 여기까지 예외 없이 도달한다. 충돌을 남겨두면 리뷰 워크트리가
  // 망가진 채로 다음 작업이 이어지므로, 되돌리고 실패로 올린다.
  const merged = await git.status();
  if (merged.conflicted.length > 0) {
    await git.raw(['merge', '--abort']);
    throw new Error(
      `머지 충돌로 중단했습니다 (${merged.conflicted.join(', ')}). ` +
        `수정 커밋은 ${branch} 브랜치에 남아 있으니 직접 머지하세요.`,
    );
  }
}

/** 로컬 head 브랜치가 리모트보다 몇 커밋 앞서 있는지. Push 버튼 표시에 쓴다. */
export async function countUnpushedCommits(context: PrContext): Promise<number> {
  const git = simpleGit(context.repoPath);
  const range = `${context.remote}/${context.headBranch}..${context.headBranch}`;
  const output = await git.raw(['rev-list', '--count', range]);

  return Number.parseInt(output.trim(), 10) || 0;
}

/** 누적된 로컬 커밋을 PR head 브랜치로 한 번에 올린다. */
export async function pushHeadBranch(context: PrContext): Promise<{ pushed: number }> {
  const pushed = await countUnpushedCommits(context);
  if (pushed === 0) {
    return { pushed: 0 };
  }

  await simpleGit(context.repoPath).push(context.remote, context.headBranch);
  return { pushed };
}

/**
 * fp 워크트리를 둘 곳을 정한다.
 *
 * 리뷰 대상이 이미 워크트리일 수 있으므로 거기서 상대 경로를 잡으면 `-worktrees`가 중첩된다.
 * git common dir로 메인 저장소를 찾아 grove와 같은 `<repo>-worktrees/` 아래에 만든다.
 */
async function resolveWorktreeRoot(repoPath: string): Promise<string> {
  const commonDir = (
    await simpleGit(repoPath).raw(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  ).trim();
  const mainRepoPath = basename(commonDir) === '.git' ? dirname(commonDir) : repoPath;

  return join(dirname(mainRepoPath), `${basename(mainRepoPath)}-worktrees`);
}

async function cleanupWorktree(
  repoGit: ReturnType<typeof simpleGit>,
  worktreePath: string,
  branch: string,
  hooks: FixPipelineHooks,
): Promise<void> {
  try {
    await repoGit.raw(['worktree', 'remove', '--force', worktreePath]);
    await repoGit.raw(['branch', '-D', branch]);
    hooks.log('system', `정리 완료: ${worktreePath}`);
  } catch (error) {
    hooks.log(
      'system',
      `정리 실패 (수동 정리 필요): ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

export function formatPosition(position: DiffCommentPosition): string {
  const side = position.side === 'old' ? 'base' : 'head';
  const line =
    typeof position.line === 'number'
      ? `${position.line}`
      : `${position.line.start}-${position.line.end}`;
  return `${line} (${side})`;
}

export function buildPrompt(task: AgentTask): string {
  return [
    '너는 GitHub PR 리뷰 코멘트를 반영하는 작업을 맡았다.',
    '',
    `대상 파일: ${task.filePath}`,
    `대상 라인: ${formatPosition(task.position)}`,
    '',
    '리뷰 코멘트:',
    task.instruction,
    '',
    '규칙:',
    '- 지적된 범위와 그에 직접 필요한 부분만 수정한다.',
    '- 무관한 리팩터링, 포매팅 변경, 파일 추가를 하지 않는다.',
    '- 커밋하거나 push하지 않는다. 작업 트리에 변경만 남긴다.',
    '- 코멘트가 코드 변경을 요구하지 않으면 아무것도 수정하지 않는다.',
  ].join('\n');
}

export function buildCommitMessage(task: AgentTask): string {
  return [
    `fix(review): ${summarizeInstruction(task.instruction)}`,
    '',
    `thread: ${task.threadId}`,
    `file: ${task.filePath}:${formatPosition(task.position)}`,
    `agent: ${task.agent.id}`,
  ].join('\n');
}

function runAgent(
  agent: AgentDefinition,
  prompt: string,
  cwd: string,
  hooks: FixPipelineHooks,
  timeoutMs: number,
): Promise<void> {
  const args =
    agent.promptMode === 'arg'
      ? agent.args.map((arg) => arg.replace('{{PROMPT}}', prompt))
      : agent.args;

  return new Promise((resolve, reject) => {
    const child = spawn(agent.command, args, {
      cwd,
      env: { ...process.env, ...agent.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      hooks.log('system', `제한 시간(${Math.round(timeoutMs / 1000)}s) 초과 — 중단합니다.`);
      child.kill('SIGKILL');
    }, timeoutMs);

    hooks.registerProcess(() => child.kill('SIGKILL'));

    child.stdout.on('data', (chunk: Buffer) => hooks.log('stdout', chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => hooks.log('stderr', chunk.toString('utf8')));

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`${agent.command} 실행 실패: ${error.message}`));
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) {
        reject(new Error(`${agent.command}가 ${signal} 신호로 종료되었습니다.`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${agent.command}가 종료 코드 ${code}로 실패했습니다.`));
        return;
      }
      resolve();
    });

    if (agent.promptMode === 'stdin') {
      child.stdin.end(prompt);
    } else {
      child.stdin.end();
    }
  });
}

function runShellCommand(command: string, cwd: string, hooks: FixPipelineHooks): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk: Buffer) => hooks.log('stdout', chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => hooks.log('stderr', chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`post-fix 명령이 종료 코드 ${code}로 실패했습니다: ${command}`));
        return;
      }
      resolve();
    });
  });
}

/** --dry-run: 에이전트 대신 대상 파일 끝에 마커 한 줄을 붙여 파이프라인 전 구간을 검증한다. */
async function runDryRunStub(
  worktreePath: string,
  task: AgentTask,
  hooks: FixPipelineHooks,
): Promise<void> {
  const { appendFile } = await import('fs/promises');
  const target = join(worktreePath, task.filePath);
  hooks.log('system', `[dry-run] ${task.filePath}에 마커를 추가합니다.`);
  await appendFile(target, `\n// prfix dry-run: ${task.id}\n`, 'utf8');
}
