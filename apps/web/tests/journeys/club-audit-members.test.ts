import { getDb, getPool, memberRecipient, sql } from '@sportkarta/db';
import { sofiaToday } from '@sportkarta/lib/clubs';
import { generateInviteToken, sha256Hex } from '@sportkarta/lib/clubs/secrets';
import { MemoryMailer } from '@sportkarta/lib/email';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  commitClubImport,
  guessClubMapping,
  parseClubCsv,
  previewClubImport,
  rowsFromClubCsv,
} from '@/lib/clubs/import';
import { listThreads, sendInquiry, threadForStaff, writeAsMember } from '@/lib/clubs/inbox';
import type { MemberInput } from '@/lib/clubs/input';
import { issueInvoice } from '@/lib/clubs/invoices';
import {
  acceptMemberInvite,
  inviteMemberToLink,
  memberInviteByToken,
  setLinkPreference,
  unlinkRecord,
} from '@/lib/clubs/links';
import {
  createMember,
  eraseMember,
  listMembers,
  setMemberArchived,
  updateMember,
} from '@/lib/clubs/members';
import type { ClubActor } from '@/lib/clubs/scope';
import { saveInvoiceDetails } from '@/lib/clubs/settings';

import { runClubNotify } from '../../../worker/src/club-mail-job';

import { hasDb } from './db';

vi.mock('server-only', () => ({}));

/**
 * The club audit of 2026-11-14, the members half — the app's own functions
 * and the worker's own sender against real Postgres. What must hold:
 *
 *   * C5  a member who muted club mail stays muted after the link is removed,
 *         and their own switch is the way back;
 *   * C3  an invitation dies with the address it was sent to: changing the
 *         record's e-mail or archiving it revokes it, acceptance reads the
 *         record as it is NOW, and never takes a record another account holds;
 *   * A5  erasing a client voids what they still owed (nobody could ever void
 *         it afterwards) and leaves charges with money on them alone;
 *   * C1  the same file imported twice makes one child, one abonnement, one
 *         charge — and POPS's own exported phone column imports (C11);
 *   * C10 the list's «at risk» chip is the segment's rule;
 *   * D2  one member's new conversations mail the staff once a day, and every
 *         one of them is still in the office inbox.
 *
 * COMMITS under its own `e2e-am-*` club and `e2e_club_am_*` accounts, removed
 * through the real purge path.
 */

const PREFIX = 'e2e_club_am_';

async function cleanup(): Promise<void> {
  const db = getDb();
  const clubs = await db.execute(sql`SELECT id FROM clubs WHERE slug LIKE 'e2e-am-%'`);
  for (const row of clubs.rows) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('pops.purging_club', ${String(row.id)}, true)`);
      await tx.execute(sql`DELETE FROM clubs WHERE id = ${String(row.id)}::uuid`);
    });
  }
  await db.execute(sql`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`);
}

describe.skipIf(!hasDb)('club members, audit 2026-11-14 (requires running database)', () => {
  let db: ReturnType<typeof getDb>;
  let clubId = '';
  let owner: ClubActor;
  let desk: ClubActor;
  let planId = '';

  const addressOf = (userId: string) => `${userId}@example.org`;

  async function account(label: string): Promise<string> {
    const id = `${PREFIX}${label}_${Math.random().toString(36).slice(2, 8)}`;
    await db.execute(sql`
      INSERT INTO users (id, display_name, email, email_verified)
      VALUES (${id}, ${`Одит ${label}`}, ${addressOf(id)}, true)
    `);
    return id;
  }

  const input = (fields: Partial<MemberInput> & { displayName: string }): MemberInput => ({
    email: null,
    phone: null,
    isMinor: false,
    guardianMemberId: null,
    tags: [],
    staffNote: null,
    ...fields,
  });

  /** A record the desk made, with this address. */
  async function record(name: string, email: string | null): Promise<string> {
    const created = await createMember(db, desk, input({ displayName: name, email }));
    if (!created.ok) throw new Error(created.error);
    return created.memberId;
  }

  /** An account with its own record here, linked — a member who can open the portal. */
  async function member(label: string): Promise<{ userId: string; memberId: string }> {
    const userId = await account(label);
    const memberId = await record(`Член ${label}`, addressOf(userId));
    await db.execute(sql`
      INSERT INTO club_member_links (member_id, club_id, user_id, status, method)
      VALUES (${memberId}::uuid, ${clubId}::uuid, ${userId}, 'active', 'invite')
    `);
    return { userId, memberId };
  }

  /** What the worker does when it mails an invite: mint a token, keep its hash. */
  async function invite(memberId: string): Promise<{ inviteId: string; token: string }> {
    const invited = await inviteMemberToLink(db, desk, memberId);
    if (!invited.ok) throw new Error(invited.error);
    const token = generateInviteToken();
    await db.execute(sql`
      UPDATE club_member_invites SET token_hash = ${sha256Hex(token)}
       WHERE id = ${invited.inviteId}::uuid
    `);
    return { inviteId: invited.inviteId, token };
  }

  const inviteRevoked = async (inviteId: string): Promise<boolean> =>
    (
      await db.execute(sql`
        SELECT revoked_at IS NOT NULL AS revoked FROM club_member_invites
         WHERE id = ${inviteId}::uuid
      `)
    ).rows[0]?.revoked === true;

  const linkHolder = async (memberId: string): Promise<string | null> => {
    const row = (
      await db.execute(sql`
        SELECT user_id FROM club_member_links
         WHERE member_id = ${memberId}::uuid AND status = 'active'
      `)
    ).rows[0];
    return row ? String(row.user_id) : null;
  };

  const optedOut = async (memberId: string): Promise<boolean> =>
    (
      await db.execute(sql`
        SELECT email_opt_out_at IS NOT NULL AS opted FROM club_members
         WHERE id = ${memberId}::uuid
      `)
    ).rows[0]?.opted === true;

  /** An abonnement of the audit plan that began `daysAgo` days ago (Sofia). */
  async function abonnement(memberId: string, daysAgo: number): Promise<void> {
    await db.execute(sql`
      INSERT INTO club_memberships (club_id, member_id, plan_id, plan_name, kind, audience,
                                    price_cents, visits_total, starts_on, ends_on)
      SELECT p.club_id, ${memberId}::uuid, p.id, p.name_bg, p.kind, p.audience, p.price_cents,
             p.visits_count, (now() AT TIME ZONE 'Europe/Sofia')::date - ${daysAgo}::int,
             (now() AT TIME ZONE 'Europe/Sofia')::date - ${daysAgo}::int + 89
        FROM club_plans p WHERE p.id = ${planId}::uuid
    `);
  }

  beforeAll(async () => {
    db = getDb();
    await cleanup();
    const ownerId = await account('owner');
    const club = await db.execute(sql`
      INSERT INTO clubs (slug, name_bg, tier, status, approved_at, paid_until, mail_unlinked_members)
      VALUES (${`e2e-am-${Math.random().toString(36).slice(2, 8)}`}, 'Клуб Одит', 'standard',
              'active', now(), (now() + interval '1 year')::date, true)
      RETURNING id
    `);
    clubId = String(club.rows[0]?.id);
    await db.execute(sql`
      INSERT INTO club_staff (club_id, user_id, role) VALUES (${clubId}::uuid, ${ownerId}, 'owner')
    `);
    owner = { userId: ownerId, clubId, role: 'owner', ngoAdmin: false };
    const deskId = await account('desk');
    await db.execute(sql`
      INSERT INTO club_staff (club_id, user_id, role) VALUES (${clubId}::uuid, ${deskId}, 'desk')
    `);
    desk = { userId: deskId, clubId, role: 'desk', ngoAdmin: false };
    const plan = await db.execute(sql`
      INSERT INTO club_plans (club_id, name_bg, kind, price_cents, validity_months)
      VALUES (${clubId}::uuid, 'Детски одит', 'unlimited', 2000, 1)
      RETURNING id
    `);
    planId = String(plan.rows[0]?.id);
  });

  afterAll(async () => {
    await cleanup();
    await getPool().end();
  });

  // ─── C5 ────────────────────────────────────────────────────────────────────

  it('C5 — keeps a member who muted club mail muted after the link is removed', async () => {
    // The club mails records without an account (set at creation): the trap.
    const muted = await member('muted');
    expect(await setLinkPreference(muted.userId, muted.memberId, 'notify', false)).toBe(true);
    expect(await memberRecipient(db, clubId, muted.memberId)).toBeNull();
    expect(await unlinkRecord(db, { kind: 'member', userId: muted.userId }, muted.memberId)).toBe(
      true,
    );
    // The link row is gone; the «no» it carried is now on the record.
    expect(await optedOut(muted.memberId)).toBe(true);
    expect(await memberRecipient(db, clubId, muted.memberId)).toBeNull();

    // The same when the desk removes the link.
    const byDesk = await member('muteddesk');
    await setLinkPreference(byDesk.userId, byDesk.memberId, 'notify', false);
    expect(await unlinkRecord(db, { kind: 'staff', actor: desk }, byDesk.memberId)).toBe(true);
    expect(await optedOut(byDesk.memberId)).toBe(true);
    expect(await memberRecipient(db, clubId, byDesk.memberId)).toBeNull();

    // A member who never muted is mailed as any record without an account is.
    const loud = await member('loud');
    expect(await unlinkRecord(db, { kind: 'member', userId: loud.userId }, loud.memberId)).toBe(
      true,
    );
    expect(await optedOut(loud.memberId)).toBe(false);
    expect(await memberRecipient(db, clubId, loud.memberId)).toMatchObject({
      linked: false,
      email: addressOf(loud.userId),
    });
  });

  it('C5 — honours the opt-out after a re-link, until the member’s own switch turns mail on again', async () => {
    const back = await member('back');
    await setLinkPreference(back.userId, back.memberId, 'notify', false);
    await unlinkRecord(db, { kind: 'member', userId: back.userId }, back.memberId);
    await db.execute(sql`
      INSERT INTO club_member_links (member_id, club_id, user_id, status, method)
      VALUES (${back.memberId}::uuid, ${clubId}::uuid, ${back.userId}, 'active', 'claim')
    `);
    // A fresh link says «on»; the record still says «no» — and «no» wins.
    expect(await memberRecipient(db, clubId, back.memberId)).toBeNull();
    // Switching mail on is the member's own, signed-in yes: it lifts the opt-out.
    expect(await setLinkPreference(back.userId, back.memberId, 'notify', true)).toBe(true);
    expect(await optedOut(back.memberId)).toBe(false);
    expect(await memberRecipient(db, clubId, back.memberId)).toMatchObject({
      linked: true,
      email: addressOf(back.userId),
    });
    // Somebody else's switch lifts nothing.
    const other = await member('otherswitch');
    await db.execute(sql`
      UPDATE club_members SET email_opt_out_at = now() WHERE id = ${other.memberId}::uuid
    `);
    expect(await setLinkPreference(back.userId, other.memberId, 'notify', true)).toBe(false);
    expect(await optedOut(other.memberId)).toBe(true);
  });

  // ─── C3 ────────────────────────────────────────────────────────────────────

  it('C3 — revokes an invitation when the desk corrects the address, and refuses the stale token', async () => {
    // The desk mistypes: the address belongs to a stranger, who now holds a token.
    const stranger = await account('stranger');
    const memberId = await record('Сбъркан Имейл', addressOf(stranger));
    const { inviteId, token } = await invite(memberId);
    expect((await memberInviteByToken(token))?.usable).toBe(true);

    const real = await account('real');
    expect(
      await updateMember(
        db,
        desk,
        memberId,
        input({ displayName: 'Сбъркан Имейл', email: addressOf(real) }),
      ),
    ).toMatchObject({ ok: true });
    expect(await inviteRevoked(inviteId)).toBe(true);
    expect((await memberInviteByToken(token))?.usable).toBe(false);
    expect(await acceptMemberInvite(db, stranger, token)).toEqual({ ok: false, error: 'invalid' });

    // An invitation from before this rule was never revoked: acceptance reads
    // the record's CURRENT address, so it is refused all the same.
    await db.execute(sql`
      UPDATE club_member_invites SET revoked_at = NULL WHERE id = ${inviteId}::uuid
    `);
    expect((await memberInviteByToken(token))?.usable).toBe(false);
    expect(await acceptMemberInvite(db, stranger, token)).toEqual({ ok: false, error: 'invalid' });
    expect(await linkHolder(memberId)).toBeNull();
  });

  it('C3 — keeps an invitation through an edit that leaves the address alone', async () => {
    const invited = await account('kept');
    const memberId = await record('Същият Имейл', addressOf(invited));
    const { inviteId, token } = await invite(memberId);
    expect(
      await updateMember(
        db,
        desk,
        memberId,
        input({ displayName: 'Същият Имейл', email: addressOf(invited), phone: '0888 000 111' }),
      ),
    ).toMatchObject({ ok: true });
    expect(await inviteRevoked(inviteId)).toBe(false);
    expect(await acceptMemberInvite(db, invited, token)).toMatchObject({ ok: true });
    expect(await linkHolder(memberId)).toBe(invited);
  });

  it('C3 — revokes an invitation when the record is archived', async () => {
    const invited = await account('archived');
    const memberId = await record('Архивиран', addressOf(invited));
    const { inviteId, token } = await invite(memberId);
    expect(await setMemberArchived(db, desk, memberId, true)).toBe(true);
    expect(await inviteRevoked(inviteId)).toBe(true);
    expect(await acceptMemberInvite(db, invited, token)).toEqual({ ok: false, error: 'invalid' });
    // …and one that slipped past revocation still finds an archived record closed.
    await db.execute(sql`
      UPDATE club_member_invites SET revoked_at = NULL WHERE id = ${inviteId}::uuid
    `);
    expect(await acceptMemberInvite(db, invited, token)).toEqual({ ok: false, error: 'invalid' });
    expect(await linkHolder(memberId)).toBeNull();
  });

  it('C3 — never hands a record another account holds to an invitation', async () => {
    const invited = await account('late');
    const memberId = await record('Вече Свързан', addressOf(invited));
    const { token } = await invite(memberId);
    // Meanwhile another account was linked to the record (a claim the desk approved).
    const holder = await account('holder');
    await db.execute(sql`
      INSERT INTO club_member_links (member_id, club_id, user_id, status, method)
      VALUES (${memberId}::uuid, ${clubId}::uuid, ${holder}, 'active', 'claim')
    `);
    expect(await acceptMemberInvite(db, invited, token)).toEqual({ ok: false, error: 'invalid' });
    expect(await linkHolder(memberId)).toBe(holder);
  });

  // ─── A5 ────────────────────────────────────────────────────────────────────

  it('A5 — voids what an erased client still owed, and leaves charges with money on them', async () => {
    const created = await createMember(db, owner, input({ displayName: 'За Изтриване' }));
    if (!created.ok) throw new Error(created.error);
    const memberId = created.memberId;
    const today = sofiaToday();
    const charge = async (label: string, payments: number[]): Promise<string> => {
      const row = await db.execute(sql`
        INSERT INTO club_charges (club_id, member_id, kind, label, amount_cents, issued_on, due_on)
        VALUES (${clubId}::uuid, ${memberId}::uuid, 'other', ${label}, 3000, ${today}::date,
                ${today}::date)
        RETURNING id
      `);
      const id = String(row.rows[0]?.id);
      for (const amount of payments) {
        await db.execute(sql`
          INSERT INTO club_payments (club_id, charge_id, member_id, kind, amount_cents, method,
                                     received_on, recorded_by)
          VALUES (${clubId}::uuid, ${id}::uuid, ${memberId}::uuid,
                  ${amount < 0 ? 'refund' : 'payment'}, ${amount}, 'cash', ${today}::date,
                  ${owner.userId})
        `);
      }
      return id;
    };
    const unpaid = await charge('Неплатено', []);
    const refunded = await charge('Върнато', [3000, -3000]);
    const partial = await charge('Частично', [1000]);
    const paid = await charge('Платено', [3000]);
    // An unpaid charge with a live invoice waits for its credit note, as at the desk.
    const invoiced = await charge('С фактура', []);
    await db.execute(sql`
      UPDATE clubs SET legal_name = 'Одит ЕООД', eik = '123456789' WHERE id = ${clubId}::uuid
    `);
    expect(
      await saveInvoiceDetails(db, owner, {
        legalAddress: 'София, ул. Тест 1',
        vatNumber: 'BG123456789',
        iban: 'BG80BNBG96611020345678',
        invoiceVatBp: 2000,
        zeroVatBasis: null,
      }),
    ).toBe(true);
    const issued = await issueInvoice(db, owner, {
      chargeId: invoiced,
      buyer: {
        kind: 'company',
        name: 'Фирма ООД',
        eik: '987654321',
        vatNumber: null,
        address: 'София, ул. Фирмена 2',
      },
    });
    expect(issued.ok).toBe(true);

    expect(await eraseMember(db, owner, memberId)).toBe('ok');

    const after = await db.execute(sql`
      SELECT cb.label, cb.status, cb.member_id FROM club_charge_balances cb
       WHERE cb.charge_id = ANY(${sql.param([unpaid, refunded, partial, paid, invoiced])}::uuid[])
       ORDER BY cb.label
    `);
    expect(after.rows).toEqual([
      { label: 'Върнато', status: 'void', member_id: null },
      { label: 'Неплатено', status: 'void', member_id: null },
      { label: 'Платено', status: 'paid', member_id: null },
      { label: 'С фактура', status: 'open', member_id: null },
      { label: 'Частично', status: 'partial', member_id: null },
    ]);
    // Each void is in the club's log, as a desk void is.
    const log = await db.execute(sql`
      SELECT a.detail->>'chargeId' AS charge, a.detail->>'reason' AS reason, a.actor_id
        FROM club_audit a
       WHERE a.club_id = ${clubId}::uuid AND a.action = 'charge_voided'
         AND a.detail->>'chargeId' = ANY(${sql.param([unpaid, refunded, partial, paid, invoiced])}::text[])
       ORDER BY 1
    `);
    expect(log.rows).toEqual(
      [unpaid, refunded]
        .sort()
        .map((id) => ({ charge: id, reason: 'member_erased', actor_id: owner.userId })),
    );
  });

  // ─── C1 (+ C11) ────────────────────────────────────────────────────────────

  it('C1 — imports the same file twice into one child, one abonnement, one charge', async () => {
    const csv = [
      'name;minor;guardian email;plan;paid;phone',
      'Дете Одит;да;no-such-parent@example.org;Детски одит;20 €;',
      // POPS's own export guards a `+` phone with an apostrophe (C11).
      "Възрастен Одит;;;;;'+359 888 123 456",
    ].join('\n');
    const rows = rowsFromClubCsv(csv, guessClubMapping(parseClubCsv(csv).headers));
    expect((await previewClubImport(owner, rows)).counts).toEqual({
      new: 2,
      match: 0,
      conflict: 0,
      invalid: 0,
    });
    expect(await commitClubImport(db, owner, rows, new Set())).toEqual({
      ok: true,
      result: { created: 2, updated: 0, memberships: 1, skipped: 0, invalid: 0 },
    });

    // Again: the child was left without a guardian (the e-mail named nobody),
    // so nothing ties it to the row but its name — a human's call, not a new child.
    const again = await previewClubImport(owner, rows);
    expect(again.counts).toEqual({ new: 0, match: 1, conflict: 1, invalid: 0 });
    expect(again.rows.find((r) => r.line === 2)).toMatchObject({
      status: 'conflict',
      reason: 'name_exists',
    });
    expect(await commitClubImport(db, owner, rows, new Set())).toEqual({
      ok: true,
      result: { created: 0, updated: 1, memberships: 0, skipped: 1, invalid: 0 },
    });
    const counted = await db.execute(sql`
      SELECT (SELECT count(*)::int FROM club_members m
               WHERE m.club_id = ${clubId}::uuid AND m.display_name = 'Дете Одит') AS children,
             (SELECT count(*)::int FROM club_memberships ms
                JOIN club_members m ON m.id = ms.member_id
               WHERE m.club_id = ${clubId}::uuid AND m.display_name = 'Дете Одит') AS abonnements,
             (SELECT count(*)::int FROM club_charges ch
                JOIN club_members m ON m.id = ch.member_id
               WHERE m.club_id = ${clubId}::uuid AND m.display_name = 'Дете Одит') AS charges,
             (SELECT count(*)::int FROM club_payments p
                JOIN club_members m ON m.id = p.member_id
               WHERE m.club_id = ${clubId}::uuid AND m.display_name = 'Дете Одит') AS payments,
             (SELECT m.phone FROM club_members m
               WHERE m.club_id = ${clubId}::uuid AND m.display_name = 'Възрастен Одит') AS phone
    `);
    expect(counted.rows[0]).toEqual({
      children: 1,
      abonnements: 1,
      charges: 1,
      payments: 1,
      phone: '+359 888 123 456',
    });
  });

  // ─── C10 ───────────────────────────────────────────────────────────────────

  it('C10 — shows «at risk» on the list by the segment’s own rule', async () => {
    const fresh = await record('Купи Днес Одит', null);
    await abonnement(fresh, 0);
    const silent = await record('Не Идва Одит', null);
    await abonnement(silent, 30);
    const chips = async (q: string) => (await listMembers(owner, { q })).rows[0]?.segments ?? [];
    expect(await chips('Купи Днес Одит')).not.toContain('at_risk');
    expect(await chips('Не Идва Одит')).toContain('at_risk');
    const segment = (await listMembers(owner, { segment: 'at_risk' })).rows.map((r) => r.id);
    expect(segment).toContain(silent);
    expect(segment).not.toContain(fresh);
  });

  // ─── D2 ────────────────────────────────────────────────────────────────────

  it('D2 — mails the staff once a day about one member’s new conversations, and lists them all', async () => {
    const mailer = new MemoryMailer();
    const options = { mailer, siteUrl: 'https://pops.test' };
    const staffInboxes = [addressOf(owner.userId), addressOf(desk.userId)].sort();
    const notified = async (messageId: string): Promise<string[]> => {
      mailer.sent.length = 0;
      await runClubNotify({ kind: 'inbox_message', messageId }, options);
      return mailer.sent.map((m) => m.to).sort();
    };
    const sent = (result: Awaited<ReturnType<typeof writeAsMember>>) => {
      if (!result.ok) throw new Error(result.error);
      return result;
    };

    const writer = await member('writer');
    const first = sent(
      await writeAsMember(db, writer.userId, clubId, { subject: 'Първа тема' }, 'Текст'),
    );
    expect(await notified(first.messageId)).toEqual(staffInboxes);

    // A second conversation and an enquiry the same day: in the inbox, not in the mail.
    const second = sent(
      await writeAsMember(db, writer.userId, clubId, { subject: 'Втора тема' }, 'Текст'),
    );
    expect(await notified(second.messageId)).toEqual([]);
    const asked = sent(
      await sendInquiry(
        db,
        writer.userId,
        clubId,
        { kind: 'rental', on: null, partySize: null, body: 'Свободна ли е залата?' },
        'Наем',
      ),
    );
    expect(await notified(asked.messageId)).toEqual([]);
    const inbox = (await listThreads(desk, 'open')).map((t) => t.id);
    expect(inbox).toEqual(
      expect.arrayContaining([first.threadId, second.threadId, asked.threadId]),
    );

    // The limit is per member record: somebody else's first conversation is told.
    const other = await member('otherwriter');
    const theirs = sent(
      await writeAsMember(db, other.userId, clubId, { subject: 'Друга тема' }, 'Текст'),
    );
    expect(await notified(theirs.messageId)).toEqual(staffInboxes);

    // A conversation that goes on is still announced: the desk read, the member answers.
    await threadForStaff(desk, first.threadId);
    const answer = sent(
      await writeAsMember(db, writer.userId, clubId, { threadId: first.threadId }, 'Още нещо'),
    );
    expect(answer.notify).toBe(true);
    expect(await notified(answer.messageId)).toEqual(staffInboxes);
    // …once: a retried job mails nobody again.
    expect(await notified(answer.messageId)).toEqual([]);
    expect(await notified(first.messageId)).toEqual([]);
  });
});
