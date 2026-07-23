'use client';

import { useState } from 'react';

/**
 * Closing a campaign is the one irreversible action in this screen, so it asks
 * the admin to type a word — the same guard account deletion uses.
 *
 * Everything else here is editable afterwards. Closing writes the frozen
 * snapshot the public results page will publish, and a second close is refused
 * rather than allowed to renumber the winners, so a stray click at the wrong
 * moment publishes standings the campaign had not finished collecting.
 *
 * The expected word is passed in from the server's message catalogue and
 * compared here only to enable the button; the action re-checks the role
 * server-side, which is what actually protects it.
 */
export function CloseCampaignForm({
  id,
  action,
  confirmationWord,
  label,
  confirmLabel,
  warning,
}: {
  id: string;
  action: (formData: FormData) => Promise<void>;
  confirmationWord: string;
  label: string;
  confirmLabel: string;
  warning: string;
}) {
  const [typed, setTyped] = useState('');
  const armed = typed.trim().toUpperCase() === confirmationWord.toUpperCase();

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <p className="max-w-md text-xs text-neutral-600">{warning}</p>
      <label className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-neutral-600">{confirmLabel}</span>
        <input
          type="text"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          className="w-32 rounded border border-neutral-300 px-2 py-1 text-sm"
        />
      </label>
      <button
        type="submit"
        disabled={!armed}
        className="rounded bg-red-700 px-3 py-1.5 text-sm text-white disabled:opacity-40"
      >
        {label}
      </button>
    </form>
  );
}
