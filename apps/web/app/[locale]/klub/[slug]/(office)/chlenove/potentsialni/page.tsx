import { LEAD_DESK_SOURCES, LEAD_STAGES, sofiaToday } from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { LeadCardView } from '@/components/clubs/lead-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Link } from '@/i18n/navigation';
import { actorCan, requireClubStaff } from '@/lib/clubs/club-session';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { leadBoard, leadOwners } from '@/lib/clubs/leads';
import { formErrorText, isOutcomeCode } from '@/lib/clubs/form-error';

import { addLeadAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * «Потенциални клиенти» (0052, wave F2 — 1club's leads pipeline): everybody
 * who asked, booked a trial or was added by the desk, by stage. A trial
 * booking, a first visit and a sale move a card by themselves; the desk
 * records who called, the next step and its owner, and why a prospect was
 * lost. Cards due today come first.
 */
export default async function ClubLeadsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor } = await requireClubStaff(slug, 'members.view');
  const today = sofiaToday();
  const [t, messages, cards, owners] = await Promise.all([
    getTranslations('ClubLeads'),
    clubFormMessages(),
    leadBoard(actor, today),
    leadOwners(actor),
  ]);
  const { rezultat } = await searchParams;
  const canManage = actorCan(actor, 'members.manage');
  const good = rezultat !== undefined && isOutcomeCode(rezultat) && t.has(`outcome.${rezultat}`);
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';
  const field = 'block text-body-sm font-semibold text-ink';

  return (
    <main className="space-y-5">
      <Link
        href={`/klub/${slug}/chlenove`}
        className="text-body-sm font-semibold text-link hover:text-link-hover"
      >
        {t('back')}
      </Link>
      <div>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="mt-1.5 max-w-prose text-body-sm text-ink-soft">{t('intro')}</p>
      </div>

      {rezultat && (
        <p
          role="status"
          className={
            good
              ? 'rounded-card border border-success-border bg-success-bg p-3 text-body-sm text-ink'
              : 'rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink'
          }
        >
          {good
            ? t(`outcome.${rezultat}`)
            : rezultat === 'readOnly'
              ? messages.readOnly
              : formErrorText(messages, rezultat)}
        </p>
      )}

      {canManage && (
        <details className={section}>
          <summary className="flex min-h-11 cursor-pointer items-center text-h4 font-bold text-ink">
            {t('addTitle')}
          </summary>
          <form action={addLeadAction} className="mt-3 grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="slug" value={slug} />
            <label className={field}>
              {t('name')}
              <Input name="displayName" required maxLength={120} size="sm" className="mt-1" />
            </label>
            <label className={field}>
              {t('phone')}
              <Input name="phone" type="tel" maxLength={32} size="sm" className="mt-1" />
            </label>
            <label className={field}>
              {t('email')}
              <Input name="email" type="email" maxLength={254} size="sm" className="mt-1" />
            </label>
            <label className={field}>
              {t('sourceLabel')}
              <select
                name="source"
                defaultValue="desk"
                className="mt-1 block min-h-11 w-full rounded-md border border-line-strong bg-surface px-3 text-body-sm text-ink"
              >
                {LEAD_DESK_SOURCES.map((source) => (
                  <option key={source} value={source}>
                    {t(`source.${source}`)}
                  </option>
                ))}
              </select>
            </label>
            <div className="sm:col-span-2">
              <Button type="submit">{t('add')}</Button>
            </div>
          </form>
        </details>
      )}

      {cards.length === 0 ? (
        <p className="text-body-sm text-text-muted">{t('empty')}</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {LEAD_STAGES.map((stage) => {
            const inStage = cards.filter((card) => card.stage === stage);
            if (inStage.length === 0) return null;
            return (
              <section key={stage} className={section} aria-labelledby={`stage-${stage}`}>
                <h2 id={`stage-${stage}`} className="text-h4 font-bold text-ink">
                  {t(`stage.${stage}`)}{' '}
                  <span className="text-body-sm font-medium text-text-muted">{inStage.length}</span>
                </h2>
                <p className="text-caption text-text-muted">{t(`stageHint.${stage}`)}</p>
                <div className="space-y-2">
                  {inStage.map((card) => (
                    <LeadCardView
                      key={card.memberId}
                      slug={slug}
                      card={card}
                      owners={owners}
                      locale={locale}
                      canManage={canManage}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}
