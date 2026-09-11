import { describe, expect, it } from 'vitest';

import { parseTrigger, summarizeInstruction } from './trigger-parser.js';

describe('parseTrigger', () => {
  it('트리거가 없는 코멘트는 무시한다', () => {
    expect(parseTrigger('여기 로직이 이상해 보여요')).toBeNull();
  });

  it('트리거 줄 다음 내용을 지시문으로 읽는다', () => {
    const result = parseTrigger('/fp\n이 조건문 early return으로 바꿔줘');

    expect(result).toEqual({
      agentRef: undefined,
      instruction: '이 조건문 early return으로 바꿔줘',
      noMerge: false,
      dryRun: false,
    });
  });

  it('--agent 를 읽는다', () => {
    const result = parseTrigger('/fp --agent claude@opus5\n널 체크 추가');

    expect(result?.agentRef).toBe('claude@opus5');
    expect(result?.instruction).toBe('널 체크 추가');
  });

  it('--agent= 형태도 읽는다', () => {
    expect(parseTrigger('/fp --agent=codex@astro6\n고쳐줘')?.agentRef).toBe('codex@astro6');
  });

  it('alias 토큰과 플래그 조합을 읽는다', () => {
    const result = parseTrigger('/fix-pr --no-merge --dry-run --agent codex@astro6\n고쳐줘');

    expect(result).toEqual({
      agentRef: 'codex@astro6',
      instruction: '고쳐줘',
      noMerge: true,
      dryRun: true,
    });
  });

  it('트리거 줄에 남은 텍스트도 지시문에 포함한다', () => {
    const result = parseTrigger('/fp --agent claude@opus5 널 체크 추가\n그리고 테스트도');

    expect(result?.instruction).toBe('널 체크 추가\n그리고 테스트도');
  });

  it('앞쪽 빈 줄을 건너뛴다', () => {
    expect(parseTrigger('\n\n/fp\n고쳐줘')?.instruction).toBe('고쳐줘');
  });

  it('토큰이 단어 앞부분에만 걸치면 매치하지 않는다', () => {
    expect(parseTrigger('/fpx 고쳐줘')).toBeNull();
  });

  it('사용자 지정 토큰만 인식한다', () => {
    expect(parseTrigger('/fp 고쳐줘', ['/agent'])).toBeNull();
    expect(parseTrigger('/agent 고쳐줘', ['/agent'])?.instruction).toBe('고쳐줘');
  });

  it('지시문이 없으면 빈 문자열을 돌려준다', () => {
    expect(parseTrigger('/fp')?.instruction).toBe('');
  });
});

describe('summarizeInstruction', () => {
  it('첫 비어있지 않은 줄을 쓴다', () => {
    expect(summarizeInstruction('\n널 체크 추가\n그리고 테스트도')).toBe('널 체크 추가');
  });

  it('길면 잘라낸다', () => {
    expect(summarizeInstruction('a'.repeat(100))).toHaveLength(60);
  });

  it('빈 지시문은 기본 문구를 쓴다', () => {
    expect(summarizeInstruction('   ')).toBe('apply review comment');
  });
});
