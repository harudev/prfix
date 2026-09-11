import { describe, expect, it } from 'vitest';

import { parseGitWorktreeList } from './worktree.js';

describe('parseGitWorktreeList', () => {
  it('브랜치가 붙은 워크트리만 읽는다', () => {
    const porcelain = [
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /repo-worktrees/D2-339',
      'HEAD def456',
      'branch refs/heads/feature/D2-339',
      '',
      'worktree /repo-worktrees/detached',
      'HEAD 999999',
      'detached',
      '',
    ].join('\n');

    expect(parseGitWorktreeList(porcelain)).toEqual([
      { path: '/repo', branch: 'main' },
      { path: '/repo-worktrees/D2-339', branch: 'feature/D2-339' },
    ]);
  });

  it('빈 입력은 빈 배열', () => {
    expect(parseGitWorktreeList('')).toEqual([]);
  });
});
