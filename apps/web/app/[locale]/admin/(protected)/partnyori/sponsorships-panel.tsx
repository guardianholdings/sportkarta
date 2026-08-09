import { getDb } from '@sportkarta/db';
import { getTranslations } from 'next-intl/server';

import { ConfirmButton } from '@/components/ui/confirm-button';
import { partnerSponsorships } from '@/lib/facility-sponsors';
import { Link } from '@/i18n/navigation';

import { createSponsorshipAction, deleteSponsorshipAction } from './sponsorship-actions';
import { SponsorshipForm, type SponsorshipFormLabels } from './sponsorship-form';

/**
 * Adopt-a-facility management for one partner (docs/MONETISATION.md S3, M3a),
 * on the partner's own admin screen — the plan's decision, and the same one M4
 * made for ad placements: a partner's page is where everything they bought lives.
 *
 * The list links each adopted facility so the operator can check the public page
 * says what they expect, and shows the window because the whole point of an
 * adoption being bounded is that somebody notices when it runs out.
 */
export async function SponsorshipsPanel({
  partnerId,
  partnerSlug,
}: {
  partnerId: number;
  partnerSlug: string;
}) {
  const [t, sponsorships] = await Promise.all([
    getTranslations('AdminPartners'),
    partnerSponsorships(getDb(), partnerId),
  ]);

  const labels: SponsorshipFormLabels = {
    facilitySlug: t('adoptFieldFacility'),
    facilityHint: t('adoptFacilityHint'),
    labelBg: t('adoptFieldLabelBg'),
    labelEn: t('adoptFieldLabelEn'),
    labelHint: t('adoptLabelHint'),
    startsOn: t('fieldStartsOn'),
    endsOn: t('fieldEndsOn'),
    submit: t('adoptSubmit'),
    saved: t('saved'),
    errors: Object.fromEntries(
      (
        [
          'bad_facility',
          'facility_not_found',
          'facility_taken',
          'bad_partner',
          'label_too_long',
          'bad_date',
          'window_order',
        ] as const
      ).map((code) => [code, t(`error_${code}`)]),
    ),
    genericError: t('error_generic'),
  };

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia' }).format(new Date());

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-h4 font-bold text-ink">{t('adoptTitle')}</h2>
        <p className="text-body-sm text-text-muted">{t('adoptIntro')}</p>
      </div>

      {sponsorships.length === 0 ? (
        <p className="text-body-sm text-ink-soft">{t('adoptEmpty')}</p>
      ) : (
        <ul className="space-y-2">
          {sponsorships.map((row) => {
            const lapsed = row.endsOn < today;
            const upcoming = row.startsOn > today;
            return (
              <li
                key={row.id}
                className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-3 text-body-sm"
              >
                <span className="font-medium text-ink">
                  {row.facilitySlug ? (
                    <Link
                      href={`/obekt/${row.facilitySlug}`}
                      className="text-link hover:text-link-hover"
                    >
                      {row.facilityName ?? row.facilitySlug}
                    </Link>
                  ) : (
                    (row.facilityName ?? row.facilityId)
                  )}
                </span>
                <span className="tabular-nums text-text-muted">
                  {row.startsOn} → {row.endsOn}
                </span>
                <span className="text-caption text-text-muted">
                  {lapsed ? t('adoptLapsed') : upcoming ? t('adoptScheduled') : t('adoptActive')}
                </span>
                <form
                  action={deleteSponsorshipAction.bind(null, partnerSlug, row.id)}
                  className="ml-auto"
                >
                  <ConfirmButton
                    className="rounded-md border border-line-strong px-3 py-1.5 text-body-sm text-danger"
                    message={t('adoptDeleteConfirm')}
                  >
                    {t('adoptDelete')}
                  </ConfirmButton>
                </form>
              </li>
            );
          })}
        </ul>
      )}

      <details className="rounded-card border border-line bg-surface p-4">
        <summary className="cursor-pointer text-body-sm font-semibold text-ink">
          {t('adoptAddTitle')}
        </summary>
        <div className="pt-3">
          {/* The policy this screen states and the schema cannot: publish the
              acknowledgment AFTER the funded upkeep is evidenced (§S3). */}
          <p className="mb-3 text-caption text-text-muted">{t('adoptPolicyNote')}</p>
          <SponsorshipForm
            action={createSponsorshipAction.bind(null, partnerSlug)}
            labels={labels}
            partnerId={partnerId}
          />
        </div>
      </details>
    </section>
  );
}
