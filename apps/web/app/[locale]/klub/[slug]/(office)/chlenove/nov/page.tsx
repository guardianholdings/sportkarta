import { getTranslations, setRequestLocale } from 'next-intl/server';

import { MemberForm } from '@/components/clubs/member-form';
import { Link } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { clubFormMessages, memberFormLabels } from '@/lib/clubs/form-labels';
import { guardianChoices } from '@/lib/clubs/members';

import { saveMemberAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function NewMemberPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor } = await requireClubStaff(slug, 'members.manage');
  const [t, labels, messages, guardians] = await Promise.all([
    getTranslations('ClubMembers'),
    memberFormLabels('create'),
    clubFormMessages(),
    guardianChoices(actor),
  ]);
  return (
    <main className="mx-auto max-w-2xl space-y-4">
      <Link
        href={`/klub/${slug}/chlenove`}
        className="text-body-sm font-semibold text-link hover:text-link-hover"
      >
        ← {t('card.back')}
      </Link>
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('form.titleNew')}</h1>
      <section className="rounded-card border border-line bg-surface p-4 shadow-sm">
        <MemberForm
          action={saveMemberAction}
          slug={slug}
          labels={labels}
          messages={messages}
          guardians={guardians}
        />
      </section>
    </main>
  );
}
