import { useState } from 'react';

import { useAgentTasksContext } from '../contexts/AgentTasksContext';

import { AgentTaskBadge } from './AgentTaskBadge';

/** 헤더의 /fp 작업 큐 요약. 진행 중인 작업이 있을 때만 눈에 띄게 보인다. */
export function AgentTaskPanel() {
  const agentTasks = useAgentTasksContext();
  const [isOpen, setIsOpen] = useState(false);

  if (!agentTasks?.info.enabled || agentTasks.tasks.length === 0) {
    return null;
  }

  const { tasks, cancel, info } = agentTasks;
  const activeCount = tasks.filter(
    (task) => task.status === 'queued' || task.status === 'running',
  ).length;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="whitespace-nowrap rounded border border-github-border px-2 py-1 text-xs text-github-text-secondary hover:text-github-text-primary"
        title={info.headBranch ? `head: ${info.headBranch}` : undefined}
      >
        🤖 {activeCount > 0 ? `${activeCount} running` : `${tasks.length} tasks`}
      </button>

      {isOpen && (
        <div className="absolute right-0 z-50 mt-1 w-96 max-h-96 overflow-auto rounded border border-github-border bg-github-bg-secondary p-2 shadow-lg">
          {tasks
            .slice()
            .reverse()
            .map((task) => (
              <div
                key={task.id}
                className="flex flex-wrap items-center gap-2 border-b border-github-border py-2 last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate text-xs text-github-text-secondary">
                  {task.filePath}
                </span>
                <AgentTaskBadge task={task} onCancel={(taskId) => void cancel(taskId)} />
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
