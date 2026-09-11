import { randomUUID } from 'crypto';

import type { AgentTask, AgentTaskLogEntry, AgentTaskStatus, PrContext } from '../types/agent.js';
import type { DiffCommentPosition } from '../types/diff.js';

import type { AgentRegistry } from './agent-registry.js';
import { runFixPipeline } from './fix-pipeline.js';

const MAX_LOG_ENTRIES = 500;

export interface EnqueueInput {
  threadId: string;
  filePath: string;
  position: DiffCommentPosition;
  instruction: string;
  agentRef?: string;
  noMerge?: boolean;
  dryRun?: boolean;
}

export interface AgentRunnerOptions {
  registry: AgentRegistry;
  /** 워크트리가 준비되지 않았으면 undefined. 이 경우 작업을 받지 않는다. */
  context?: PrContext;
  defaultAgentRef: string;
  dryRun?: boolean;
  postFixCommands?: string[];
  autoPush?: boolean;
  onTaskUpdate(task: AgentTask): void;
}

export class AgentRunnerError extends Error {}

/**
 * /fp 작업 큐.
 *
 * 모든 작업이 같은 head 브랜치에 머지·push하므로 **직렬**로 실행한다. 병렬로 돌리면
 * 머지 충돌과 push race가 난다.
 */
export class AgentRunner {
  private readonly tasks = new Map<string, AgentTask>();
  private readonly queue: string[] = [];
  private readonly killers = new Map<string, () => void>();
  private draining = false;

  constructor(private readonly options: AgentRunnerOptions) {}

  get enabled(): boolean {
    return this.options.context !== undefined;
  }

  list(): AgentTask[] {
    return [...this.tasks.values()].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }

  get(taskId: string): AgentTask | undefined {
    return this.tasks.get(taskId);
  }

  /** 같은 스레드에 이미 진행 중인 작업이 있으면 그 작업을 돌려준다. */
  findActiveByThread(threadId: string): AgentTask | undefined {
    return this.list().find(
      (task) =>
        task.threadId === threadId && (task.status === 'queued' || task.status === 'running'),
    );
  }

  enqueue(input: EnqueueInput): AgentTask {
    if (!this.options.context) {
      throw new AgentRunnerError(
        'PR 워크트리가 준비되지 않아 에이전트 수정을 실행할 수 없습니다. --pr 로 실행했는지 확인하세요.',
      );
    }

    if (input.instruction.trim().length === 0) {
      throw new AgentRunnerError('지시문이 비어 있습니다. 트리거 줄 다음에 내용을 적어주세요.');
    }

    const agentRef = input.agentRef ?? this.options.defaultAgentRef;
    const definition = this.options.registry.resolve(agentRef);
    if (!definition) {
      throw new AgentRunnerError(`알 수 없는 에이전트입니다: ${agentRef}`);
    }

    const task: AgentTask = {
      id: randomUUID().slice(0, 8),
      threadId: input.threadId,
      filePath: input.filePath,
      position: input.position,
      instruction: input.instruction.trim(),
      agent: { id: definition.id, provider: definition.provider, model: definition.model },
      status: 'queued',
      createdAt: new Date().toISOString(),
      log: [],
      noMerge: input.noMerge ?? false,
      dryRun: input.dryRun ?? this.options.dryRun ?? false,
    };

    this.tasks.set(task.id, task);
    this.queue.push(task.id);
    this.options.onTaskUpdate(task);
    void this.drain();

    return task;
  }

  cancel(taskId: string): AgentTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) {
      return undefined;
    }

    if (task.status === 'queued') {
      const index = this.queue.indexOf(taskId);
      if (index !== -1) {
        this.queue.splice(index, 1);
      }
      this.finish(task, 'cancelled');
      return task;
    }

    if (task.status === 'running') {
      this.killers.get(taskId)?.();
      this.appendLog(task, 'system', '취소 요청으로 에이전트를 종료했습니다.');
      return task;
    }

    return task;
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;

    try {
      while (this.queue.length > 0) {
        const taskId = this.queue.shift();
        const task = taskId ? this.tasks.get(taskId) : undefined;
        if (!task || task.status !== 'queued') {
          continue;
        }
        await this.execute(task);
      }
    } finally {
      this.draining = false;
    }
  }

  private async execute(task: AgentTask): Promise<void> {
    const context = this.options.context;
    if (!context) {
      this.fail(task, 'PR 워크트리가 없습니다.');
      return;
    }

    const definition = this.options.registry.resolve(task.agent.id);
    if (!definition) {
      this.fail(task, `알 수 없는 에이전트입니다: ${task.agent.id}`);
      return;
    }

    task.status = 'running';
    task.startedAt = new Date().toISOString();
    this.options.onTaskUpdate(task);

    try {
      const result = await runFixPipeline(
        task,
        definition,
        context,
        {
          log: (stream, text) => this.appendLog(task, stream, text),
          registerProcess: (kill) => this.killers.set(task.id, kill),
        },
        { postFixCommands: this.options.postFixCommands, autoPush: this.options.autoPush },
      );

      task.branch = result.branch;
      task.worktreePath = result.worktreePath;
      task.commitSha = result.commitSha;
      task.changedFiles = result.changedFiles;
      this.finish(task, result.status);
    } catch (error) {
      this.fail(task, error instanceof Error ? error.message : 'Unknown error');
    } finally {
      this.killers.delete(task.id);
    }
  }

  private appendLog(task: AgentTask, stream: AgentTaskLogEntry['stream'], text: string): void {
    const trimmed = text.replace(/\s+$/, '');
    if (trimmed.length === 0) {
      return;
    }

    task.log.push({ timestamp: new Date().toISOString(), stream, text: trimmed });
    if (task.log.length > MAX_LOG_ENTRIES) {
      task.log.splice(0, task.log.length - MAX_LOG_ENTRIES);
    }
    this.options.onTaskUpdate(task);
  }

  private finish(task: AgentTask, status: AgentTaskStatus): void {
    task.status = status;
    task.finishedAt = new Date().toISOString();
    this.options.onTaskUpdate(task);
  }

  private fail(task: AgentTask, message: string): void {
    task.error = message;
    this.appendLog(task, 'system', `실패: ${message}`);
    this.finish(task, 'failed');
  }
}
