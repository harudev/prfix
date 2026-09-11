import { describe, expect, it } from 'vitest';

import { AgentRegistry, BUILTIN_PROVIDERS, parseAgentRef } from './agent-registry.js';

describe('parseAgentRef', () => {
  it('provider@model을 나눈다', () => {
    expect(parseAgentRef('claude@opus5')).toEqual({
      id: 'claude@opus5',
      provider: 'claude',
      model: 'opus5',
    });
  });

  it('모델을 생략하면 default로 읽는다', () => {
    expect(parseAgentRef('codex')).toEqual({
      id: 'codex@default',
      provider: 'codex',
      model: 'default',
    });
  });

  it('@가 두 번 이상이면 거부한다', () => {
    expect(parseAgentRef('claude@opus@5')).toBeNull();
    expect(parseAgentRef('  ')).toBeNull();
  });
});

describe('AgentRegistry', () => {
  const registry = AgentRegistry.fromProviders(BUILTIN_PROVIDERS);

  it('alias가 있는 모델은 CLI 이름으로 바꾼다', () => {
    const claude = registry.resolve('claude@opus5');

    expect(claude?.command).toBe('claude');
    expect(claude?.args).toContain('opus');
    expect(claude?.promptMode).toBe('stdin');
  });

  it('alias가 없는 모델은 그대로 넘긴다', () => {
    expect(registry.resolve('codex@astro6')?.args).toContain('astro6');
  });

  it('default 모델은 모델 플래그를 통째로 뺀다', () => {
    const args = registry.resolve('codex@default')?.args ?? [];

    expect(args).not.toContain('-m');
    expect(args.some((arg) => arg.includes('{{MODEL}}'))).toBe(false);
    expect(args).toContain('exec');
  });

  it('모르는 provider는 null', () => {
    expect(registry.resolve('cursor@fast')).toBeNull();
  });

  it('{{PROMPT}}가 있으면 프롬프트를 인자로 넘긴다', () => {
    const custom = AgentRegistry.fromProviders({
      stub: { command: 'echo', args: ['{{PROMPT}}'] },
    });

    expect(custom.resolve('stub@any')?.promptMode).toBe('arg');
  });

  it('드롭다운 목록은 provider별 추천 모델을 편다', () => {
    expect(registry.list()).toEqual(
      expect.arrayContaining([
        { id: 'claude@opus5', provider: 'claude', model: 'opus5' },
        { id: 'codex@astro6', provider: 'codex', model: 'astro6' },
      ]),
    );
  });
});
