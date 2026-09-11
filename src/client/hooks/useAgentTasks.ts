import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AgentSpec, AgentTask } from '../../types/agent.js';

interface AgentsInfo {
  enabled: boolean;
  defaultAgent: string;
  triggerTokens: string[];
  autoMerge: boolean;
  agents: AgentSpec[];
  headBranch?: string;
  worktreePath?: string;
}

const DISABLED_INFO: AgentsInfo = {
  enabled: false,
  defaultAgent: '',
  triggerTokens: [],
  autoMerge: true,
  agents: [],
};

export interface AgentTasksHook {
  info: AgentsInfo;
  tasks: AgentTask[];
  /** 스레드 id로 가장 최근 작업을 찾는다. */
  taskByThread: (threadId: string) => AgentTask | undefined;
  refresh: () => void;
  requestFix: (input: {
    threadId: string;
    agentRef?: string;
    instruction?: string;
  }) => Promise<AgentTask | null>;
  cancel: (taskId: string) => Promise<void>;
}

/** /fp 작업 상태를 서버에서 읽어 UI에 공급한다. 갱신은 SSE(agentTaskChanged)로 트리거된다. */
export function useAgentTasks(): AgentTasksHook {
  const [info, setInfo] = useState<AgentsInfo>(DISABLED_INFO);
  const [tasks, setTasks] = useState<AgentTask[]>([]);

  const refresh = useCallback(() => {
    void (async () => {
      try {
        const response = await fetch('/api/agent-tasks');
        if (!response.ok) {
          return;
        }
        const data = (await response.json()) as { tasks?: AgentTask[] };
        setTasks(data.tasks ?? []);
      } catch (error) {
        console.error('Failed to load agent tasks:', error);
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/agents');
        if (!response.ok) {
          return;
        }
        setInfo((await response.json()) as AgentsInfo);
      } catch (error) {
        console.error('Failed to load agent settings:', error);
      }
    })();
    refresh();
  }, [refresh]);

  const latestByThread = useMemo(() => {
    const map = new Map<string, AgentTask>();
    for (const task of tasks) {
      map.set(task.threadId, task);
    }
    return map;
  }, [tasks]);

  const requestFix = useCallback<AgentTasksHook['requestFix']>(
    async (input) => {
      try {
        const response = await fetch('/api/agent-tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        const data = (await response.json()) as { task?: AgentTask; error?: string };

        if (!response.ok) {
          console.error('Failed to start agent task:', data.error);
          return null;
        }

        refresh();
        return data.task ?? null;
      } catch (error) {
        console.error('Failed to start agent task:', error);
        return null;
      }
    },
    [refresh],
  );

  const cancel = useCallback(
    async (taskId: string) => {
      try {
        await fetch(`/api/agent-tasks/${taskId}/cancel`, { method: 'POST' });
      } catch (error) {
        console.error('Failed to cancel agent task:', error);
      } finally {
        refresh();
      }
    },
    [refresh],
  );

  return {
    info,
    tasks,
    taskByThread: (threadId) => latestByThread.get(threadId),
    refresh,
    requestFix,
    cancel,
  };
}
