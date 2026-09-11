import { useState } from 'react';

import type { AgentTask, AgentTaskStatus } from '../../types/agent.js';

const STATUS_STYLE: Record<AgentTaskStatus, { label: string; className: string }> = {
  queued: { label: '대기', className: 'border-github-text-muted text-github-text-muted' },
  running: { label: '실행 중', className: 'border-blue-500 text-blue-400' },
  committed: { label: '커밋됨', className: 'border-amber-500 text-amber-400' },
  merged: { label: '머지됨', className: 'border-green-600 text-green-400' },
  'no-change': { label: '변경 없음', className: 'border-github-text-muted text-github-text-muted' },
  failed: { label: '실패', className: 'border-red-600 text-red-400' },
  cancelled: { label: '취소됨', className: 'border-github-text-muted text-github-text-muted' },
};

interface AgentTaskBadgeProps {
  task: AgentTask;
  onCancel?: (taskId: string) => void;
}

/** 스레드 헤더에 붙는 작업 상태 배지. 클릭하면 에이전트 로그를 편다. */
export function AgentTaskBadge({ task, onCancel }: AgentTaskBadgeProps) {
  const [isLogOpen, setIsLogOpen] = useState(false);
  const style = STATUS_STYLE[task.status];
  const isActive = task.status === 'queued' || task.status === 'running';

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setIsLogOpen((prev) => !prev);
        }}
        className={`inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-[10px] font-medium ${style.className}`}
        title={`${task.agent.id} · ${task.log.length} log lines`}
      >
        🤖 {style.label}
        {task.commitSha && <span className="font-mono">{task.commitSha.slice(0, 7)}</span>}
      </button>
      {isActive && onCancel && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onCancel(task.id);
          }}
          className="inline-flex h-5 shrink-0 items-center rounded-full border border-github-border px-2 text-[10px] text-github-text-secondary hover:text-github-text-primary"
        >
          중단
        </button>
      )}
      {isLogOpen && (
        <pre
          className="mt-2 max-h-60 w-full overflow-auto rounded border border-github-border bg-github-bg-secondary p-2 text-[11px] leading-5 text-github-text-secondary whitespace-pre-wrap"
          onClick={(e) => e.stopPropagation()}
        >
          {task.log.length > 0
            ? task.log.map((entry) => entry.text).join('\n')
            : '아직 출력이 없습니다.'}
        </pre>
      )}
    </>
  );
}
