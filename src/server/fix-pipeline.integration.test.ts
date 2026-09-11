import { existsSync } from 'fs';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentDefinition, AgentTask, PrContext } from '../types/agent.js';

import { countUnpushedCommits, pushHeadBranch, runFixPipeline } from './fix-pipeline.js';

const AGENT: AgentDefinition = {
  id: 'stub@dry',
  provider: 'stub',
  model: 'dry',
  command: 'true',
  args: [],
  promptMode: 'stdin',
};

function createTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'test1234',
    threadId: 'thread-1',
    filePath: 'src/app.ts',
    position: { side: 'new', line: 1 },
    instruction: '널 체크 추가',
    agent: { id: AGENT.id, provider: AGENT.provider, model: AGENT.model },
    status: 'running',
    createdAt: '2026-09-11T00:00:00.000Z',
    log: [],
    noMerge: false,
    dryRun: true,
    ...overrides,
  };
}

function createHooks() {
  const lines: string[] = [];
  return {
    lines,
    hooks: {
      log: (_stream: 'system' | 'stdout' | 'stderr', text: string) => lines.push(text),
      registerProcess: () => {},
    },
  };
}

describe('runFixPipeline (integration)', () => {
  let root: string;
  let remotePath: string;
  let reviewPath: string;
  let context: PrContext;

  beforeEach(async () => {
    // git 훅 안에서 테스트가 돌면 GIT_DIR·GIT_INDEX_FILE이 상속돼 임시 레포 대신
    // 이 저장소를 가리킨다. 이 테스트는 자기 레포만 건드려야 한다.
    for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_PREFIX']) {
      delete process.env[key];
    }

    root = await mkdtemp(join(tmpdir(), 'prfix-'));
    remotePath = join(root, 'remote.git');
    reviewPath = join(root, 'review');

    await simpleGit().raw(['init', '--bare', '--initial-branch=main', remotePath]);
    await simpleGit().clone(remotePath, reviewPath);

    const git = simpleGit(reviewPath);
    await git.addConfig('user.name', 'prfix test');
    await git.addConfig('user.email', 'prfix@example.com');
    await git.raw(['checkout', '-b', 'main']);

    await writeFile(join(reviewPath, 'seed.txt'), 'seed\n', 'utf8');
    await git.add(['-A']);
    await git.commit('seed');
    await git.push(['-u', 'origin', 'main']);

    // PR head 브랜치
    await git.raw(['checkout', '-b', 'feature/x']);
    await writeFile(join(reviewPath, 'app.ts'), 'export const a = 1;\n', 'utf8');
    await writeFile(join(reviewPath, 'util.ts'), 'export const b = 2;\n', 'utf8');
    await git.add(['-A']);
    await git.commit('add app');
    await git.push(['-u', 'origin', 'feature/x']);

    context = { repoPath: reviewPath, headBranch: 'feature/x', remote: 'origin', prUrl: '' };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('로컬 head 브랜치에만 머지하고 push하지 않는다', async () => {
    const { hooks } = createHooks();
    const task = createTask({ filePath: 'app.ts' });

    const result = await runFixPipeline(task, AGENT, context, hooks);

    expect(result.status).toBe('merged');
    expect(result.commitSha).toBeDefined();
    expect(result.changedFiles).toEqual(['app.ts']);

    // 워크트리와 fp 브랜치가 정리되었다
    expect(existsSync(result.worktreePath)).toBe(false);
    const branches = await simpleGit(reviewPath).branch();
    expect(branches.all).not.toContain(result.branch);

    // 로컬에는 반영됐지만 리모트는 그대로다
    const localFile = await simpleGit(reviewPath).raw(['show', 'feature/x:app.ts']);
    expect(localFile).toContain('prfix dry-run: test1234');
    const remoteFile = await simpleGit(remotePath).raw(['show', 'feature/x:app.ts']);
    expect(remoteFile).not.toContain('prfix dry-run');

    const log = await simpleGit(reviewPath).log({ maxCount: 5 });
    expect(log.all.some((entry) => entry.message.startsWith('fix(review): 널 체크 추가'))).toBe(
      true,
    );
  });

  it('쌓인 커밋을 pushHeadBranch로 한 번에 올린다', async () => {
    const { hooks } = createHooks();

    await runFixPipeline(createTask({ id: 'push0001', filePath: 'app.ts' }), AGENT, context, hooks);
    await runFixPipeline(
      createTask({ id: 'push0002', filePath: 'util.ts' }),
      AGENT,
      context,
      hooks,
    );

    // fix 커밋 2개 + 머지 커밋 2개
    expect(await countUnpushedCommits(context)).toBe(4);

    expect(await pushHeadBranch(context)).toEqual({ pushed: 4 });
    expect(await countUnpushedCommits(context)).toBe(0);

    const git = simpleGit(remotePath);
    expect(await git.raw(['show', 'feature/x:app.ts'])).toContain('prfix dry-run: push0001');
    expect(await git.raw(['show', 'feature/x:util.ts'])).toContain('prfix dry-run: push0002');
  });

  it('머지 충돌이면 되돌리고 실패로 올린다', async () => {
    const { hooks } = createHooks();

    await runFixPipeline(createTask({ id: 'conf0001', filePath: 'app.ts' }), AGENT, context, hooks);
    const headAfterFirst = await simpleGit(reviewPath).revparse(['HEAD']);

    // 같은 파일 같은 위치를 건드리므로 두 번째는 충돌한다
    await expect(
      runFixPipeline(createTask({ id: 'conf0002', filePath: 'app.ts' }), AGENT, context, hooks),
    ).rejects.toThrow('머지 충돌');

    // head가 되돌아갔고 충돌 흔적이 없다
    expect(await simpleGit(reviewPath).revparse(['HEAD'])).toBe(headAfterFirst);
    expect((await simpleGit(reviewPath).status()).isClean()).toBe(true);

    // 수정 커밋은 fp 브랜치와 워크트리에 남아 있다
    const branches = await simpleGit(reviewPath).branch();
    expect(branches.all).toContain('fp/feature/x/conf0002');
  });

  it('autoPush면 작업마다 바로 push한다', async () => {
    const { hooks } = createHooks();
    const task = createTask({ id: 'autopush', filePath: 'app.ts' });

    await runFixPipeline(task, AGENT, context, hooks, { autoPush: true });

    expect(await countUnpushedCommits(context)).toBe(0);
    const remoteFile = await simpleGit(remotePath).raw(['show', 'feature/x:app.ts']);
    expect(remoteFile).toContain('prfix dry-run: autopush');
  });

  it('--no-merge면 커밋만 하고 브랜치와 워크트리를 남긴다', async () => {
    const { hooks } = createHooks();
    const task = createTask({ id: 'test5678', filePath: 'app.ts', noMerge: true });

    const result = await runFixPipeline(task, AGENT, context, hooks);

    expect(result.status).toBe('committed');
    expect(existsSync(result.worktreePath)).toBe(true);

    const remoteFile = await simpleGit(remotePath).raw(['show', 'feature/x:app.ts']);
    expect(remoteFile).not.toContain('prfix dry-run');
  });

  it('에이전트가 아무것도 바꾸지 않으면 커밋하지 않는다', async () => {
    const { hooks } = createHooks();
    const noopAgent: AgentDefinition = { ...AGENT, command: 'true' };
    const task = createTask({ id: 'test9999', filePath: 'app.ts', dryRun: false });

    const result = await runFixPipeline(task, noopAgent, context, hooks);

    expect(result.status).toBe('no-change');
    expect(result.commitSha).toBeUndefined();
    expect(existsSync(result.worktreePath)).toBe(false);
  });
});
