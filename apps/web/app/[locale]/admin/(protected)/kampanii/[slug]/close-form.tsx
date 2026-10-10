'use client';

import { useState } from 'react';

import { buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

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
      <p className="max-w-md text-caption text-ink-soft">{warning}</p>
      <label className="flex flex-wrap items-center gap-2">
        <span className="text-caption text-ink-soft">{confirmLabel}</span>
        <Input
          type="text"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoComplete="off"
          className="w-40"
        />
      </label>
      {/* buttonVariants, not a hand-rolled class: a bare `shadow-xs` sits in
          the utilities layer and discarded the global focus ring, so the
          keyboard focus on the one irreversible button was invisible (D-5). */}
      <button type="submit" disabled={!armed} className={buttonVariants({ variant: 'danger' })}>
        {label}
      </button>
    </form>
  );
}
