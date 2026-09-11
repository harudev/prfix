import { describe, expect, it } from 'vitest';

import { parsePrRange } from './pr-range.js';

const BASE = 'https://github.com/owner/repo/pull/123';
const SHA_A = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const SHA_B = '0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a';

describe('parsePrRange', () => {
  it('범위가 없으면 null', () => {
    expect(parsePrRange(BASE)).toBeNull();
    expect(parsePrRange(`${BASE}/files`)).toBeNull();
    expect(parsePrRange(`${BASE}/commits`)).toBeNull();
  });

  it('단일 커밋 링크는 그 커밋 이후의 변경', () => {
    expect(parsePrRange(`${BASE}/files/${SHA_A}`)).toEqual({
      base: SHA_A,
      label: `changes since ${SHA_A.slice(0, 8)}`,
    });
  });

  it('범위 링크는 두 커밋 사이', () => {
    expect(parsePrRange(`${BASE}/files/${SHA_A}..${SHA_B}`)).toEqual({
      base: SHA_A,
      target: SHA_B,
      label: `${SHA_A.slice(0, 8)}..${SHA_B.slice(0, 8)}`,
    });
  });

  it('commits 링크는 그 커밋 하나', () => {
    expect(parsePrRange(`${BASE}/commits/${SHA_A}`)).toEqual({
      base: `${SHA_A}^`,
      target: SHA_A,
      label: `commit ${SHA_A.slice(0, 8)}`,
    });
  });

  it('짧은 SHA도 받는다', () => {
    expect(parsePrRange(`${BASE}/files/a1b2c3d`)?.base).toBe('a1b2c3d');
  });

  it('SHA가 아니면 무시한다', () => {
    expect(parsePrRange(`${BASE}/files/not-a-sha`)).toBeNull();
    expect(parsePrRange(`${BASE}/files/${SHA_A}..nope`)).toBeNull();
  });

  it('URL이 아니면 null', () => {
    expect(parsePrRange('nonsense')).toBeNull();
  });

  it('앵커나 쿼리가 붙어도 읽는다', () => {
    expect(parsePrRange(`${BASE}/files/${SHA_A}?w=1#diff-abc`)?.base).toBe(SHA_A);
  });
});
