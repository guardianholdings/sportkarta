import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { MemberForm } from '@/components/clubs/member-form';
import { Link } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { clubFormMessages, memberFormLabels } from '@/lib/clubs/form-labels';
import { isUuid } from '@/lib/clubs/input';
import { guardianChoices, memberCard } from '@/lib/clubs/members';

import { saveMemberAction } from '../../actions';

export const dynamic = 'force-dynamic';

export default async function EditMemberPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string; memberId: string }>;
}) {
  const { locale, slug, memberId } = await params;
  setRequestLocale(locale);
  if (!isUuid(memberId)) notFound();
  const { actor } = await requireClubStaff(slug, 'members.manage');
  const member = await memberCard(actor, memberId);
  if (!member) notFound();
  const [t, labels, messages, guardians] = await Promise.all([
    getTranslations('ClubMembers'),
    memberFormLabels('save'),
    clubFormMessages(),
    guardianChoices(actor, memberId),
  ]);
  return (
    <main className="mx-auto max-w-2xl space-y-4">
      <Link
        href={`/klub/${slug}/chlenove/${memberId}`}
        className="text-body-sm font-semibold text-link hover:text-link-hover"
      >
        ← {member.displayName}
      </Link>
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('form.titleEdit')}</h1>
      <section className="rounded-card border border-line bg-surface p-4 shadow-sm">
        <MemberForm
          action={saveMemberAction}
          slug={slug}
          labels={labels}
          messages={messages}
          guardians={guardians}
          member={{
            id: member.id,
            displayName: member.displayName,
            email: member.email,
            phone: member.phone,
            isMinor: member.isMinor,
            guardianId: member.guardianId,
            tags: member.tags,
            staffNote: member.staffNote,
          }}
        />
      </section>
    </main>
  );
}
