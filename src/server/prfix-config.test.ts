import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, mergeConfig } from './prfix-config.js';

describe('mergeConfig', () => {
  it('빈 패치는 기본값을 유지한다', () => {
    expect(mergeConfig(DEFAULT_CONFIG, {})).toEqual(DEFAULT_CONFIG);
    expect(mergeConfig(DEFAULT_CONFIG, null)).toEqual(DEFAULT_CONFIG);
  });

  it('지정한 값만 덮어쓴다', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      defaultAgent: 'codex@astro6',
      autoMerge: false,
    });

    expect(merged.defaultAgent).toBe('codex@astro6');
    expect(merged.autoMerge).toBe(false);
    expect(merged.triggerTokens).toEqual(DEFAULT_CONFIG.triggerTokens);
  });

  it('타입이 어긋나거나 빈 배열이면 기본값을 쓴다', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      defaultAgent: 42,
      triggerTokens: [],
      postFixCommands: ['pnpm lint --fix'],
    });

    expect(merged.defaultAgent).toBe(DEFAULT_CONFIG.defaultAgent);
    expect(merged.triggerTokens).toEqual(DEFAULT_CONFIG.triggerTokens);
    expect(merged.postFixCommands).toEqual(['pnpm lint --fix']);
  });
});
