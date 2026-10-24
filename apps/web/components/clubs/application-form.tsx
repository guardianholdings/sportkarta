'use client';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { ClubFormMessages } from '@/lib/clubs/form-labels';
import { useFormAction } from '@/lib/use-form-action';

import { FormFeedback } from './form-feedback';

/**
 * The club application (/klubove/zayavka). The signed-in account becomes the
 * owner; the club starts `pending` and the operator approves it. Field names
 * match parseApplication in apps/web/lib/clubs/input.ts.
 */

export interface ApplyState {
  error: string | null;
  errors?: string[];
  saved?: boolean;
}

const INITIAL: ApplyState = { error: null };
const label = 'block text-body-sm font-semibold text-ink';

export interface ApplicationFormLabels {
  name: string;
  kind: string;
  kinds: Record<string, string>;
  tier: string;
  tiers: { value: string; label: string; hint: string }[];
  city: string;
  cityNone: string;
  cities: { id: number; name: string }[];
  sports: string;
  sportOptions: { value: string; label: string }[];
  website: string;
  description: string;
  acceptTerms: string;
  submit: string;
}

export function ApplicationForm({
  action,
  labels,
  messages,
}: {
  action: (prev: ApplyState, formData: FormData) => Promise<ApplyState>;
  labels: ApplicationFormLabels;
  messages: ClubFormMessages;
}) {
  const [state, formProps, pending] = useFormAction(action, INITIAL);
  return (
    <form {...formProps} className="space-y-4">
      <FormFeedback state={state} messages={messages} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label className={label} htmlFor="a-name">
            {labels.name}
          </label>
          <Input id="a-name" name="name" required maxLength={120} />
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="a-kind">
            {labels.kind}
          </label>
          <Select id="a-kind" name="kind" defaultValue="gym">
            {Object.entries(labels.kinds).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="a-city">
            {labels.city}
          </label>
          <Select id="a-city" name="municipalityId" defaultValue="">
            <option value="">{labels.cityNone}</option>
            {labels.cities.map((city) => (
              <option key={city.id} value={city.id}>
                {city.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <label className={label} htmlFor="a-web">
            {labels.website}
          </label>
          <Input id="a-web" name="website" inputMode="url" maxLength={300} />
        </div>
      </div>
      <fieldset className="space-y-2">
        <legend className={label}>{labels.tier}</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {labels.tiers.map((tier) => (
            <label
              key={tier.value}
              className="flex cursor-pointer flex-col gap-1 rounded-card border border-line-strong p-3 has-[:checked]:border-brand has-[:checked]:bg-brand-subtle"
            >
              <span className="flex items-center gap-2 text-body-sm font-bold text-ink">
                <input
                  type="radio"
                  name="tier"
                  value={tier.value}
                  defaultChecked={tier.value === 'standard'}
                  className="size-4 accent-[var(--brand)]"
                />
                {tier.label}
              </span>
              <span className="text-caption text-ink-soft">{tier.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="space-y-2">
        <legend className={label}>{labels.sports}</legend>
        <div className="flex max-h-56 flex-wrap gap-x-4 gap-y-1 overflow-y-auto rounded-card border border-line p-3">
          {labels.sportOptions.map((sport) => (
            <Checkbox key={sport.value} name="sports" value={sport.value} label={sport.label} />
          ))}
        </div>
      </fieldset>
      <div className="space-y-1">
        <label className={label} htmlFor="a-desc">
          {labels.description}
        </label>
        <Textarea id="a-desc" name="description" maxLength={2000} rows={4} />
      </div>
      <Checkbox name="acceptTerms" required label={labels.acceptTerms} />
      <Button type="submit" disabled={pending}>
        {labels.submit}
      </Button>
    </form>
  );
}
