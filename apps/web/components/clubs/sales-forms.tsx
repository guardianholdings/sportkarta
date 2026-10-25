'use client';

import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { ClubFormMessages } from '@/lib/clubs/form-labels';
import { useFormAction } from '@/lib/use-form-action';

import { FormFeedback } from './form-feedback';

export interface SalesState {
  error: string | null;
  errors?: string[];
  saved?: boolean;
}

type Action = (prev: SalesState, formData: FormData) => Promise<SalesState>;

const INITIAL: SalesState = { error: null };
const label = 'block text-body-sm font-semibold text-ink';

export interface PlanFormLabels {
  nameBg: string;
  nameEn: string;
  descriptionBg: string;
  descriptionEn: string;
  kind: string;
  kinds: Record<string, string>;
  audience: string;
  audiences: Record<string, string>;
  price: string;
  priceHint: string;
  validity: string;
  validityAmount: string;
  days: string;
  months: string;
  visitsCount: string;
  visibility: string;
  public: string;
  privatePlan: string;
  terms: string;
  termsHint: string;
  autoRenew: string;
  autoRenewHint: string;
  minTermMonths: string;
  noticeDays: string;
  selfPause: string;
  selfCancel: string;
  save: string;
}

export interface PlanValues {
  id: string;
  nameBg: string;
  nameEn: string | null;
  descriptionBg: string | null;
  descriptionEn: string | null;
  kind: string;
  audience: string;
  price: string;
  validityDays: number | null;
  validityMonths: number | null;
  visitsCount: number | null;
  visibility: string;
  autoRenew: boolean;
  minTermMonths: number | null;
  noticeDays: number;
  selfPauseAllowed: boolean;
  selfCancelAllowed: boolean;
}

/** The kind radio drives the fields: a visit card asks for visits. */
export function PlanForm({
  action,
  slug,
  labels,
  messages,
  plan,
}: {
  action: Action;
  slug: string;
  labels: PlanFormLabels;
  messages: ClubFormMessages;
  plan?: PlanValues;
}) {
  const [state, formProps, pending] = useFormAction(action, INITIAL);
  const [kind, setKind] = useState(plan?.kind ?? 'unlimited');
  const [autoRenew, setAutoRenew] = useState(plan?.autoRenew ?? false);
  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="slug" value={slug} />
      {plan && <input type="hidden" name="planId" value={plan.id} />}
      <FormFeedback state={state} messages={messages} />
      <fieldset className="space-y-2">
        <legend className={label}>{labels.kind}</legend>
        <div className="flex flex-wrap gap-2">
          {Object.entries(labels.kinds).map(([value, text]) => (
            <label
              key={value}
              className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-pill border px-4 text-body-sm ${
                kind === value
                  ? 'border-brand bg-brand-subtle text-ink'
                  : 'border-line-strong text-ink-soft'
              }`}
            >
              <input
                type="radio"
                name="kind"
                value={value}
                checked={kind === value}
                onChange={() => setKind(value)}
                className="size-4 accent-[var(--brand)]"
              />
              {text}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label className={label} htmlFor="p-name-bg">
            {labels.nameBg}
          </label>
          <Input id="p-name-bg" name="nameBg" required maxLength={80} defaultValue={plan?.nameBg} />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="p-name-en">
            {labels.nameEn}
          </label>
          <Input id="p-name-en" name="nameEn" maxLength={80} defaultValue={plan?.nameEn ?? ''} />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1">
          <label className={label} htmlFor="p-price">
            {labels.price}
          </label>
          <Input
            id="p-price"
            name="price"
            inputMode="decimal"
            required
            defaultValue={plan?.price ?? ''}
            aria-describedby="p-price-hint"
          />
          <p id="p-price-hint" className="text-caption text-text-muted">
            {labels.priceHint}
          </p>
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="p-validity">
            {labels.validity}
          </label>
          <div className="flex gap-2">
            <Input
              id="p-validity"
              name="validityAmount"
              type="number"
              min={1}
              max={366}
              required
              aria-label={labels.validityAmount}
              defaultValue={plan?.validityMonths ?? plan?.validityDays ?? 1}
              className="w-24"
            />
            <Select
              name="validityUnit"
              defaultValue={plan?.validityDays ? 'days' : 'months'}
              aria-label={labels.validity}
            >
              <option value="months">{labels.months}</option>
              <option value="days">{labels.days}</option>
            </Select>
          </div>
        </div>
        {kind !== 'unlimited' && (
          <div className="space-y-1">
            <label className={label} htmlFor="p-visits">
              {labels.visitsCount}
            </label>
            <Input
              id="p-visits"
              name="visitsCount"
              type="number"
              min={1}
              max={500}
              required={kind === 'visits'}
              defaultValue={plan?.visitsCount ?? (kind === 'trial' ? 1 : 10)}
            />
          </div>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label className={label} htmlFor="p-audience">
            {labels.audience}
          </label>
          <Select id="p-audience" name="audience" defaultValue={plan?.audience ?? 'all'}>
            {Object.entries(labels.audiences).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="p-visibility">
            {labels.visibility}
          </label>
          <Select id="p-visibility" name="visibility" defaultValue={plan?.visibility ?? 'public'}>
            <option value="public">{labels.public}</option>
            <option value="private">{labels.privatePlan}</option>
          </Select>
        </div>
      </div>
      <div className="space-y-1">
        <label className={label} htmlFor="p-desc-bg">
          {labels.descriptionBg}
        </label>
        <Textarea
          id="p-desc-bg"
          name="descriptionBg"
          maxLength={500}
          rows={2}
          defaultValue={plan?.descriptionBg ?? ''}
        />
      </div>
      <div className="space-y-1">
        <label className={label} htmlFor="p-desc-en">
          {labels.descriptionEn}
        </label>
        <Textarea
          id="p-desc-en"
          name="descriptionEn"
          maxLength={500}
          rows={2}
          defaultValue={plan?.descriptionEn ?? ''}
        />
      </div>
      <fieldset className="space-y-3 rounded-card border border-line p-3">
        <legend className={`${label} px-1`}>{labels.terms}</legend>
        <p className="text-caption text-text-muted">{labels.termsHint}</p>
        {kind !== 'trial' && (
          <label className="flex min-h-11 items-start gap-3 text-body-sm text-ink">
            <input
              type="checkbox"
              name="autoRenew"
              checked={autoRenew}
              onChange={(event) => setAutoRenew(event.target.checked)}
              className="mt-1 size-4 accent-[var(--brand)]"
              aria-describedby="p-renew-hint"
            />
            <span>
              {labels.autoRenew}
              <span id="p-renew-hint" className="block text-caption text-text-muted">
                {labels.autoRenewHint}
              </span>
            </span>
          </label>
        )}
        {autoRenew && kind !== 'trial' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <label className={label} htmlFor="p-min-term">
                {labels.minTermMonths}
              </label>
              <Input
                id="p-min-term"
                name="minTermMonths"
                type="number"
                min={1}
                max={36}
                defaultValue={plan?.minTermMonths ?? ''}
              />
            </div>
            <div className="space-y-1">
              <label className={label} htmlFor="p-notice">
                {labels.noticeDays}
              </label>
              <Input
                id="p-notice"
                name="noticeDays"
                type="number"
                min={0}
                max={120}
                defaultValue={plan?.noticeDays ?? 0}
              />
            </div>
          </div>
        )}
        <label className="flex min-h-11 items-center gap-3 text-body-sm text-ink">
          <input
            type="checkbox"
            name="selfPause"
            defaultChecked={plan?.selfPauseAllowed ?? false}
            className="size-4 accent-[var(--brand)]"
          />
          {labels.selfPause}
        </label>
        {autoRenew && kind !== 'trial' && (
          <label className="flex min-h-11 items-center gap-3 text-body-sm text-ink">
            <input
              type="checkbox"
              name="selfCancel"
              defaultChecked={plan?.selfCancelAllowed ?? false}
              className="size-4 accent-[var(--brand)]"
            />
            {labels.selfCancel}
          </label>
        )}
      </fieldset>
      <Button type="submit" disabled={pending}>
        {labels.save}
      </Button>
    </form>
  );
}

export interface SaleFormLabels {
  member: string;
  memberPick: string;
  plan: string;
  startsOn: string;
  payNow: string;
  payLater: string;
  method: string;
  methods: Record<string, string>;
  amount: string;
  receivedOn: string;
  dueOn: string;
  /** "{plan} for {member}: {price}" */
  summary: string;
  submit: string;
}

/**
 * One form, three parts: who, what, and how it is paid. The summary line
 * above the button IS the confirmation — what will be recorded, in words.
 */
export function SaleForm({
  action,
  slug,
  labels,
  messages,
  members,
  plans,
  today,
  defaultMemberId,
  defaultPlanId,
}: {
  action: Action;
  slug: string;
  labels: SaleFormLabels;
  messages: ClubFormMessages;
  members: { id: string; label: string }[];
  plans: { id: string; label: string; price: string; priceText: string }[];
  today: string;
  defaultMemberId: string | null;
  defaultPlanId: string | null;
}) {
  const [state, formProps, pending] = useFormAction(action, INITIAL);
  const [memberId, setMemberId] = useState(defaultMemberId ?? '');
  const [planId, setPlanId] = useState(defaultPlanId ?? plans[0]?.id ?? '');
  const [payNow, setPayNow] = useState(true);
  const plan = plans.find((p) => p.id === planId);
  const member = members.find((m) => m.id === memberId);
  const summary = useMemo(
    () =>
      plan && member
        ? labels.summary
            .replace('{plan}', plan.label)
            .replace('{member}', member.label)
            .replace('{price}', plan.priceText)
        : null,
    [plan, member, labels.summary],
  );
  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="slug" value={slug} />
      <FormFeedback state={state} messages={messages} />
      <div className="space-y-1">
        <label className={label} htmlFor="sale-member">
          {labels.member}
        </label>
        <Select
          id="sale-member"
          name="memberId"
          required
          value={memberId}
          onChange={(event) => setMemberId(event.currentTarget.value)}
        >
          <option value="">{labels.memberPick}</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </Select>
      </div>
      <fieldset className="space-y-2">
        <legend className={label}>{labels.plan}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {plans.map((p) => (
            <label
              key={p.id}
              className={`flex min-h-11 cursor-pointer items-center justify-between gap-2 rounded-card border p-3 text-body-sm ${
                planId === p.id ? 'border-brand bg-brand-subtle' : 'border-line-strong'
              }`}
            >
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name="planId"
                  value={p.id}
                  checked={planId === p.id}
                  onChange={() => setPlanId(p.id)}
                  className="size-4 accent-[var(--brand)]"
                />
                <span className="font-medium text-ink">{p.label}</span>
              </span>
              <span className="font-mono tabular-nums text-ink">{p.priceText}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="space-y-1">
        <label className={label} htmlFor="sale-start">
          {labels.startsOn}
        </label>
        <Input
          id="sale-start"
          name="startsOn"
          type="date"
          required
          defaultValue={today}
          className="max-w-xs"
        />
      </div>
      <fieldset className="space-y-3 rounded-card border border-line p-3">
        <div className="flex flex-wrap gap-2">
          {(
            [
              ['now', labels.payNow],
              ['later', labels.payLater],
            ] as const
          ).map(([value, text]) => (
            <label
              key={value}
              className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-pill border px-4 text-body-sm ${
                (value === 'now') === payNow
                  ? 'border-brand bg-brand-subtle text-ink'
                  : 'border-line-strong text-ink-soft'
              }`}
            >
              <input
                type="radio"
                name="payNow"
                value={value}
                checked={(value === 'now') === payNow}
                onChange={() => setPayNow(value === 'now')}
                className="size-4 accent-[var(--brand)]"
              />
              {text}
            </label>
          ))}
        </div>
        {payNow ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <label className={label} htmlFor="sale-method">
                {labels.method}
              </label>
              <Select id="sale-method" name="method" defaultValue="cash">
                {Object.entries(labels.methods).map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <label className={label} htmlFor="sale-amount">
                {labels.amount}
              </label>
              <Input
                id="sale-amount"
                name="amount"
                inputMode="decimal"
                key={planId}
                defaultValue={plan?.price ?? ''}
              />
            </div>
            <div className="space-y-1">
              <label className={label} htmlFor="sale-received">
                {labels.receivedOn}
              </label>
              <Input
                id="sale-received"
                name="receivedOn"
                type="date"
                defaultValue={today}
                max={today}
              />
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            <label className={label} htmlFor="sale-due">
              {labels.dueOn}
            </label>
            <Input id="sale-due" name="dueOn" type="date" min={today} className="max-w-xs" />
          </div>
        )}
      </fieldset>
      {summary && (
        <p
          className="rounded-card bg-paper-sunk p-3 text-body font-semibold text-ink"
          aria-live="polite"
        >
          {summary}
        </p>
      )}
      <Button type="submit" size="lg" disabled={pending || !memberId || !planId}>
        {labels.submit}
      </Button>
    </form>
  );
}
