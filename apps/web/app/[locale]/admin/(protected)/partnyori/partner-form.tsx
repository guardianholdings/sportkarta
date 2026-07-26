'use client';

import { useActionState } from 'react';

import type { PartnerRow } from '@/lib/partners';

import type { PartnerState } from './actions';

/**
 * Create/edit form for a partner. Labels arrive pre-translated as props (the
 * campaign-form rule: next-intl's server catalogue is not available here).
 * Bilingual content columns: bg required, en optional.
 */
export interface PartnerFormLabels {
  slug: string;
  tier: string;
  tiers: Record<string, string>;
  nameBg: string;
  nameEn: string;
  blurbBg: string;
  blurbEn: string;
  blurbHint: string;
  url: string;
  logo: string;
  logoHint: string;
  visible: string;
  sortOrder: string;
  startsOn: string;
  endsOn: string;
  submit: string;
  saved: string;
  errors: Record<string, string>;
  genericError: string;
}

const INITIAL: PartnerState = { error: null };

const field =
  'w-full rounded-md border border-line bg-surface px-3 py-2 text-body-sm text-ink';
const label = 'block text-body-sm font-semibold text-ink';

export function PartnerForm({
  action,
  labels,
  partner,
}: {
  action: (prev: PartnerState, formData: FormData) => Promise<PartnerState>;
  labels: PartnerFormLabels;
  partner?: PartnerRow;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL);

  return (
    <form action={formAction} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label className={label} htmlFor="p-slug">
            {labels.slug}
          </label>
          <input
            id="p-slug"
            name="slug"
            required
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            maxLength={60}
            defaultValue={partner?.slug}
            className={field}
          />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="p-tier">
            {labels.tier}
          </label>
          <select id="p-tier" name="tier" defaultValue={partner?.tier ?? 'supporter'} className={field}>
            {Object.entries(labels.tiers).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label className={label} htmlFor="p-name-bg">
            {labels.nameBg}
          </label>
          <input
            id="p-name-bg"
            name="nameBg"
            required
            maxLength={120}
            defaultValue={partner?.nameBg}
            className={field}
          />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="p-name-en">
            {labels.nameEn}
          </label>
          <input
            id="p-name-en"
            name="nameEn"
            maxLength={120}
            defaultValue={partner?.nameEn ?? ''}
            className={field}
          />
        </div>
      </div>

      <div className="space-y-1">
        <label className={label} htmlFor="p-blurb-bg">
          {labels.blurbBg}
        </label>
        <textarea
          id="p-blurb-bg"
          name="blurbBg"
          rows={3}
          maxLength={2000}
          defaultValue={partner?.blurbBg ?? ''}
          className={field}
        />
        <p className="text-caption text-text-muted">{labels.blurbHint}</p>
      </div>
      <div className="space-y-1">
        <label className={label} htmlFor="p-blurb-en">
          {labels.blurbEn}
        </label>
        <textarea
          id="p-blurb-en"
          name="blurbEn"
          rows={3}
          maxLength={2000}
          defaultValue={partner?.blurbEn ?? ''}
          className={field}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label className={label} htmlFor="p-url">
            {labels.url}
          </label>
          <input
            id="p-url"
            name="url"
            type="url"
            maxLength={300}
            defaultValue={partner?.url ?? ''}
            className={field}
          />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="p-logo">
            {labels.logo}
          </label>
          <input id="p-logo" name="logo" type="file" accept="image/png,image/jpeg,image/webp" className={field} />
          <p className="text-caption text-text-muted">{labels.logoHint}</p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1">
          <label className={label} htmlFor="p-starts">
            {labels.startsOn}
          </label>
          <input
            id="p-starts"
            name="startsOn"
            type="date"
            defaultValue={partner?.startsOn ?? ''}
            className={field}
          />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="p-ends">
            {labels.endsOn}
          </label>
          <input
            id="p-ends"
            name="endsOn"
            type="date"
            defaultValue={partner?.endsOn ?? ''}
            className={field}
          />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="p-sort">
            {labels.sortOrder}
          </label>
          <input
            id="p-sort"
            name="sortOrder"
            type="number"
            min={-10000}
            max={10000}
            defaultValue={partner?.sortOrder ?? 0}
            className={field}
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-body-sm text-ink">
        <input type="checkbox" name="visible" defaultChecked={partner?.visible ?? false} />
        {labels.visible}
      </label>

      {state.error && (
        <p role="alert" className="text-body-sm text-danger">
          {labels.errors[state.error] ?? labels.genericError}
        </p>
      )}
      {state.saved && (
        <p role="status" className="text-body-sm text-success">
          {labels.saved}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-brand px-4 py-2 text-body-sm font-semibold text-on-brand disabled:opacity-60"
      >
        {labels.submit}
      </button>
    </form>
  );
}
