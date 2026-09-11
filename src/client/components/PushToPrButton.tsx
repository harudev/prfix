import { useCallback, useEffect, useState } from 'react';

import { useAgentTasksContext } from '../contexts/AgentTasksContext';

interface PushStatus {
  enabled: boolean;
  unpushed: number;
  headBranch?: string;
  remote?: string;
}

/**
 * 로컬 head 브랜치에 쌓인 커밋을 PR로 한 번에 올린다.
 *
 * 에이전트 작업은 로컬 머지까지만 하므로, 실제로 PR이 바뀌는 시점은 이 버튼을 누를 때다.
 */
export function PushToPrButton() {
  const agentTasks = useAgentTasksContext();
  const [status, setStatus] = useState<PushStatus>({ enabled: false, unpushed: 0 });
  const [isPushing, setIsPushing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void (async () => {
      try {
        const response = await fetch('/api/push-status');
        if (response.ok) {
          setStatus((await response.json()) as PushStatus);
        }
      } catch {
        // 상태 조회 실패는 버튼을 숨기는 것으로 충분하다.
      }
    })();
  }, []);

  // 작업이 끝날 때마다 ahead 수가 바뀐다.
  const taskSignature = agentTasks?.tasks.map((task) => task.status).join(',');
  useEffect(refresh, [refresh, taskSignature]);

  if (!status.enabled) {
    return null;
  }

  const handlePush = async () => {
    if (
      !window.confirm(
        `${status.unpushed}개 커밋을 ${status.remote}/${status.headBranch}에 push합니다. PR에 바로 반영됩니다.`,
      )
    ) {
      return;
    }

    setIsPushing(true);
    setError(null);
    try {
      const response = await fetch('/api/push', { method: 'POST' });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(data.error ?? 'push 실패');
      }
    } catch (pushError) {
      setError(pushError instanceof Error ? pushError.message : 'push 실패');
    } finally {
      setIsPushing(false);
      refresh();
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handlePush()}
      disabled={status.unpushed === 0 || isPushing}
      className="whitespace-nowrap rounded border border-github-border px-2 py-1 text-xs text-github-text-secondary transition-colors hover:text-github-text-primary disabled:opacity-50"
      title={
        error ??
        (status.unpushed === 0
          ? `${status.remote}/${status.headBranch}와 같습니다`
          : `${status.unpushed}개 커밋을 ${status.remote}/${status.headBranch}에 push`)
      }
    >
      {isPushing ? 'Pushing…' : `⬆ Push${status.unpushed > 0 ? ` (${status.unpushed})` : ''}`}
      {error && <span className="ml-1 text-red-400">!</span>}
    </button>
  );
}
