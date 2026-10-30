import { createHash } from 'node:crypto';

import { getDb, getPool, sql } from '@sportkarta/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  documentForStaff,
  listDocuments,
  memberDocuments,
  missingFor,
  portalDocuments,
  publishVersion,
  saveDocument,
  setDocumentArchived,
  signAtDesk,
  signatureForPrint,
  signInPortal,
} from '@/lib/clubs/documents';
import { clubExportCsv } from '@/lib/clubs/export';
import type { DocumentInput, DocumentVersionInput } from '@/lib/clubs/input';
import { eraseMember } from '@/lib/clubs/members';
import type { ClubActor } from '@/lib/clubs/scope';

import { hasDb } from './db';

vi.mock('server-only', () => ({}));

/**
 * Documents and waivers (0055), end to end against real Postgres. What must
 * hold:
 *
 *   * management writes documents; the front of house takes a signature at
 *     the desk (and is its witness); a trainer does neither; another club
 *     sees nothing;
 *   * a client signs their own record from the portal, a guardian a child's —
 *     the kind decided from the link, never sent;
 *   * the database numbers and hashes every version (the hash recomputes from
 *     the stored text), signs only the latest version of a live document, and
 *     never edits a signature or a version;
 *   * who is missing what follows the document's audience and its latest
 *     version that needs a new signature;
 *   * erasing the client takes their signatures; the purge takes the rest.
 *
 * COMMITS under its own `e2e-jd-*` clubs and `e2e_club_jd_*` accounts,
 * removed through the real purge path.
 */

const PREFIX = 'e2e_club_jd_';

async function cleanup(): Promise<void> {
  const db = getDb();
  const clubs = await db.execute(sql`SELECT id FROM clubs WHERE slug LIKE 'e2e-jd-%'`);
  for (const row of clubs.rows) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('pops.purging_club', ${String(row.id)}, true)`);
      await tx.execute(sql`DELETE FROM clubs WHERE id = ${String(row.id)}::uuid`);
    });
  }
  await db.execute(sql`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`);
}

/** The error a raw statement fails with — it must fail. */
async function refusal(text: string, values: unknown[]): Promise<{ constraint?: string }> {
  try {
    await getPool().query(text, values);
  } catch (error) {
    return error as { constraint?: string };
  }
  throw new Error(`not refused: ${text}`);
}

const WAIVER: DocumentInput = { kind: 'waiver', requiredFor: 'all' };
const TEXT_1: DocumentVersionInput = {
  titleBg: 'Декларация за здравословно състояние',
  titleEn: 'Health declaration',
  bodyBg: 'Декларирам, че съм в добро здраве.\nНяма да тренирам, ако се чувствам зле.',
  bodyEn: 'I declare that I am in good health.',
  requiresResign: true,
};

describe.skipIf(!hasDb)('club documents journey (requires running database)', () => {
  let db: ReturnType<typeof getDb>;
  let clubId = '';
  let owner: ClubActor;
  let desk: ClubActor;
  let trainer: ClubActor;

  async function account(label: string): Promise<string> {
    const id = `${PREFIX}${label}_${Math.random().toString(36).slice(2, 8)}`;
    await db.execute(sql`
      INSERT INTO users (id, display_name, email, email_verified)
      VALUES (${id}, ${`Клиент ${label}`}, ${`${id}@example.org`}, true)
    `);
    return id;
  }

  async function staff(role: 'desk' | 'trainer'): Promise<ClubActor> {
    const userId = await account(role);
    await db.execute(sql`
      INSERT INTO club_staff (club_id, user_id, role) VALUES (${clubId}::uuid, ${userId}, ${role})
    `);
    return { userId, clubId, role, ngoAdmin: false };
  }

  /** A client record, linked to a new account unless it is a child. */
  async function client(
    label: string,
    options: { guardian?: string } = {},
  ): Promise<{ memberId: string; userId: string | null }> {
    const created = await db.execute(sql`
      INSERT INTO club_members (club_id, display_name, is_minor, guardian_member_id)
      VALUES (${clubId}::uuid, ${`Клиент ${label}`}, ${options.guardian !== undefined},
              ${options.guardian ?? null}::uuid)
      RETURNING id
    `);
    const memberId = String(created.rows[0]?.id);
    if (options.guardian !== undefined) return { memberId, userId: null };
    const userId = await account(label);
    await db.execute(sql`
      INSERT INTO club_member_links (member_id, club_id, user_id, status, method)
      VALUES (${memberId}::uuid, ${clubId}::uuid, ${userId}, 'active', 'claim')
    `);
    return { memberId, userId };
  }

  beforeAll(async () => {
    db = getDb();
    await cleanup();
    const ownerId = await account('owner');
    const club = await db.execute(sql`
      INSERT INTO clubs (slug, name_bg, tier, status, approved_at, paid_until, visible)
      VALUES (${`e2e-jd-${Math.random().toString(36).slice(2, 8)}`}, 'Клуб Документи',
              'community', 'active', now(), (now() + interval '1 year')::date, true)
      RETURNING id
    `);
    clubId = String(club.rows[0]?.id);
    await db.execute(sql`
      INSERT INTO club_staff (club_id, user_id, role) VALUES (${clubId}::uuid, ${ownerId}, 'owner')
    `);
    owner = { userId: ownerId, clubId, role: 'owner', ngoAdmin: false };
    desk = await staff('desk');
    trainer = await staff('trainer');
  });

  afterAll(async () => {
    await cleanup();
    await getPool().end();
  });

  it('asks every client for a waiver, and takes signatures from the portal and the desk', async () => {
    const anna = await client('anna');
    const boris = await client('boris');
    const child = await client('dete', { guardian: anna.memberId });
    const annaUser = String(anna.userId);

    // Only management writes a document.
    expect(await saveDocument(db, trainer, WAIVER, null, TEXT_1)).toEqual({
      ok: false,
      error: 'not_allowed',
    });
    expect(await saveDocument(db, desk, WAIVER, null, TEXT_1)).toEqual({
      ok: false,
      error: 'not_allowed',
    });
    const saved = await saveDocument(db, owner, WAIVER, null, TEXT_1);
    if (!saved.ok) throw new Error('not saved');
    const documentId = saved.documentId;

    const listed = (await listDocuments(owner, 'bg')).find((d) => d.id === documentId);
    expect(listed).toMatchObject({ version: 1, signed: 0, missing: 3 });
    expect(await missingFor(owner, [anna.memberId, boris.memberId, child.memberId])).toEqual(
      new Set([anna.memberId, boris.memberId, child.memberId]),
    );

    // The database numbered and hashed the text it stored.
    const detail = await documentForStaff(owner, documentId, 'bg');
    const v1 = detail?.versions[0];
    expect(v1?.version).toBe(1);
    // sha256( H(title_bg) || H(title_en) || H(body_bg) || H(body_en) ), '' for none.
    const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest();
    expect(v1?.sha256).toBe(
      createHash('sha256')
        .update(
          Buffer.concat([
            digest(TEXT_1.titleBg),
            digest(TEXT_1.titleEn ?? ''),
            digest(TEXT_1.bodyBg),
            digest(TEXT_1.bodyEn ?? ''),
          ]),
        )
        .digest('hex'),
    );
    if (!v1) throw new Error('no version');

    // Anna signs her own record and, as its guardian, her child's.
    const portal = await portalDocuments(annaUser, clubId, 'en');
    expect(portal.map((p) => [p.memberId, p.own, p.missing])).toEqual(
      expect.arrayContaining([
        [anna.memberId, true, true],
        [child.memberId, false, true],
      ]),
    );
    expect(portal.find((p) => p.memberId === anna.memberId)?.body).toBe(TEXT_1.bodyEn);
    expect(
      await signInPortal(db, annaUser, clubId, anna.memberId, documentId, v1.id, 'Анна Иванова'),
    ).toEqual({ ok: true });
    expect(
      await signInPortal(db, annaUser, clubId, child.memberId, documentId, v1.id, 'Анна Иванова'),
    ).toEqual({ ok: true });
    // Not somebody else's record.
    expect(
      await signInPortal(db, annaUser, clubId, boris.memberId, documentId, v1.id, 'Анна'),
    ).toEqual({ ok: false, error: 'not_allowed' });
    // Signing again is the same signature, not a second one.
    expect(
      await signInPortal(db, annaUser, clubId, anna.memberId, documentId, v1.id, 'Анна Иванова'),
    ).toEqual({ ok: false, error: 'already_signed' });
    const kinds = await db.execute(sql`
      SELECT member_id, signer_kind, method, witnessed_by, body_sha256
        FROM club_document_signatures WHERE document_id = ${documentId}::uuid
    `);
    expect(
      Object.fromEntries(kinds.rows.map((r) => [String(r.member_id), String(r.signer_kind)])),
    ).toEqual({ [anna.memberId]: 'self', [child.memberId]: 'guardian' });
    expect(kinds.rows.every((r) => r.body_sha256 === v1.sha256 && r.witnessed_by === null)).toBe(
      true,
    );

    // The desk witnesses Boris's; a trainer may not.
    expect(
      await signAtDesk(db, trainer, boris.memberId, documentId, v1.id, { signerName: 'Борис' }),
    ).toEqual({ ok: false, error: 'not_allowed' });
    // A guardian signs a minor's record, and only a minor's — whoever writes.
    const signRaw = (memberId: string, kind: string) =>
      refusal(
        `INSERT INTO club_document_signatures (club_id, document_id, version_id, member_id,
           signer_kind, signer_name, method, body_sha256)
         VALUES ($1, $2, $3, $4, $5, 'Някой', 'portal', repeat('0', 64))`,
        [clubId, documentId, v1.id, memberId, kind],
      );
    expect((await signRaw(boris.memberId, 'guardian')).constraint).toBe(
      'club_document_signatures_guardian_minor',
    );
    expect((await signRaw(child.memberId, 'self')).constraint).toBe(
      'club_document_signatures_guardian_minor',
    );
    expect(
      await signAtDesk(db, desk, boris.memberId, documentId, v1.id, { signerName: 'Борис Петров' }),
    ).toEqual({ ok: true });
    expect(await missingFor(owner, [anna.memberId, boris.memberId, child.memberId])).toEqual(
      new Set(),
    );

    // A typo fix needs no new signature; a changed clause does.
    expect(
      await publishVersion(db, owner, documentId, {
        ...TEXT_1,
        bodyBg: `${TEXT_1.bodyBg} `,
        requiresResign: false,
      }),
    ).toBe(2);
    expect(await missingFor(owner, [boris.memberId])).toEqual(new Set());
    // ... and only the latest version is signed.
    expect(
      await signAtDesk(db, desk, boris.memberId, documentId, v1.id, { signerName: 'Борис Петров' }),
    ).toEqual({ ok: false, error: 'stale_version' });
    expect(
      await publishVersion(db, owner, documentId, {
        titleBg: 'Декларация и отказ от претенции',
        titleEn: null,
        bodyBg: 'Нов текст с нова клауза.',
        bodyEn: null,
        requiresResign: true,
      }),
    ).toBe(3);
    expect(await missingFor(owner, [anna.memberId, boris.memberId])).toEqual(
      new Set([anna.memberId, boris.memberId]),
    );
    const card = await memberDocuments(owner, boris.memberId, 'bg');
    expect(card.find((d) => d.documentId === documentId)).toMatchObject({
      version: 3,
      missing: true,
      lastSigned: { version: 1, method: 'desk', signerName: 'Борис Петров' },
    });

    // The print view carries the exact text signed; another club sees nothing.
    const signatureId = String(card[0]?.lastSigned?.id);
    const printed = await signatureForPrint(owner, signatureId);
    expect(printed).toMatchObject({ version: 1, bodyBg: TEXT_1.bodyBg, sha256: v1.sha256 });
    // ... under the title it was signed with, though the document was renamed since.
    expect(printed?.documentTitle).toBe(TEXT_1.titleBg);
    expect((await listDocuments(owner, 'bg')).find((d) => d.id === documentId)?.titleBg).toBe(
      'Декларация и отказ от претенции',
    );
    const csv = await clubExportCsv(owner, 'signatures');
    expect(csv.split('\n')[0]).toContain('signer_name');
    expect(csv).toContain('Борис Петров');

    // A signature and a version never change.
    expect(
      (
        await refusal(`UPDATE club_document_signatures SET signer_name = 'друг' WHERE id = $1`, [
          signatureId,
        ])
      ).constraint,
    ).toBe('club_document_signatures_fixed');
    expect(
      (await refusal(`DELETE FROM club_document_signatures WHERE id = $1`, [signatureId]))
        .constraint,
    ).toBe('club_document_signatures_fixed');
    expect(
      (await refusal(`UPDATE club_document_versions SET body_bg = 'друго' WHERE id = $1`, [v1.id]))
        .constraint,
    ).toBe('club_document_versions_fixed');

    // Archived, it asks nobody and cannot be signed; restored, it asks again.
    expect(await setDocumentArchived(db, owner, documentId, true)).toBe(true);
    expect(await missingFor(owner, [anna.memberId, boris.memberId])).toEqual(new Set());
    const v3 = (await documentForStaff(owner, documentId, 'bg'))?.versions[0];
    expect(
      await signAtDesk(db, desk, boris.memberId, documentId, String(v3?.id), {
        signerName: 'Борис Петров',
      }),
    ).toEqual({ ok: false, error: 'stale_version' });
    expect(await setDocumentArchived(db, owner, documentId, false)).toBe(true);

    // Erasing a client takes their signatures with the record.
    expect(await eraseMember(db, owner, boris.memberId)).toBe('ok');
    const left = await db.execute(sql`
      SELECT count(*)::int AS n FROM club_document_signatures WHERE id = ${signatureId}::uuid
    `);
    expect(left.rows[0]?.n).toBe(0);
  });

  it('lets only the right person sign, and offers only what a record is asked', async () => {
    const parent = await client('roditel');
    const parentUser = String(parent.userId);
    const child = await client('dete2', { guardian: parent.memberId });
    // A teenager with an account of their own, on a record the desk marked minor.
    const teen = await client('tiyneydzhar', { guardian: parent.memberId });
    const teenUser = await account('tiyneydzhar_akaunt');
    await db.execute(sql`
      INSERT INTO club_member_links (member_id, club_id, user_id, status, method)
      VALUES (${teen.memberId}::uuid, ${clubId}::uuid, ${teenUser}, 'active', 'claim')
    `);
    const stranger = await client('drug_roditel');
    const saved = await saveDocument(db, owner, WAIVER, null, {
      ...TEXT_1,
      titleBg: 'Правила на залата',
    });
    if (!saved.ok) throw new Error('not saved');
    const documentId = saved.documentId;
    const v1 = (await documentForStaff(owner, documentId, 'bg'))?.versions[0];
    if (!v1) throw new Error('no version');
    const signaturesOf = async (memberId: string) =>
      (
        await db.execute(sql`
          SELECT signer_kind, method FROM club_document_signatures
           WHERE document_id = ${documentId}::uuid AND member_id = ${memberId}::uuid
        `)
      ).rows;

    // A minor's own account reads the document and never signs it.
    const teenView = (await portalDocuments(teenUser, clubId, 'bg')).find(
      (d) => d.documentId === documentId && d.memberId === teen.memberId,
    );
    expect(teenView).toMatchObject({ own: true, canSign: false, missing: true });
    expect(
      await signInPortal(db, teenUser, clubId, teen.memberId, documentId, v1.id, 'Тийнейджър'),
    ).toEqual({ ok: false, error: 'not_allowed' });
    expect(await signaturesOf(teen.memberId)).toEqual([]);
    // Another family's parent signs nobody's child but their own.
    expect(
      await signInPortal(
        db,
        String(stranger.userId),
        clubId,
        child.memberId,
        documentId,
        v1.id,
        'Чужд',
      ),
    ).toEqual({ ok: false, error: 'not_allowed' });

    // The guardian signs the child's; the desk witnesses the teenager's — as a
    // guardian's, whatever the form said.
    expect(
      await signInPortal(db, parentUser, clubId, child.memberId, documentId, v1.id, 'Родител'),
    ).toEqual({ ok: true });
    expect(
      await signAtDesk(db, desk, teen.memberId, documentId, v1.id, { signerName: 'Родител' }),
    ).toEqual({ ok: true });
    expect(await signaturesOf(teen.memberId)).toEqual([
      { signer_kind: 'guardian', method: 'desk' },
    ]);
    // Signed again: the desk is told so (its witness was not recorded).
    expect(
      await signAtDesk(db, desk, teen.memberId, documentId, v1.id, { signerName: 'Родител' }),
    ).toEqual({ ok: false, error: 'already_signed' });

    // An NGO admin reads a club and never witnesses for it.
    const ngoId = await account('ngo');
    await db.execute(sql`UPDATE users SET role = 'admin' WHERE id = ${ngoId}`);
    const ngo: ClubActor = { userId: ngoId, clubId, role: null, ngoAdmin: true };
    expect(
      await signAtDesk(db, ngo, parent.memberId, documentId, v1.id, { signerName: 'Родител' }),
    ).toEqual({ ok: false, error: 'not_allowed' });

    // The portal signs only the latest version.
    await publishVersion(db, owner, documentId, { ...TEXT_1, titleBg: 'Правила на залата 2' });
    const v2 = (await documentForStaff(owner, documentId, 'bg'))?.versions[0];
    if (!v2) throw new Error('no version 2');
    expect(
      await signInPortal(db, parentUser, clubId, parent.memberId, documentId, v1.id, 'Родител'),
    ).toEqual({ ok: false, error: 'stale_version' });

    // A closed club takes no signature, from the portal or the desk.
    await db.execute(
      sql`UPDATE clubs SET status = 'suspended', suspended_at = now() WHERE id = ${clubId}::uuid`,
    );
    try {
      expect(
        await signInPortal(db, parentUser, clubId, parent.memberId, documentId, v2.id, 'Родител'),
      ).toEqual({ ok: false, error: 'not_allowed' });
      expect(
        await signAtDesk(db, desk, parent.memberId, documentId, v2.id, { signerName: 'Родител' }),
      ).toEqual({ ok: false, error: 'not_allowed' });
    } finally {
      await db.execute(
        sql`UPDATE clubs SET status = 'active', suspended_at = NULL WHERE id = ${clubId}::uuid`,
      );
    }

    // A minors' consent is offered for the child, never for the parent.
    const consent = await saveDocument(
      db,
      owner,
      { kind: 'consent', requiredFor: 'minors' },
      null,
      { ...TEXT_1, titleBg: 'Съгласие на родител 2' },
    );
    if (!consent.ok) throw new Error('not saved');
    const offered = (await portalDocuments(parentUser, clubId, 'bg')).filter(
      (d) => d.documentId === consent.documentId,
    );
    expect(offered.map((d) => d.memberId).sort()).toEqual([child.memberId, teen.memberId].sort());

    // Erasing the guardian's record keeps what they signed for the child.
    expect(
      await signInPortal(db, parentUser, clubId, parent.memberId, documentId, v2.id, 'Родител'),
    ).toEqual({ ok: true });
    expect(await eraseMember(db, owner, parent.memberId)).toBe('ok');
    expect(await signaturesOf(parent.memberId)).toEqual([]);
    expect(await signaturesOf(child.memberId)).toEqual([
      { signer_kind: 'guardian', method: 'portal' },
    ]);
  });

  it('asks only the audience a document names', async () => {
    const adult = await client('vazrasten');
    const minor = await client('malak', { guardian: adult.memberId });
    const trial = await client('proben');
    const plan = await db.execute(sql`
      INSERT INTO club_plans (club_id, name_bg, kind, price_cents, validity_days)
      VALUES (${clubId}::uuid, 'Пробна', 'trial', 0, 7) RETURNING id
    `);
    await db.execute(sql`
      INSERT INTO club_memberships (club_id, member_id, plan_id, plan_name, kind, audience,
                                    price_cents, starts_on, ends_on)
      VALUES (${clubId}::uuid, ${trial.memberId}::uuid, ${String(plan.rows[0]?.id)}::uuid,
              'Пробна', 'trial', 'all', 0, current_date, current_date + 7)
    `);
    // A trial abonnement cancelled as a mistake asks for nothing.
    const mistaken = await client('greshka');
    await db.execute(sql`
      INSERT INTO club_memberships (club_id, member_id, plan_id, plan_name, kind, audience,
                                    price_cents, starts_on, ends_on, cancelled_at, cancel_reason)
      VALUES (${clubId}::uuid, ${mistaken.memberId}::uuid, ${String(plan.rows[0]?.id)}::uuid,
              'Пробна', 'trial', 'all', 0, current_date, current_date + 7, now(), 'mistake')
    `);
    const minors = await saveDocument(db, owner, { kind: 'consent', requiredFor: 'minors' }, null, {
      ...TEXT_1,
      titleBg: 'Съгласие на родител',
    });
    const trials = await saveDocument(db, owner, { kind: 'rules', requiredFor: 'trial' }, null, {
      ...TEXT_1,
      titleBg: 'Правила за пробна тренировка',
    });
    if (!minors.ok || !trials.ok) throw new Error('not saved');
    const missing = await db.execute(sql`
      SELECT document_id, member_id FROM club_documents_missing
       WHERE document_id IN (${minors.documentId}::uuid, ${trials.documentId}::uuid)
         AND member_id IN (${adult.memberId}::uuid, ${minor.memberId}::uuid,
                           ${mistaken.memberId}::uuid,
                           ${trial.memberId}::uuid)
    `);
    expect(
      missing.rows.map((r) => `${String(r.document_id)}:${String(r.member_id)}`).sort(),
    ).toEqual(
      [`${minors.documentId}:${minor.memberId}`, `${trials.documentId}:${trial.memberId}`].sort(),
    );
  });

  it('shows another club nothing', async () => {
    const otherOwner = await account('owner2');
    const other = await db.execute(sql`
      INSERT INTO clubs (slug, name_bg, tier, status, approved_at, paid_until)
      VALUES (${`e2e-jd-${Math.random().toString(36).slice(2, 8)}`}, 'Друг', 'community',
              'active', now(), (now() + interval '1 year')::date)
      RETURNING id
    `);
    const otherClub = String(other.rows[0]?.id);
    await db.execute(sql`
      INSERT INTO club_staff (club_id, user_id, role)
      VALUES (${otherClub}::uuid, ${otherOwner}, 'owner')
    `);
    const stranger: ClubActor = {
      userId: otherOwner,
      clubId: otherClub,
      role: 'owner',
      ngoAdmin: false,
    };
    const ours = (await listDocuments(owner, 'bg'))[0];
    if (!ours) throw new Error('no document');
    expect(await listDocuments(stranger, 'bg')).toEqual([]);
    expect(await documentForStaff(stranger, ours.id, 'bg')).toBeNull();
    expect(await setDocumentArchived(db, stranger, ours.id, true)).toBe(false);
    const someone = await client('chuzhd');
    const version = (await documentForStaff(owner, ours.id, 'bg'))?.versions[0];
    expect(
      await signAtDesk(db, stranger, someone.memberId, ours.id, String(version?.id), {
        signerName: 'Някой',
      }),
    ).toEqual({ ok: false, error: 'not_allowed' });
  });
});
