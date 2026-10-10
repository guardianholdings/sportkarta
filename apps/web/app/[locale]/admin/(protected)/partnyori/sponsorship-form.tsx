'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useFormAction } from '@/lib/use-form-action';

import type { SponsorshipState } from './sponsorship-actions';

/**
 * Add-an-adoption form (docs/MONETISATION.md S3, M3a).
 *
 * Labels arrive pre-translated as props (the campaign-form rule — a client
 * component calling getTranslations pulls the catalogue into the bundle).
 *
 * The facility is identified by its URL SLUG, which is what an operator has in
 * front of them, and resolved to an id server-side. No edit form, for the ad-slot
 * reason: an adoption is a facility, a partner and a period, and changing any of
 * those is a different arrangement — delete and re-add keeps the exclusion
 * constraint the single arbiter of "one adoption per facility per period".
 */

export interface SponsorshipFormLabels {
  facilitySlug: string;
  facilityHint: string;
  labelBg: string;
  labelEn: string;
  labelHint: string;
  startsOn: string;
  endsOn: string;
  submit: string;
  saved: string;
  errors: Record<string, string>;
  genericError: string;
}

const INITIAL: SponsorshipState = { error: null };

export function SponsorshipForm({
  action,
  labels,
  partnerId,
}: {
  action: (state: SponsorshipState, formData: FormData) => Promise<SponsorshipState>;
  labels: SponsorshipFormLabels;
  partnerId: number;
}) {
  // A refusal (the slot or the facility is taken for those dates) keeps what
  // was typed; only a saved row clears the form for the next one (A-2).
  const [state, formProps, pending] = useFormAction(action, INITIAL, {
    resetWhen: (next) => next.saved === true,
  });

  return (
    <form {...formProps} className="space-y-3">
      <input type="hidden" name="partnerId" value={partnerId} />

      <label className="flex flex-col gap-1.5">
        <span className="text-caption font-medium text-ink-soft">{labels.facilitySlug}</span>
        <Input type="text" name="facilitySlug" required maxLength={120} />
        <span className="text-caption text-text-muted">{labels.facilityHint}</span>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-caption font-medium text-ink-soft">{labels.labelBg}</span>
        <Input type="text" name="labelBg" maxLength={200} />
        <span className="text-caption text-text-muted">{labels.labelHint}</span>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-caption font-medium text-ink-soft">{labels.labelEn}</span>
        <Input type="text" name="labelEn" maxLength={200} />
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-caption font-medium text-ink-soft">{labels.startsOn}</span>
          <Input type="date" name="startsOn" required />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-caption font-medium text-ink-soft">{labels.endsOn}</span>
          <Input type="date" name="endsOn" required />
        </label>
      </div>

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
