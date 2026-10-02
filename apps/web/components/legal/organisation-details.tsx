import { getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import type { Organisation } from '@/lib/organisation';

/**
 * Who runs POPS, as a definition list — the controller identity (GDPR Art. 13)
 * and the point of contact (DSA Arts. 11-12), on /kontakt, /privacy and
 * /usloviya from ONE component so the three can never disagree.
 *
 * Only the fields the operator configured are printed (lib/organisation.ts);
 * a missing one is omitted, never filled in. When NOTHING identifies the
 * association yet, the list is replaced by a sentence saying exactly that —
 * true, and better than an empty heading.
 */
export async function OrganisationDetails({ org }: { org: Organisation }) {
  const t = await getTranslations('Contact');
  const rows = (
    [
      ['legalName', org.legalName],
      ['eik', org.eik],
      ['address', org.address],
    ] as const
  ).filter((row): row is readonly [(typeof row)[0], string] => row[1] !== null);

  return (
    <div className="space-y-2">
      {rows.length > 0 ? (
        <dl className="grid gap-x-4 gap-y-1 rounded-card border border-line bg-surface p-4 text-body-sm sm:grid-cols-[12rem_1fr]">
          {rows.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-text-muted">{t(`label.${key}`)}</dt>
              <dd className="font-medium text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-ink-soft">{t('identityPending')}</p>
      )}
      <ContactLine email={org.contactEmail} />
    </div>
  );
}

/**
 * The monitored inbox, or — until the operator publishes one — the notice
 * form, which reaches the administrators and can carry a reply address. Never
 * the anonymous facility report: nobody who uses that can be answered.
 */
export async function ContactLine({ email }: { email: string | null }) {
  const t = await getTranslations('Contact');
  if (email) {
    return (
      <p className="text-ink-soft">
        {t.rich('emailLine', {
          address: email,
          email: (chunks) => (
            <a href={`mailto:${email}`} className="font-medium text-link hover:text-link-hover">
              {chunks}
            </a>
          ),
        })}
      </p>
    );
  }
  return (
    <p className="text-ink-soft">
      {t.rich('noEmail', {
        form: (chunks) => (
          <Link href="/signal" className="font-medium text-link hover:text-link-hover">
            {chunks}
          </Link>
        ),
      })}
    </p>
  );
}
