import { describe, expect, it } from 'vitest';

import type { AgentTask } from '../types/agent.js';

import { buildCommitMessage, buildPrompt, formatPosition } from './fix-pipeline.js';

function createTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'ab12cd34',
    threadId: 'thread-1',
    filePath: 'src/app.ts',
    position: { side: 'new', line: 42 },
    instruction: '널 체크 추가\n그리고 테스트도',
    agent: { id: 'claude@opus5', provider: 'claude', model: 'opus5' },
    status: 'running',
    createdAt: '2026-09-11T00:00:00.000Z',
    log: [],
    noMerge: false,
    dryRun: false,
    ...overrides,
  };
}

describe('formatPosition', () => {
  it('단일 라인', () => {
    expect(formatPosition({ side: 'new', line: 42 })).toBe('42 (head)');
  });

  it('범위와 base side', () => {
    expect(formatPosition({ side: 'old', line: { start: 10, end: 14 } })).toBe('10-14 (base)');
  });
});

describe('buildPrompt', () => {
  it('파일·라인·코멘트와 제약을 함께 넘긴다', () => {
    const prompt = buildPrompt(createTask());

    expect(prompt).toContain('src/app.ts');
    expect(prompt).toContain('42 (head)');
    expect(prompt).toContain('널 체크 추가');
    expect(prompt).toContain('커밋하거나 push하지 않는다');
  });
});

describe('buildCommitMessage', () => {
  it('제목은 지시문 첫 줄, 본문에 추적 정보를 남긴다', () => {
    const message = buildCommitMessage(createTask());

    expect(message.split('\n')[0]).toBe('fix(review): 널 체크 추가');
    expect(message).toContain('thread: thread-1');
    expect(message).toContain('file: src/app.ts:42 (head)');
    expect(message).toContain('agent: claude@opus5');
  });
});
