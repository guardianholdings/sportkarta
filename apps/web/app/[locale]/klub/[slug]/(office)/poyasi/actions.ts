'use server';

import { getDb } from '@sportkarta/db';
import { RANK_TEMPLATES, sofiaToday, type RankTemplateRank } from '@sportkarta/lib/clubs';
import { getLocale, getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import {
  isUuid,
  parseAward,
  parseLadder,
  parseNextAwardPicks,
  parseRank,
  type RankInput,
} from '@/lib/clubs/input';
import {
  awardNextRanks,
  awardRank,
  moveRank,
  removeRank,
  revokeAward,
  saveLadder,
  saveRank,
  setLadderArchived,
} from '@/lib/clubs/ranks';

/**
 * Ranks and belts in the office (0056). Ladders and ranks are ranks.manage;
 * awarding and revoking are ranks.award (the club's own staff — the SQL
 * leaves the NGO admin out). Every statement carries its own scope.
 */

function slugOf(formData: FormData): string {
  const slug = formData.get('slug');
  return typeof slug === 'string' && /^[a-z0-9-]{3,60}$/.test(slug) ? slug : '';
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Back to the list (`ladderId` null) or a ladder; `rezultat` is a code, and
 * `extra` carries an exam day's counts.
 */
async function back(
  slug: string,
  ladderId: string | null,
  rezultat: string,
  extra = '',
): Promise<never> {
  revalidatePath(`/klub/${slug}/poyasi`);
  return redirect({
    href: `/klub/${slug}/poyasi${ladderId ? `/${ladderId}` : ''}?rezultat=${rezultat}${extra}`,
    locale: await getLocale(),
  });
}

/** Back to a member card's ranks section. */
async function card(slug: string, memberId: string, rezultat: string): Promise<never> {
  revalidatePath(`/klub/${slug}/chlenove/${memberId}`);
  return redirect({
    href: `/klub/${slug}/chlenove/${memberId}?poyas=${rezultat}#ranks-h`,
    locale: await getLocale(),
  });
}

/**
 * A new ladder — from a template, its ranks named in both languages from the
 * catalogue — or a ladder's edited names and sport.
 */
export async function saveLadderAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'ranks.manage');
  const raw = str(formData, 'ladderId');
  const ladderId = isUuid(raw) ? raw : null;
  const parsed = parseLadder(formData, ladderId === null);
  if (!parsed.ok) return back(slug, ladderId, parsed.errors[0] ?? 'invalid');
  const { template } = parsed.value;
  let nameBg = parsed.value.nameBg;
  let nameEn = parsed.value.nameEn;
  let sport: string | null = parsed.value.sport;
  const starting: RankInput[] = [];
  if (template !== null) {
    const [tBg, tEn] = await Promise.all([
      getTranslations({ locale: 'bg', namespace: 'ClubRanks' }),
      getTranslations({ locale: 'en', namespace: 'ClubRanks' }),
    ]);
    if (nameBg === null) {
      nameBg = tBg(`templates.${template}.name`);
      nameEn = nameEn ?? tEn(`templates.${template}.name`);
    }
    sport = sport ?? RANK_TEMPLATES[template].sport;
    const ranks: readonly RankTemplateRank[] = RANK_TEMPLATES[template].ranks;
    for (const rank of ranks) {
      starting.push({
        nameBg: tBg(`templates.${template}.ranks.${rank.key}`),
        nameEn: tEn(`templates.${template}.ranks.${rank.key}`),
        colour: rank.colour,
        accent: rank.accent ?? null,
        stripes: rank.stripes ?? 0,
        minAttendances: null,
        minMonths: null,
      });
    }
  }
  if (nameBg === null) return back(slug, ladderId, 'ladder_name_required');
  const saved = await saveLadder(getDb(), actor, { nameBg, nameEn, sport }, ladderId, starting);
  if (!saved.ok) return back(slug, ladderId, saved.error);
  return back(slug, saved.ladderId, ladderId === null ? 'created' : 'saved');
}

/** Archive or restore a ladder. */
export async function archiveLadderAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'ranks.manage');
  const ladderId = str(formData, 'ladderId');
  if (!isUuid(ladderId)) return back(slug, null, 'not_found');
  const archive = str(formData, 'archive') === '1';
  const ok = await setLadderArchived(getDb(), actor, ladderId, archive);
  return back(slug, ladderId, ok ? (archive ? 'archived' : 'restored') : 'not_allowed');
}

/** A new rank at the end of the ladder, or a rank's edits. */
export async function saveRankAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'ranks.manage');
  const ladderId = str(formData, 'ladderId');
  if (!isUuid(ladderId)) return back(slug, null, 'not_found');
  const rawRank = str(formData, 'rankId');
  const rankId = isUuid(rawRank) ? rawRank : null;
  const parsed = parseRank(formData);
  if (!parsed.ok) return back(slug, ladderId, parsed.errors[0] ?? 'invalid');
  const saved = await saveRank(getDb(), actor, ladderId, parsed.value, rankId);
  return back(slug, ladderId, saved.ok ? 'rankSaved' : saved.error);
}

/** One place up or down. */
export async function moveRankAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'ranks.manage');
  const ladderId = str(formData, 'ladderId');
  const rankId = str(formData, 'rankId');
  if (!isUuid(ladderId) || !isUuid(rankId)) return back(slug, null, 'not_found');
  const direction = str(formData, 'direction') === 'down' ? 'down' : 'up';
  const moved = await moveRank(getDb(), actor, rankId, direction);
  return back(slug, ladderId, moved ? 'rankMoved' : 'not_allowed');
}

/** Remove a rank nobody was ever awarded. */
export async function removeRankAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'ranks.manage');
  const ladderId = str(formData, 'ladderId');
  const rankId = str(formData, 'rankId');
  if (!isUuid(ladderId) || !isUuid(rankId)) return back(slug, null, 'not_found');
  const removed = await removeRank(getDb(), actor, rankId);
  return back(slug, ladderId, removed.ok ? 'rankRemoved' : removed.error);
}

/** An exam day: the ticked clients' next ranks (or the first, for a new client). */
export async function awardNextAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'ranks.award');
  const ladderId = str(formData, 'ladderId');
  if (!isUuid(ladderId)) return back(slug, null, 'not_found');
  const picks = parseNextAwardPicks(formData);
  if (!picks.ok) return back(slug, ladderId, picks.errors[0] ?? 'invalid');
  const award = parseAward(formData, sofiaToday());
  if (!award.ok) return back(slug, ladderId, award.errors[0] ?? 'invalid');
  const result = await awardNextRanks(getDb(), actor, ladderId, picks.value, award.value);
  if (!result.ok) return back(slug, ladderId, result.error);
  return back(slug, ladderId, 'awarded', `&n=${result.awarded}&skip=${result.skipped}`);
}

/** Any rank to one client — from the member card or a ladder's row. */
export async function awardOneAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'ranks.award');
  const memberId = str(formData, 'memberId');
  const rankId = str(formData, 'rankId');
  const raw = str(formData, 'ladderId');
  const ladderId = isUuid(raw) ? raw : null;
  if (!isUuid(memberId)) return back(slug, null, 'not_found');
  const done = (code: string) =>
    ladderId === null ? card(slug, memberId, code) : back(slug, ladderId, code);
  if (!isUuid(rankId)) return done('rank_invalid');
  const award = parseAward(formData, sofiaToday());
  if (!award.ok) return done(award.errors[0] ?? 'invalid');
  const result = await awardRank(getDb(), actor, memberId, rankId, award.value);
  return done(result.ok ? 'awardedOne' : result.error);
}

/** Revoke a mistaken award — from the member card or a ladder's row. */
export async function revokeAwardAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'ranks.award');
  const awardId = str(formData, 'awardId');
  const memberId = str(formData, 'memberId');
  const raw = str(formData, 'ladderId');
  const ladderId = isUuid(raw) ? raw : null;
  if (!isUuid(awardId) || !isUuid(memberId)) return back(slug, null, 'not_found');
  const revoked = await revokeAward(getDb(), actor, awardId);
  const code = revoked ? 'revoked' : 'not_allowed';
  return ladderId === null ? card(slug, memberId, code) : back(slug, ladderId, code);
}
