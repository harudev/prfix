import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

import type { AgentDefinition, AgentSpec } from '../types/agent.js';

/**
 * provider 단위 실행 방식. 모델 이름은 alias 테이블을 거쳐 CLI에 넘긴다.
 * alias에 없는 모델은 그대로 통과시키므로, 새 모델이 나와도 코드 수정이 필요 없다.
 */
export interface ProviderDefinition {
  command: string;
  /**
   * `{{MODEL}}`은 해석된 모델명으로, `{{PROMPT}}`는 프롬프트로 치환된다.
   * `{{PROMPT}}`가 없으면 프롬프트를 stdin으로 넘긴다.
   */
  args: string[];
  modelAliases?: Record<string, string>;
  /** UI 드롭다운에 노출할 모델 목록. 실행 자체는 이 목록에 묶이지 않는다. */
  suggestedModels?: string[];
  env?: Record<string, string>;
}

export const BUILTIN_PROVIDERS: Record<string, ProviderDefinition> = {
  claude: {
    command: 'claude',
    args: ['-p', '--model', '{{MODEL}}', '--permission-mode', 'acceptEdits'],
    modelAliases: {
      opus5: 'opus',
      sonnet5: 'sonnet',
      fable5: 'fable',
      haiku45: 'haiku',
    },
    suggestedModels: ['opus5', 'sonnet5', 'haiku45'],
  },
  codex: {
    command: 'codex',
    args: [
      'exec',
      '-m',
      '{{MODEL}}',
      '-s',
      'workspace-write',
      '--approve-for-me',
      '--skip-git-repo-check',
    ],
    suggestedModels: ['astro6'],
  },
};

export const CONFIG_DIR = join(homedir(), '.config', 'prfix');
const AGENTS_CONFIG_PATH = join(CONFIG_DIR, 'agents.json');

export class AgentRegistry {
  private constructor(private readonly providers: Record<string, ProviderDefinition>) {}

  /** `~/.config/prfix/agents.json`이 있으면 provider 단위로 덮어쓴다. */
  static async load(configPath: string = AGENTS_CONFIG_PATH): Promise<AgentRegistry> {
    const providers: Record<string, ProviderDefinition> = { ...BUILTIN_PROVIDERS };

    try {
      const raw = await readFile(configPath, 'utf8');
      const parsed = JSON.parse(raw) as { providers?: Record<string, ProviderDefinition> };
      for (const [name, definition] of Object.entries(parsed.providers ?? {})) {
        if (isProviderDefinition(definition)) {
          providers[name] = definition;
        } else {
          console.warn(`Warning: Ignoring malformed provider "${name}" in ${configPath}`);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(
          `Warning: Failed to read ${configPath}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }

    return new AgentRegistry(providers);
  }

  static fromProviders(providers: Record<string, ProviderDefinition>): AgentRegistry {
    return new AgentRegistry(providers);
  }

  /** `claude@opus5` → 실행 가능한 정의. 알 수 없는 provider면 null. */
  resolve(ref: string): AgentDefinition | null {
    const spec = parseAgentRef(ref);
    if (!spec) {
      return null;
    }

    const provider = this.providers[spec.provider];
    if (!provider) {
      return null;
    }

    const model = provider.modelAliases?.[spec.model] ?? spec.model;
    const hasPromptArg = provider.args.some((arg) => arg.includes('{{PROMPT}}'));
    const args =
      spec.model === 'default'
        ? stripModelArgs(provider.args)
        : provider.args.map((arg) => arg.replace('{{MODEL}}', model));

    return {
      id: spec.id,
      provider: spec.provider,
      model: spec.model,
      command: provider.command,
      args,
      promptMode: hasPromptArg ? 'arg' : 'stdin',
      env: provider.env,
    };
  }

  /** UI 드롭다운용 목록. */
  list(): AgentSpec[] {
    return Object.entries(this.providers).flatMap(([provider, definition]) =>
      (definition.suggestedModels ?? []).map((model) => ({
        id: `${provider}@${model}`,
        provider,
        model,
      })),
    );
  }
}

/** `provider@model` 문자열을 해석한다. 모델을 생략하면 provider의 기본값을 뜻하는 `default`. */
export function parseAgentRef(ref: string): AgentSpec | null {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const [provider, model, ...extra] = trimmed.split('@');
  if (!provider || extra.length > 0) {
    return null;
  }

  const resolvedModel = model && model.length > 0 ? model : 'default';
  return { id: `${provider}@${resolvedModel}`, provider, model: resolvedModel };
}

/** `provider@default`는 CLI가 자체 설정 기본 모델을 쓰도록 모델 플래그를 통째로 뺀다. */
function stripModelArgs(args: string[]): string[] {
  const index = args.findIndex((arg) => arg.includes('{{MODEL}}'));
  if (index === -1) {
    return [...args];
  }

  const start = index > 0 && args[index - 1].startsWith('-') ? index - 1 : index;
  return [...args.slice(0, start), ...args.slice(index + 1)];
}

function isProviderDefinition(value: unknown): value is ProviderDefinition {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<ProviderDefinition>;
  return (
    typeof candidate.command === 'string' &&
    Array.isArray(candidate.args) &&
    candidate.args.every((arg) => typeof arg === 'string')
  );
}
