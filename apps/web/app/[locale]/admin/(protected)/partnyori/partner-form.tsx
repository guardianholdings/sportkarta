'use client';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { PartnerRow } from '@/lib/partners';
import { useFormAction } from '@/lib/use-form-action';

import type { PartnerState } from './actions';

/**
 * Create/edit form for a partner. Labels arrive pre-translated as props (the
 * campaign-form rule: next-intl's server catalogue is not available here).
 * Bilingual content columns: bg required, en optional.
 *
 * The shared form controls, not page-local boxes: those drew their border in
 * `--line`, 1.31:1 against the surface — an input an operator could not see on
 * a phone in daylight (A-17). And useFormAction, so a refused slug or URL comes
 * back above the form as it was typed, not an emptied one (A-2).
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
  const [state, formProps, pending] = useFormAction(action, INITIAL);

  return (
    <form {...formProps} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label className={label} htmlFor="p-slug">
            {labels.slug}
          </label>
          <Input
            id="p-slug"
            name="slug"
            required
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            maxLength={60}
            defaultValue={partner?.slug}
          />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="p-tier">
            {labels.tier}
          </label>
          <Select id="p-tier" name="tier" defaultValue={partner?.tier ?? 'supporter'}>
            {Object.entries(labels.tiers).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label className={label} htmlFor="p-name-bg">
            {labels.nameBg}
          </label>
          <Input
            id="p-name-bg"
            name="nameBg"
            required
            maxLength={120}
            defaultValue={partner?.nameBg}
          />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="p-name-en">
            {labels.nameEn}
          </label>
          <Input
            id="p-name-en"
            name="nameEn"
            maxLength={120}
            defaultValue={partner?.nameEn ?? ''}
          />
        </div>
      </div>

      <div className="space-y-1">
        <label className={label} htmlFor="p-blurb-bg">
          {labels.blurbBg}
        </label>
        <Textarea
          id="p-blurb-bg"
          name="blurbBg"
          rows={3}
          size="sm"
          maxLength={2000}
          defaultValue={partner?.blurbBg ?? ''}
        />
        <p className="text-caption text-text-muted">{labels.blurbHint}</p>
      </div>
      <div className="space-y-1">
        <label className={label} htmlFor="p-blurb-en">
          {labels.blurbEn}
        </label>
        <Textarea
          id="p-blurb-en"
          name="blurbEn"
          rows={3}
          size="sm"
          maxLength={2000}
          defaultValue={partner?.blurbEn ?? ''}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label className={label} htmlFor="p-url">
            {labels.url}
          </label>
          <Input
            id="p-url"
            name="url"
            type="url"
            maxLength={300}
            defaultValue={partner?.url ?? ''}
          />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="p-logo">
            {labels.logo}
          </label>
          <Input id="p-logo" name="logo" type="file" accept="image/png,image/jpeg,image/webp" />
          <p className="text-caption text-text-muted">{labels.logoHint}</p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1">
          <label className={label} htmlFor="p-starts">
            {labels.startsOn}
          </label>
          <Input id="p-starts" name="startsOn" type="date" defaultValue={partner?.startsOn ?? ''} />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="p-ends">
            {labels.endsOn}
          </label>
          <Input id="p-ends" name="endsOn" type="date" defaultValue={partner?.endsOn ?? ''} />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="p-sort">
            {labels.sortOrder}
          </label>
          <Input
            id="p-sort"
            name="sortOrder"
            type="number"
            min={-10000}
            max={10000}
            defaultValue={partner?.sortOrder ?? 0}
          />
        </div>
      </div>

      <Checkbox
        name="visible"
        defaultChecked={partner?.visible ?? false}
        label={labels.visible}
        className="min-h-11"
      />

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

      <Button type="submit" disabled={pending}>
        {labels.submit}
      </Button>
    </form>
  );
}
