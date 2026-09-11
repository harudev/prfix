import { createContext, useContext, type ReactNode } from 'react';

import type { AgentTasksHook } from '../hooks/useAgentTasks';

const AgentTasksContext = createContext<AgentTasksHook | null>(null);

export function AgentTasksProvider({
  value,
  children,
}: {
  value: AgentTasksHook;
  children: ReactNode;
}) {
  return <AgentTasksContext.Provider value={value}>{children}</AgentTasksContext.Provider>;
}

/** Provider 밖(테스트 등)에서는 null을 돌려주고, 호출부는 에이전트 UI를 숨긴다. */
export function useAgentTasksContext(): AgentTasksHook | null {
  return useContext(AgentTasksContext);
}
