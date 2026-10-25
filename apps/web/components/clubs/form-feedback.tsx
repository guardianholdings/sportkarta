'use client';

import type { ClubFormMessages } from '@/lib/clubs/form-labels';

/**
 * The one status region of a club form: every problem at once, as a list,
 * above the inputs the person typed (useFormAction keeps them), or the saved
 * line. `role="status"` so a screen reader hears the outcome.
 */
export function FormFeedback({
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
        ? state.errors.map((code) => messages.errors[code] ?? messages.genericError)
        : [messages.errors[state.error] ?? messages.genericError];
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
