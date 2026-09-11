/**
 * PR 링크에 담긴 비교 범위를 읽는다.
 *
 * GitHub의 "Changes from" 드롭다운과 커밋 목록은 URL에 범위를 남긴다. 그 범위를 그대로
 * 로컬 diff 리비전으로 옮기면, 웹에서 보던 화면을 로컬에서 똑같이 열 수 있다.
 */
export interface PrRange {
  /** 비교 기준. 없으면 PR base와의 merge-base를 쓴다. */
  base?: string;
  /** 비교 대상. 없으면 PR head tip을 쓴다. */
  target?: string;
  /** 사람이 읽을 범위 설명. 기동 로그에 쓴다. */
  label: string;
}

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

/**
 * 지원하는 형태:
 *
 * - `/pull/N`, `/pull/N/files` — PR 전체 (범위 없음)
 * - `/pull/N/files/<sha>` — `<sha>` 이후의 변경 (GitHub "Changes since ...")
 * - `/pull/N/files/<a>..<b>` — 두 커밋 사이
 * - `/pull/N/commits/<sha>` — 그 커밋 하나
 */
export function parsePrRange(url: string): PrRange | null {
  let pathParts: string[];
  try {
    pathParts = new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    return null;
  }

  // [owner, repo, 'pull', number, section?, rest?]
  const section = pathParts[4];
  const rest = pathParts[5];

  if (section === 'commits' && rest && SHA_PATTERN.test(rest)) {
    return { base: `${rest}^`, target: rest, label: `commit ${short(rest)}` };
  }

  if (section !== 'files' || !rest) {
    return null;
  }

  const [left, right] = rest.split('..');

  if (right !== undefined) {
    if (!SHA_PATTERN.test(left) || !SHA_PATTERN.test(right)) {
      return null;
    }
    return { base: left, target: right, label: `${short(left)}..${short(right)}` };
  }

  if (!SHA_PATTERN.test(left)) {
    return null;
  }

  return { base: left, label: `changes since ${short(left)}` };
}

function short(sha: string): string {
  return sha.slice(0, 8);
}
