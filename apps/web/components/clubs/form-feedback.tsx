'use client';

import { useEffect, useRef } from 'react';

import type { ClubFormMessages } from '@/lib/clubs/form-labels';
import { formErrorText } from '@/lib/clubs/form-error';

/**
 * The one status region of a club form: every problem at once, as a list,
 * above the inputs the person typed (useFormAction keeps them), or the saved
 * line. `role="status"` so a screen reader hears the outcome.
 *
 * It sits at the TOP of the form and the button at the bottom: on a long form
 * (a sale, a class) the answer landed above the screen, and to the person who
 * pressed «Продай» nothing had happened — so they pressed again. Every new
 * answer is therefore brought into view (`nearest`: no movement when it is
 * already visible). `state` is a new object for each answer the action gives,
 * so the same refusal twice scrolls twice.
 */
export function FormFeedback({
  state,
  messages,
}: {
  state: { error: string | null; errors?: string[]; saved?: boolean };
  messages: ClubFormMessages;
}) {
  const region = useRef<HTMLDivElement>(null);
  const answered = Boolean(state.error) || state.saved === true;
  useEffect(() => {
    if (answered) region.current?.scrollIntoView({ block: 'nearest' });
  }, [state, answered]);

  return (
    <div ref={region} className="scroll-mt-4">
      <Outcome state={state} messages={messages} />
    </div>
  );
}

function Outcome({
  state,
  messages,
}: {
  state: { error: string | null; errors?: string[]; saved?: boolean };
  messages: ClubFormMessages;
}) {
  if (state.saved && !state.error) {
    return (
      <p
        role="status"
        className="rounded-card border border-success-border bg-success-bg p-3 text-body-sm text-ink"
      >
        {messages.saved}
      </p>
    );
  }
  if (!state.error) return <p role="status" className="sr-only" />;
  const lines =
    state.error === 'readOnly'
      ? [messages.readOnly]
      : state.errors && state.errors.length > 0
        ? state.errors.map((code) => formErrorText(messages, code))
        : [formErrorText(messages, state.error)];
  return (
    <div
      role="status"
      className="rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink"
    >
      <ul className="list-disc space-y-0.5 pl-5">
        {[...new Set(lines)].map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
