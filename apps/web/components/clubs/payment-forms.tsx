'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type { ClubFormMessages } from '@/lib/clubs/form-labels';
import { useFormAction } from '@/lib/use-form-action';

import { FormFeedback } from './form-feedback';

export interface PaymentState {
  error: string | null;
  errors?: string[];
  saved?: boolean;
}

type Action = (prev: PaymentState, formData: FormData) => Promise<PaymentState>;

const INITIAL: PaymentState = { error: null };
const label = 'block text-body-sm font-semibold text-ink';

export interface PaymentFormLabels {
  charge: string;
  chargePick: string;
  kind: string;
  payment: string;
  refund: string;
  method: string;
  methods: Record<string, string>;
  amount: string;
  receivedOn: string;
  submit: string;
}

/**
 * Record money against an open charge. The amount defaults to what is still
 * due; less is a partial payment; more is refused by the database
 * (club_payments_within_charge) and comes back as a form error.
 */
export function PaymentForm({
  action,
  slug,
  labels,
  messages,
  charges,
  today,
  defaultChargeId,
}: {
  action: Action;
  slug: string;
  labels: PaymentFormLabels;
  messages: ClubFormMessages;
  charges: { id: string; label: string; due: string }[];
  today: string;
  defaultChargeId: string | null;
}) {
  const [state, formProps, pending] = useFormAction(action, INITIAL, {
    resetWhen: (s) => s.saved === true,
  });
  const [chargeId, setChargeId] = useState(defaultChargeId ?? '');
  const due = charges.find((c) => c.id === chargeId)?.due ?? '';
  return (
    <form {...formProps} className="space-y-3">
      <input type="hidden" name="slug" value={slug} />
      <FormFeedback state={state} messages={messages} />
      <div className="space-y-1">
        <label className={label} htmlFor="pay-charge">
          {labels.charge}
        </label>
        <Select
          id="pay-charge"
          name="chargeId"
          required
          value={chargeId}
          onChange={(event) => setChargeId(event.currentTarget.value)}
        >
          <option value="">{labels.chargePick}</option>
          {charges.map((charge) => (
            <option key={charge.id} value={charge.id}>
              {charge.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="space-y-1">
          <label className={label} htmlFor="pay-kind">
            {labels.kind}
          </label>
          <Select id="pay-kind" name="kind" defaultValue="payment">
            <option value="payment">{labels.payment}</option>
            <option value="refund">{labels.refund}</option>
          </Select>
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="pay-method">
            {labels.method}
          </label>
          <Select id="pay-method" name="method" defaultValue="cash">
            {Object.entries(labels.methods).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="pay-amount">
            {labels.amount}
          </label>
          <Input
            id="pay-amount"
            name="amount"
            inputMode="decimal"
            required
            key={chargeId}
            defaultValue={due}
          />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="pay-date">
            {labels.receivedOn}
          </label>
          <Input id="pay-date" name="receivedOn" type="date" max={today} defaultValue={today} />
        </div>
      </div>
      <Button type="submit" disabled={pending || !chargeId}>
        {labels.submit}
      </Button>
    </form>
  );
}

export interface ChargeFormLabels {
  member: string;
  memberPick: string;
  label: string;
  amount: string;
  due: string;
  submit: string;
}

/** A one-off charge (a drop-in, a product, a fee) owed by a member. */
export function ChargeForm({
  action,
  slug,
  labels,
  messages,
  members,
  today,
  defaultMemberId,
}: {
  action: Action;
  slug: string;
  labels: ChargeFormLabels;
  messages: ClubFormMessages;
  members: { id: string; label: string }[];
  today: string;
  defaultMemberId: string | null;
}) {
  const [state, formProps, pending] = useFormAction(action, INITIAL, {
    resetWhen: (s) => s.saved === true,
  });
  return (
    <form {...formProps} className="space-y-3">
      <input type="hidden" name="slug" value={slug} />
      <FormFeedback state={state} messages={messages} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className={label} htmlFor="ch-member">
            {labels.member}
          </label>
          <Select id="ch-member" name="memberId" required defaultValue={defaultMemberId ?? ''}>
            <option value="">{labels.memberPick}</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="ch-label">
            {labels.label}
          </label>
          <Input id="ch-label" name="label" required maxLength={120} />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="ch-amount">
            {labels.amount}
          </label>
          <Input id="ch-amount" name="amount" inputMode="decimal" required />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="ch-due">
            {labels.due}
          </label>
          <Input id="ch-due" name="dueOn" type="date" min={today} defaultValue={today} />
        </div>
      </div>
      <Button type="submit" variant="secondary" disabled={pending}>
        {labels.submit}
      </Button>
    </form>
  );
}
