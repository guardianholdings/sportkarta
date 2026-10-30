'use client';

import { Minus, Plus } from 'lucide-react';
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type { ClubFormMessages } from '@/lib/clubs/form-labels';
import { useFormAction } from '@/lib/use-form-action';
import { formErrorText } from '@/lib/clubs/form-error';

import { FormFeedback } from './form-feedback';

/**
 * The till (0049, wave B1): tap a product to add it, adjust quantities, pick
 * the client if there is one, how it is paid, an offer code — and record.
 * When the club has offers, the total is asked of the server as the cart,
 * the client or the code changes (`preview`, the same decision the sale
 * makes), so the cashier collects what the books will hold; until it
 * answers, the shelf total shows. The server re-reads every price on record.
 * A barcode scanner types a SKU and Enter: an exact match is added.
 */

export interface TillState {
  error: string | null;
  errors?: string[];
}

export type TillPreviewState =
  | {
      ok: true;
      subtotalCents: number;
      discountCents: number;
      totalCents: number;
      offerName: string | null;
    }
  | { ok: false; error: string };

const INITIAL: TillState = { error: null };

export interface TillLabels {
  search: string;
  cart: string;
  empty: string;
  member: string;
  walkIn: string;
  method: string;
  methods: Record<'cash' | 'card_desk' | 'other' | 'wallet' | 'account', string>;
  code: string;
  location: string;
  total: string;
  record: string;
  notFiscal: string;
  offersNote: string;
  offer: string;
  less: string;
  more: string;
  categories: Record<string, string>;
}

export function TillForm({
  action,
  preview,
  slug,
  locale,
  labels,
  messages,
  products,
  members,
  locations,
  offers,
  wallet = false,
}: {
  action: (state: TillState, payload: FormData) => Promise<TillState>;
  preview: (input: {
    slug: string;
    lines: string[];
    memberId: string;
    code: string;
  }) => Promise<TillPreviewState>;
  slug: string;
  locale: string;
  labels: TillLabels;
  messages: ClubFormMessages;
  products: {
    id: string;
    name: string;
    sku: string | null;
    category: string;
    priceCents: number;
  }[];
  members: { id: string; label: string }[];
  locations: { id: string; name: string }[];
  offers: boolean;
  /** The club's tier has prepaid credit (0050): a client may pay from it. */
  wallet?: boolean;
}) {
  const [state, formProps, pending] = useFormAction(action, INITIAL);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [query, setQuery] = useState('');
  const [memberId, setMemberId] = useState('');
  const [method, setMethod] = useState<keyof TillLabels['methods']>('cash');
  const [code, setCode] = useState('');
  const [priced, setPriced] = useState<{ key: string; result: TillPreviewState } | null>(null);
  const euro = useMemo(
    () =>
      new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'bg-BG', {
        style: 'currency',
        currency: 'EUR',
      }),
    [locale],
  );
  const add = (id: string, delta: number) =>
    setCart((current) => {
      const quantity = Math.min(1000, (current[id] ?? 0) + delta);
      return quantity > 0
        ? { ...current, [id]: quantity }
        : Object.fromEntries(Object.entries(current).filter(([key]) => key !== id));
    });
  const shown = query.trim()
    ? products.filter(
        (p) =>
          p.name.toLowerCase().includes(query.trim().toLowerCase()) ||
          (p.sku !== null && p.sku.toLowerCase() === query.trim().toLowerCase()),
      )
    : products;
  const groups = [...new Set(shown.map((p) => p.category))];
  const lines = products.filter((p) => cart[p.id]);
  const total = lines.reduce((sum, p) => sum + p.priceCents * (cart[p.id] ?? 0), 0);
  const cartKey = lines.map((p) => `${p.id}:${String(cart[p.id])}`).join(',');
  const priceKey = `${cartKey}|${memberId}|${code.trim()}`;
  useEffect(() => {
    if (!offers || cartKey === '') return;
    let live = true;
    const timer = setTimeout(() => {
      preview({ slug, lines: cartKey.split(','), memberId, code })
        .then((result) => {
          if (live) setPriced({ key: priceKey, result });
        })
        .catch(() => {
          // No answer: the shelf total stays, and the sale decides.
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [offers, cartKey, memberId, code, priceKey, preview, slug]);
  // Only an answer for exactly this cart, client and code counts.
  const current = priced?.key === priceKey ? priced.result : null;
  const shownTotal = current?.ok ? current.totalCents : total;
  const codeProblem =
    current && !current.ok && code.trim() !== '' ? formErrorText(messages, current.error) : null;
  const onScan = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const sku = query.trim().toLowerCase();
    const hit = products.find((p) => p.sku !== null && p.sku.toLowerCase() === sku);
    if (hit) {
      add(hit.id, 1);
      setQuery('');
    }
  };

  return (
    <form {...formProps} className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <input type="hidden" name="slug" value={slug} />
      {lines.map((p) => (
        <input key={p.id} type="hidden" name="line" value={`${p.id}:${String(cart[p.id])}`} />
      ))}
      <div className="space-y-3">
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={onScan}
          placeholder={labels.search}
          aria-label={labels.search}
        />
        {groups.map((group) => (
          <div key={group} className="space-y-1.5">
            <h3 className="text-caption font-semibold uppercase tracking-wide text-ink-soft">
              {labels.categories[group] ?? group}
            </h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {shown
                .filter((p) => p.category === group)
                .map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => add(p.id, 1)}
                    className="flex min-h-16 flex-col items-start justify-between rounded-card border border-line-strong bg-surface p-2 text-left text-body-sm hover:border-brand"
                  >
                    <span className="font-semibold text-ink">{p.name}</span>
                    <span className="font-mono tabular-nums text-ink-soft">
                      {euro.format(p.priceCents / 100)}
                    </span>
                  </button>
                ))}
            </div>
          </div>
        ))}
      </div>
      <div className="space-y-3 rounded-card border border-line bg-surface p-3 shadow-sm lg:sticky lg:top-4 lg:self-start">
        <FormFeedback state={state} messages={messages} />
        <h2 className="text-h4 font-bold text-ink">{labels.cart}</h2>
        {lines.length === 0 ? (
          <p className="text-body-sm text-text-muted">{labels.empty}</p>
        ) : (
          <ul className="divide-y divide-line">
            {lines.map((p) => (
              <li key={p.id} className="flex items-center gap-2 py-1.5 text-body-sm">
                <span className="min-w-0 flex-1 text-ink">{p.name}</span>
                <button
                  type="button"
                  onClick={() => add(p.id, -1)}
                  aria-label={`${labels.less}: ${p.name}`}
                  className="grid size-9 place-items-center rounded-pill border border-line-strong"
                >
                  <Minus className="size-4" aria-hidden="true" />
                </button>
                <span className="w-6 text-center font-mono tabular-nums">{cart[p.id]}</span>
                <button
                  type="button"
                  onClick={() => add(p.id, 1)}
                  aria-label={`${labels.more}: ${p.name}`}
                  className="grid size-9 place-items-center rounded-pill border border-line-strong"
                >
                  <Plus className="size-4" aria-hidden="true" />
                </button>
                <span className="w-20 text-right font-mono tabular-nums text-ink">
                  {euro.format((p.priceCents * (cart[p.id] ?? 0)) / 100)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <label className="block text-caption text-ink-soft">
          {labels.member}
          <Select
            name="memberId"
            value={memberId}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setMemberId(next);
              // On account, or from credit, needs a client.
              if (next === '' && (method === 'account' || method === 'wallet')) setMethod('cash');
            }}
            className="mt-1"
          >
            <option value="">{labels.walkIn}</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
        </label>
        <fieldset className="space-y-1">
          <legend className="text-caption text-ink-soft">{labels.method}</legend>
          <div className="flex flex-wrap gap-1.5">
            {(wallet
              ? (['cash', 'card_desk', 'other', 'wallet', 'account'] as const)
              : (['cash', 'card_desk', 'other', 'account'] as const)
            ).map((value) => (
              <label
                key={value}
                className={`flex min-h-10 cursor-pointer items-center gap-1.5 rounded-pill border px-3 text-body-sm ${
                  method === value
                    ? 'border-brand bg-brand-subtle text-ink'
                    : 'border-line-strong text-ink-soft'
                } ${(value === 'account' || value === 'wallet') && memberId === '' ? 'opacity-50' : ''}`}
              >
                <input
                  type="radio"
                  name="method"
                  value={value}
                  checked={method === value}
                  disabled={(value === 'account' || value === 'wallet') && memberId === ''}
                  onChange={() => setMethod(value)}
                  className="size-4 accent-[var(--brand)]"
                />
                {labels.methods[value]}
              </label>
            ))}
          </div>
        </fieldset>
        {offers && (
          <label className="block text-caption text-ink-soft">
            {labels.code}
            <Input
              name="code"
              maxLength={24}
              value={code}
              onChange={(event) => setCode(event.currentTarget.value)}
              aria-invalid={codeProblem ? true : undefined}
              aria-describedby={codeProblem ? 'till-code-problem' : undefined}
              className="mt-1 font-mono uppercase"
            />
            {codeProblem && (
              <span id="till-code-problem" className="mt-1 block text-caption text-danger">
                {codeProblem}
              </span>
            )}
          </label>
        )}
        {locations.length > 1 && (
          <label className="block text-caption text-ink-soft">
            {labels.location}
            <Select name="locationId" defaultValue={locations[0]?.id} className="mt-1">
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </label>
        )}
        {locations.length === 1 && (
          <input type="hidden" name="locationId" value={locations[0]?.id} />
        )}
        {current?.ok && current.discountCents > 0 && (
          <p className="flex items-baseline justify-between gap-2 text-body-sm text-ink-soft">
            <span className="min-w-0">
              {labels.offer}
              {current.offerName ? `: ${current.offerName}` : ''}
            </span>
            <span className="font-mono tabular-nums">
              −{euro.format(current.discountCents / 100)}
            </span>
          </p>
        )}
        <p
          className="flex items-baseline justify-between text-body font-bold text-ink"
          aria-live="polite"
        >
          <span>{labels.total}</span>
          <span className="font-mono tabular-nums">{euro.format(shownTotal / 100)}</span>
        </p>
        {offers && <p className="text-caption text-text-muted">{labels.offersNote}</p>}
        <Button type="submit" size="lg" className="w-full" disabled={pending || lines.length === 0}>
          {labels.record}
        </Button>
        <p className="text-caption text-text-muted">{labels.notFiscal}</p>
      </div>
    </form>
  );
}
