import React, { useRef, useState } from 'react';

import { useAgentTasksContext } from '../contexts/AgentTasksContext';

import { CommentBodyRenderer, hasSuggestionInBody } from './CommentBodyRenderer';
import type { AppearanceSettings } from './SettingsModal';
import { SuggestionTemplateButton } from './SuggestionTemplateButton';

interface CommentFormProps {
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
  selectedCode?: string;
  syntaxTheme?: AppearanceSettings['syntaxTheme'];
  filename?: string;
  initialValue?: string;
  embedded?: boolean;
  title?: string;
  submitLabel?: string;
  placeholder?: string;
}

type CommentFormMode = 'edit' | 'preview';

export function CommentForm({
  onSubmit,
  onCancel,
  selectedCode,
  syntaxTheme,
  filename,
  initialValue = '',
  embedded = false,
  title = 'Add a comment',
  submitLabel = 'Submit',
  placeholder = 'Leave a comment...',
}: CommentFormProps) {
  const [body, setBody] = useState(initialValue);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [mode, setMode] = useState<CommentFormMode>('edit');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hasSuggestion = hasSuggestionInBody(body);
  const effectiveMode: CommentFormMode = hasSuggestion ? mode : 'edit';

  const agentTasks = useAgentTasksContext();
  const agentInfo = agentTasks?.info;
  const canDispatchAgent = agentInfo?.enabled === true && agentInfo.agents.length > 0;
  const triggerToken = agentInfo?.triggerTokens[0] ?? '/fp';
  const [agentRef, setAgentRef] = useState('');
  const selectedAgent = agentRef || agentInfo?.defaultAgent || '';

  const submitBody = async (nextBody: string) => {
    setIsSubmitting(true);
    try {
      await onSubmit(nextBody);
      setBody('');
      setMode('edit');
    } catch (error) {
      console.error('Failed to submit comment:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!body.trim()) return;

    await submitBody(body.trim());
  };

  /** 트리거 줄을 앞에 붙여 제출한다. 서버가 그 코멘트를 보고 작업을 만든다. */
  const handleFixWithAgent = async () => {
    if (!body.trim()) return;

    const alreadyTriggered = (agentInfo?.triggerTokens ?? ['/fp']).some((token) =>
      body.trimStart().startsWith(token),
    );

    await submitBody(
      alreadyTriggered ? body.trim() : `${triggerToken} --agent ${selectedAgent}\n${body.trim()}`,
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      void handleSubmit(e);
    } else if (e.key === 'Escape') {
      onCancel();
    }
  };

  return (
    <form
      className={
        embedded
          ? 'bg-transparent'
          : 'm-2 mx-3 rounded-md border border-yellow-600/50 border-l-4 border-l-yellow-400 bg-github-bg-tertiary p-3'
      }
      onSubmit={handleSubmit}
      onClick={(e) => e.stopPropagation()}
      data-empty={!body.trim()}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium" style={{ color: 'var(--color-yellow-path-text)' }}>
          {title}
        </span>
        {hasSuggestion ? (
          <div className="flex items-center border border-github-border rounded-md overflow-hidden">
            <button
              type="button"
              onClick={() => setMode('edit')}
              className={`text-xs px-2.5 py-1.5 ${
                effectiveMode === 'edit'
                  ? 'bg-github-bg-tertiary text-github-text-primary'
                  : 'bg-github-bg-secondary text-github-text-secondary'
              } transition-colors`}
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => setMode('preview')}
              className={`text-xs px-2.5 py-1.5 border-l border-github-border ${
                effectiveMode === 'preview'
                  ? 'bg-github-bg-tertiary text-github-text-primary'
                  : 'bg-github-bg-secondary text-github-text-secondary'
              } transition-colors`}
            >
              Preview
            </button>
          </div>
        ) : (
          <SuggestionTemplateButton
            selectedCode={selectedCode}
            value={body}
            onChange={setBody}
            textareaRef={textareaRef}
          />
        )}
      </div>

      {hasSuggestion && effectiveMode === 'preview' ? (
        <div className="min-h-[60px] mb-2 bg-github-bg-secondary border border-github-border rounded px-3 py-2">
          <CommentBodyRenderer
            body={body}
            originalCode={selectedCode}
            filename={filename}
            syntaxTheme={syntaxTheme}
          />
        </div>
      ) : (
        <textarea
          ref={textareaRef}
          className="w-full min-h-[60px] mb-2 resize-y bg-github-bg-secondary border border-github-border rounded px-3 py-2 text-github-text-primary text-sm leading-6 focus:outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30 focus:min-h-[80px] disabled:opacity-50"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={Math.max(3, body.split('\n').length)}
          autoFocus
          disabled={isSubmitting}
        />
      )}

      <div className="flex gap-2 justify-end items-center flex-wrap">
        {canDispatchAgent && (
          <>
            <select
              className="text-xs px-2 py-1.5 bg-github-bg-secondary text-github-text-primary border border-github-border rounded focus:outline-none focus:border-blue-600 disabled:opacity-50 mr-auto"
              value={selectedAgent}
              onChange={(e) => setAgentRef(e.target.value)}
              disabled={isSubmitting}
              title="이 코멘트를 처리할 에이전트"
            >
              {agentInfo.agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.id}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void handleFixWithAgent()}
              className="text-xs px-3 py-1.5 bg-github-bg-tertiary text-github-text-primary border border-github-border rounded hover:opacity-80 transition-all disabled:opacity-50"
              disabled={!body.trim() || isSubmitting}
              title={`${triggerToken} 를 붙여 제출하고 에이전트가 수정하도록 합니다`}
            >
              🤖 Fix with agent
            </button>
          </>
        )}
        <button
          type="button"
          data-comment-cancel="true"
          onClick={onCancel}
          className="text-xs px-3 py-1.5 bg-github-bg-tertiary text-github-text-primary border border-github-border rounded hover:opacity-80 transition-all disabled:opacity-50"
          disabled={isSubmitting}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="text-xs px-3 py-1.5 rounded transition-all disabled:opacity-50"
          style={{
            backgroundColor: 'var(--color-yellow-btn-bg)',
            color: 'var(--color-yellow-btn-text)',
            border: '1px solid var(--color-yellow-btn-border)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--color-yellow-btn-hover-bg)';
            e.currentTarget.style.borderColor = 'var(--color-yellow-btn-hover-border)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--color-yellow-btn-bg)';
            e.currentTarget.style.borderColor = 'var(--color-yellow-btn-border)';
          }}
          disabled={!body.trim() || isSubmitting}
        >
          {isSubmitting ? 'Submitting...' : submitLabel}
        </button>
      </div>
    </form>
  );
}
