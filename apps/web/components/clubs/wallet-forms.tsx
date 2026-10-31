'use client';

import type { FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type { ClubFormMessages } from '@/lib/clubs/form-labels';
import { useFormAction } from '@/lib/use-form-action';

import { FormFeedback } from './form-feedback';

/**
 * Credit in and out at the desk (0050). Money forms: each disables itself
 * while it is being sent, and carries a token minted when the card was shown
 * (`nonces`), which the server records with what it did — so a double click
 * or a resubmitted page loads or pays back once.
 */

export interface WalletState {
  error: string | null;
  errors?: string[];
}

const INITIAL: WalletState = { error: null };

export interface WalletLabels {
  topUp: string;
  payOut: string;
  method: string;
  methods: Record<string, string>;
  topUpSubmit: string;
  payOutSubmit: string;
  payOutConfirm: string;
}

function WalletForm({
  action,
  op,
  slug,
  memberId,
  nonce,
  labels,
  messages,
}: {
  action: (state: WalletState, payload: FormData) => Promise<WalletState>;
  op: 'wallet_top_up' | 'wallet_pay_out';
  slug: string;
  memberId: string;
  nonce: string;
  labels: WalletLabels;
  messages: ClubFormMessages;
}) {
  const [state, formProps, pending] = useFormAction(action, INITIAL);
  const topUp = op === 'wallet_top_up';
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    // Paying money back is confirmed first; loading it is not.
    if (!topUp && !window.confirm(labels.payOutConfirm)) {
      event.preventDefault();
      return;
    }
    formProps.onSubmit(event);
  };
  return (
    <form {...formProps} onSubmit={onSubmit} className="space-y-2">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="memberId" value={memberId} />
      <input type="hidden" name="op" value={op} />
      <input type="hidden" name="nonce" value={nonce} />
      <FormFeedback state={state} messages={messages} />
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-caption text-ink-soft">
          {topUp ? labels.topUp : labels.payOut}
          <Input name="amount" inputMode="decimal" required size="sm" className="mt-1 w-28" />
        </label>
        <label className="text-caption text-ink-soft">
          {labels.method}
          <Select name="method" size="sm" className="mt-1" defaultValue="cash">
            {Object.entries(labels.methods).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </Select>
        </label>
        <Button
          type="submit"
          size="sm"
          variant={topUp ? 'primary' : 'secondary'}
          disabled={pending}
        >
          {topUp ? labels.topUpSubmit : labels.payOutSubmit}
        </Button>
      </div>
    </form>
  );
}

export function WalletForms({
  action,
  slug,
  memberId,
  nonces,
  canTopUp,
  canPayOut,
  labels,
  messages,
}: {
  action: (state: WalletState, payload: FormData) => Promise<WalletState>;
  slug: string;
  memberId: string;
  nonces: { topUp: string; payOut: string };
  canTopUp: boolean;
  canPayOut: boolean;
  labels: WalletLabels;
  messages: ClubFormMessages;
}) {
  return (
    <div className="flex flex-wrap gap-4">
      {canTopUp && (
        <WalletForm
          action={action}
          op="wallet_top_up"
          slug={slug}
          memberId={memberId}
          nonce={nonces.topUp}
          labels={labels}
          messages={messages}
        />
      )}
      {canPayOut && (
        <WalletForm
          action={action}
          op="wallet_pay_out"
          slug={slug}
          memberId={memberId}
          nonce={nonces.payOut}
          labels={labels}
          messages={messages}
        />
      )}
    </div>
  );
}
