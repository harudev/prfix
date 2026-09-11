import type { DiffCommentPosition } from './diff.js';

/** provider@model 형태의 에이전트 참조를 해석한 결과. */
export interface AgentSpec {
  /** 정규화된 참조. 예: `claude@opus5` */
  id: string;
  provider: string;
  model: string;
}

/** 레지스트리 한 항목. 실행 커맨드까지 포함한다. */
export interface AgentDefinition extends AgentSpec {
  /** UI 드롭다운 표시용 이름. 없으면 id를 쓴다. */
  label?: string;
  command: string;
  /** `{{PROMPT}}` placeholder는 promptMode가 'arg'일 때 프롬프트로 치환된다. */
  args: string[];
  promptMode: 'arg' | 'stdin';
  env?: Record<string, string>;
}

export type AgentTaskStatus =
  | 'queued'
  | 'running'
  | 'committed'
  | 'merged'
  | 'no-change'
  | 'failed'
  | 'cancelled';

export interface AgentTaskLogEntry {
  timestamp: string;
  stream: 'system' | 'stdout' | 'stderr';
  text: string;
}

export interface AgentTask {
  id: string;
  threadId: string;
  filePath: string;
  position: DiffCommentPosition;
  /** 트리거 줄을 걷어낸 실제 지시문. */
  instruction: string;
  agent: AgentSpec;
  status: AgentTaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** fp/<head>/<threadId> */
  branch?: string;
  worktreePath?: string;
  commitSha?: string;
  changedFiles?: string[];
  error?: string;
  log: AgentTaskLogEntry[];
  /** 커밋까지만 하고 머지·푸시는 건너뛴다. */
  noMerge: boolean;
  /** 에이전트 대신 스텁을 실행한다. */
  dryRun: boolean;
}

/** 워크트리·PR 정보. 작업 실행에 필요한 저장소 컨텍스트. */
export interface PrContext {
  /** 리뷰 워크트리 경로 (PR head 브랜치가 체크아웃된 곳) */
  repoPath: string;
  /** PR head 브랜치명 */
  headBranch: string;
  /** head 브랜치를 push할 리모트 이름 */
  remote: string;
  prUrl: string;
}
