'use client';
import { useEffect, useRef, useState } from 'react';
import { MessageCircle, Send, Sparkles, X, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  assistantContext,
  proposedRules,
  validateAssistantReply,
  type AssistantReply,
  type ChatMessage,
} from '@/lib/assistant';
import type { Dataset, Rules, Finding, Decision } from '@/lib/audit';

// Public endpoint contains no credentials. File processing remains in the browser.
export const ASSISTANT_URL =
  'https://clearview-assistant.ghostrunner737.workers.dev';
type Entry = ChatMessage & { reply?: AssistantReply; revision?: string };
export function AuditAssistant({
  data,
  rules,
  findings,
  decisions,
  selected,
  ran,
  disabled,
  onPlan,
  onFinding,
}: {
  data: Dataset;
  rules: Rules;
  findings: Finding[];
  decisions: Decision[];
  selected?: Finding;
  ran: boolean;
  disabled: boolean;
  onPlan: (rules: Rules) => void;
  onFinding: (id: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [messages, setMessages] = useState<Entry[]>([]),
    [question, setQuestion] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [sharedFinding, setSharedFinding] = useState('');
  const share = !!selected && sharedFinding === selected.id;
  const request = useRef<AbortController | null>(null),
    lock = useRef(false);
  const revision = JSON.stringify({
    rules,
    decisions: decisions.map((d) => d.id),
    findings: findings.map((f) => f.id),
    ran,
  });
  useEffect(() => () => request.current?.abort(), []);
  async function ask(text: string) {
    if (lock.current || !text.trim() || disabled) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setQuestion('');
    const history: Entry[] = [
      ...messages,
      { role: 'user', content: text.trim() },
    ];
    setMessages(history);
    const context = assistantContext(
      data,
      rules,
      findings,
      decisions,
      selected,
      ran,
      share,
    );
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(`${ASSISTANT_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context,
          messages: history
            .slice(-9)
            .map(({ role, content }) => ({
              role,
              content: content.slice(0, 2000),
            })),
        }),
        signal: controller.signal,
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(
          body &&
            typeof body === 'object' &&
            'error' in body &&
            typeof body.error === 'string'
            ? body.error
            : 'The assistant could not answer.',
        );
      const reply = validateAssistantReply(body, context);
      setMessages([
        ...history,
        { role: 'assistant', content: reply.answer, reply, revision },
      ]);
    } catch (e) {
      setError(
        controller.signal.aborted
          ? 'The answer took too long. Try a shorter question.'
          : e instanceof Error
            ? e.message
            : 'Please retry.',
      );
      setQuestion(text);
    } finally {
      clearTimeout(timeout);
      lock.current = false;
      setBusy(false);
      request.current = null;
    }
  }
  return (
    <section
      className={`audit-assistant ${open ? 'is-open' : ''}`}
      aria-label="Audit assistant"
    >
      <button
        className="assistant-toggle"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="audit-chat"
      >
        <span className="assistant-symbol">
          <Sparkles size={19} />
        </span>
        <span>
          <strong>Ask the assistant</strong>
          <small>
            Understand a finding, describe a goal, or plan your next step.
          </small>
        </span>
        {open ? <X size={18} /> : <MessageCircle size={20} />}
      </button>
      {open && (
        <div id="audit-chat" className="assistant-body">
          <div className="assistant-intro">
            <p>
              AI answers are suggestions. You stay in charge of every change.
            </p>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setMessages([]);
                setError('');
                setSharedFinding('');
              }}
            >
              <RotateCcw size={13} /> Clear chat
            </Button>
          </div>
          <div className="assistant-prompts">
            {(ran
              ? [
                  'Why was this item flagged?',
                  'How was the suggested correction calculated?',
                  'What should I review next?',
                ]
              : ['Help me choose an audit plan', 'Which checks can you run?']
            ).map((q) => (
              <Button
                key={q}
                size="sm"
                variant="outline"
                disabled={busy || disabled}
                onClick={() => void ask(q)}
              >
                {q}
              </Button>
            ))}
          </div>
          {!!selected && (
            <label className="assistant-share">
              <input
                type="checkbox"
                checked={share}
                onChange={(e) =>
                  setSharedFinding(e.target.checked ? selected.id : '')
                }
              />{' '}
              Include the evidence for row {selected.rowId}, {selected.column}{' '}
              (may contain original values).
            </label>
          )}
          <div
            className="assistant-messages"
            role="log"
            aria-live="polite"
            aria-label="Assistant conversation"
          >
            {messages.map((m, i) => (
              <article key={i} className={`chat-message ${m.role}`}>
                <b>{m.role === 'user' ? 'You' : 'Assistant · Llama 3.3'}</b>
                <p>{m.content}</p>
                {m.reply && m.revision !== revision && (
                  <small>
                    The audit has changed since this answer. Ask again for
                    current advice.
                  </small>
                )}
                {!!m.reply?.findingIds.length && (
                  <div className="assistant-prompts">
                    {m.reply.findingIds.map((id) => (
                      <Button
                        key={id}
                        variant="outline"
                        size="sm"
                        disabled={disabled || m.revision !== revision}
                        onClick={() => {
                          onFinding(id);
                          setOpen(false);
                        }}
                      >
                        Review row{' '}
                        {findings.find((f) => f.id === id)?.rowId ??
                          selected?.rowId}
                      </Button>
                    ))}
                  </div>
                )}
                {m.reply?.proposal && (
                  <div className="assistant-plan">
                    <strong>Suggested plan · awaiting your review</strong>
                    <p>
                      Required: {m.reply.proposal.required.join(', ') || 'none'}{' '}
                      · Numeric range: {m.reply.proposal.rangeColumn || 'none'}{' '}
                      {m.reply.proposal.rangeColumn
                        ? `(${m.reply.proposal.minimum ?? 'no minimum'} to ${m.reply.proposal.maximum ?? 'no maximum'})`
                        : ''}
                    </p>
                    <Button
                      size="sm"
                      disabled={disabled || m.revision !== revision}
                      onClick={() => {
                        try {
                          onPlan(
                            proposedRules(
                              rules,
                              m.reply!.proposal!,
                              data.headers,
                            ),
                          );
                        } catch (e) {
                          setError(
                            e instanceof Error ? e.message : 'Invalid plan.',
                          );
                        }
                      }}
                    >
                      Review proposed checks
                    </Button>
                  </div>
                )}
                {i === messages.length - 1 &&
                  m.reply &&
                  m.revision === revision && (
                    <ul className="assistant-questions">
                      {m.reply.questions.map((q) => (
                        <li key={q}>{q}</li>
                      ))}
                    </ul>
                  )}
              </article>
            ))}
            {busy && (
              <p className="assistant-thinking">Thinking through your audit…</p>
            )}
          </div>
          {error && (
            <p className="assistant-error" role="alert">
              {error}
            </p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void ask(question);
            }}
            className="assistant-compose"
          >
            <label htmlFor="audit-question">Your question or audit goal</label>
            <Textarea
              id="audit-question"
              value={question}
              maxLength={2000}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="e.g. Check employee emails, require employee_id, and flag ages below 18 or above 80."
            />
            <Button
              type="submit"
              disabled={!question.trim() || busy || disabled}
            >
              <Send size={15} />
              {busy ? 'Working…' : 'Ask assistant'}
            </Button>
          </form>
          <p className="assistant-privacy">
            Messages, column names and numeric summaries go to Cloudflare AI.
            Selected evidence is included only when you choose it. The full file
            stays in your browser. Chat clears when you change files or reload.
            Free daily AI limits apply.
          </p>
        </div>
      )}
    </section>
  );
}
