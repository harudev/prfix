export const DEFAULT_TRIGGER_TOKENS = ['/fp', '/fix-pr'] as const;

export interface TriggerDirective {
  /** `--agent` 로 지정된 참조. 없으면 설정의 기본 에이전트를 쓴다. */
  agentRef?: string;
  /** 트리거 줄을 걷어낸 지시문 본문. */
  instruction: string;
  noMerge: boolean;
  dryRun: boolean;
}

/**
 * 코멘트 본문에서 트리거 지시를 읽는다.
 *
 * 첫 비어있지 않은 줄이 트리거 토큰으로 시작해야 한다. 그 줄의 나머지는 플래그로,
 * 이후 줄 전체는 지시문으로 읽는다. 플래그 뒤에 남은 텍스트도 지시문에 붙는다.
 *
 *   /fp --agent claude@opus5
 *   이 조건문 early return으로 바꿔줘
 */
export function parseTrigger(
  body: string,
  tokens: readonly string[] = DEFAULT_TRIGGER_TOKENS,
): TriggerDirective | null {
  const lines = body.split('\n');
  const triggerLineIndex = lines.findIndex((line) => line.trim().length > 0);
  if (triggerLineIndex === -1) {
    return null;
  }

  const triggerLine = lines[triggerLineIndex].trim();
  const matchedToken = tokens.find(
    (token) => triggerLine === token || triggerLine.startsWith(`${token} `),
  );
  if (!matchedToken) {
    return null;
  }

  const { agentRef, noMerge, dryRun, rest } = parseFlags(
    triggerLine.slice(matchedToken.length).trim(),
  );

  const remainder = lines.slice(triggerLineIndex + 1).join('\n');
  const instruction = [rest, remainder]
    .filter((part) => part.trim().length > 0)
    .join('\n')
    .trim();

  return { agentRef, instruction, noMerge, dryRun };
}

interface ParsedFlags {
  agentRef?: string;
  noMerge: boolean;
  dryRun: boolean;
  rest: string;
}

function parseFlags(input: string): ParsedFlags {
  const tokens = input.length > 0 ? input.split(/\s+/) : [];
  let agentRef: string | undefined;
  let noMerge = false;
  let dryRun = false;
  const rest: string[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];

    if (token === '--agent' || token === '-a') {
      const value = tokens[i + 1];
      if (value && !value.startsWith('-')) {
        agentRef = value;
        i += 1;
      }
      continue;
    }

    if (token.startsWith('--agent=')) {
      agentRef = token.slice('--agent='.length);
      continue;
    }

    if (token === '--no-merge') {
      noMerge = true;
      continue;
    }

    if (token === '--dry-run') {
      dryRun = true;
      continue;
    }

    rest.push(token);
  }

  return { agentRef, noMerge, dryRun, rest: rest.join(' ') };
}

/** 커밋 메시지 제목으로 쓸 한 줄 요약. */
export function summarizeInstruction(instruction: string, maxLength = 60): string {
  const firstLine =
    instruction
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? 'apply review comment';

  if (firstLine.length <= maxLength) {
    return firstLine;
  }

  return `${firstLine.slice(0, maxLength - 1)}…`;
}
