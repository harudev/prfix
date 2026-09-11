import { readFile } from 'fs/promises';
import { join } from 'path';

import { CONFIG_DIR } from './agent-registry.js';
import { DEFAULT_TRIGGER_TOKENS } from './trigger-parser.js';

export interface PrfixConfig {
  /** `--agent` 없이 트리거했을 때 쓸 에이전트. */
  defaultAgent: string;
  /** 코멘트를 작업으로 인식할 접두사. */
  triggerTokens: string[];
  /** 커밋 직전 워크트리에서 실행할 명령. */
  postFixCommands: string[];
  /** false면 커밋까지만 하고 머지는 사용자가 직접 한다. */
  autoMerge: boolean;
  /** true면 작업마다 바로 push한다. 기본은 로컬 head에 쌓아두고 Push 버튼으로 한 번에 올린다. */
  autoPush: boolean;
}

export const DEFAULT_CONFIG: PrfixConfig = {
  defaultAgent: 'claude@opus5',
  triggerTokens: [...DEFAULT_TRIGGER_TOKENS],
  postFixCommands: [],
  autoMerge: true,
  autoPush: false,
};

const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export async function loadPrfixConfig(configPath: string = CONFIG_PATH): Promise<PrfixConfig> {
  try {
    const raw = await readFile(configPath, 'utf8');
    return mergeConfig(DEFAULT_CONFIG, JSON.parse(raw) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(
        `Warning: Failed to read ${configPath}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
    return { ...DEFAULT_CONFIG };
  }
}

export function mergeConfig(base: PrfixConfig, patch: unknown): PrfixConfig {
  if (typeof patch !== 'object' || patch === null) {
    return { ...base };
  }

  const candidate = patch as Partial<Record<keyof PrfixConfig, unknown>>;

  return {
    defaultAgent:
      typeof candidate.defaultAgent === 'string' && candidate.defaultAgent.length > 0
        ? candidate.defaultAgent
        : base.defaultAgent,
    triggerTokens:
      Array.isArray(candidate.triggerTokens) &&
      candidate.triggerTokens.every((token) => typeof token === 'string') &&
      candidate.triggerTokens.length > 0
        ? (candidate.triggerTokens as string[])
        : base.triggerTokens,
    postFixCommands:
      Array.isArray(candidate.postFixCommands) &&
      candidate.postFixCommands.every((command) => typeof command === 'string')
        ? (candidate.postFixCommands as string[])
        : base.postFixCommands,
    autoMerge: typeof candidate.autoMerge === 'boolean' ? candidate.autoMerge : base.autoMerge,
    autoPush: typeof candidate.autoPush === 'boolean' ? candidate.autoPush : base.autoPush,
  };
}
