import { sql, type SQL } from '@sportkarta/db';
import { clubSlugFrom, nextFreeClubSlug } from '@sportkarta/lib/clubs';

import { recordClubAudit } from './audit';
import { violatedConstraint } from './errors';
import type { ApplicationInput } from './input';

/**
 * A club application (/klubove/zayavka, decision 2026-10-24: "any club").
 *
 * The applicant is signed in, so their account becomes the club's OWNER in the
 * same transaction that creates the club — there is no ownerless moment and no
 * separate "claim your club" step. The club starts `pending`: the office opens
 * read-only with the onboarding checklist, nothing is public, and the operator
 * approves it from /admin/klubove (which starts the trial — every tier is paid).
 *
 * Spam is bounded structurally rather than by a captcha: one PENDING
 * application per account at a time and at most five clubs owned per account.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

export const MAX_CLUBS_PER_OWNER = 5;

export type ApplyResult =
  { ok: true; clubId: string; slug: string } | { ok: false; error: 'already_pending' | 'too_many' };

export async function applyForClub(
  db: TransactionalDb,
  userId: string,
  input: ApplicationInput,
): Promise<ApplyResult> {
  // The slug race (two applicants, one name, same instant) is a unique
  // violation on clubs_slug_unique; one retry with a fresh read settles it.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        // Serialise one person's applications: two tabs submitting at once
        // must not both pass the "one pending" check below.
        await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR NO KEY UPDATE`);
        const owned = await tx.execute(sql`
          SELECT count(*)::int AS owned,
                 count(*) FILTER (WHERE c.status = 'pending')::int AS pending
            FROM club_staff s JOIN clubs c ON c.id = s.club_id
           WHERE s.user_id = ${userId} AND s.role = 'owner' AND c.status <> 'archived'
        `);
        const counts = owned.rows[0] ?? {};
        if (Number(counts.pending ?? 0) > 0)
          return { ok: false, error: 'already_pending' } as const;
        if (Number(counts.owned ?? 0) >= MAX_CLUBS_PER_OWNER) {
          return { ok: false, error: 'too_many' } as const;
        }

        const base = clubSlugFrom(input.nameBg);
        const taken = await tx.execute(sql`
          SELECT slug FROM clubs WHERE slug = ${base} OR slug LIKE ${`${base}-%`}
        `);
        const slug = nextFreeClubSlug(base, new Set(taken.rows.map((r) => String(r.slug))));

        const created = await tx.execute(sql`
          INSERT INTO clubs (slug, name_bg, kind, tier, municipality_id, sports, website_url,
                             description_bg)
          VALUES (${slug}, ${input.nameBg}, ${input.kind}, ${input.tier}, ${input.municipalityId},
                  ${sql.param(input.sports)}::text[], ${input.websiteUrl}, ${input.descriptionBg})
          RETURNING id
        `);
        const clubId = String(created.rows[0]?.id);
        await tx.execute(sql`
          INSERT INTO club_staff (club_id, user_id, role) VALUES (${clubId}::uuid, ${userId}, 'owner')
        `);
        await recordClubAudit(tx, {
          clubId,
          by: { kind: 'staff', actor: { userId, clubId, role: 'owner', ngoAdmin: false } },
          action: 'club_applied',
          detail: { tier: input.tier },
        });
        return { ok: true, clubId, slug } as const;
      });
    } catch (error: unknown) {
      const retry = attempt === 0 && violatedConstraint(error) === 'clubs_slug_unique';
      if (!retry) throw error;
    }
  }
  throw new Error('unreachable: slug retry exhausted');
}
