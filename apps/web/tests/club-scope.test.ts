import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Club authorization lives IN THE STATEMENT (CLAUDE.md, the ambassador
 * pattern): every write in apps/web/lib/clubs embeds a scope fragment from
 * scope.ts, so an out-of-scope request updates zero rows whatever a page
 * forgot to check. This gate reads the module as text — like
 * form-action-guard — and refuses a write that carries none, unless it is on
 * the list below with the reason it needs no club scope.
 */

const DIR = join(__dirname, '..', 'lib', 'clubs');
const SCOPE =
  /clubWriteScope\(|clubActorMay\(|memberSelfScope\(|occurrenceStaffScope\(|clubScope\(|clubWritableGuard\(/;
const WRITE = /\b(?:UPDATE|DELETE FROM|INSERT INTO)\b/;

/** `file:function` → why no club-staff scope belongs in it. */
const UNSCOPED_BY_DESIGN: Record<string, string> = {
  'admin.ts:approveClub': 'NGO operator path: every /admin/klubove action calls requireRole(admin)',
  'admin.ts:rejectApplication': 'NGO operator path (requireRole(admin))',
  'admin.ts:setClubPlan': 'NGO operator path (requireRole(admin))',
  'admin.ts:setClubStatus': 'NGO operator path (requireRole(admin))',
  'admin.ts:purgeClub': 'NGO operator path (requireRole(admin)), archived clubs only',
  'apply.ts:applyForClub': "the applicant's own new club; the owner row is the session account",
  'audit.ts:recordClubAudit': "append-only log, written inside the caller's scoped transaction",
  'bookings.ts:upsertBooking':
    'helper: called only after bookAtDesk/bookSelf proved scope in the same transaction',
  'club-session.ts:loadContext':
    'the ngo_admin_viewed audit row, written only after users.role = admin was read',
  'kiosk.ts:pairKiosk':
    'the 6-digit pairing code (hashed with the club, 10 minutes) is the authority',
  'kiosk.ts:kioskFromCookie': 'touches last_seen_at of the device whose secret was just proven',
  'payments.ts:openSession':
    "stores the provider's session id on the checkout row this module inserted a moment earlier, by its uuid",
  'payments.ts:closePrevious':
    "expires one checkout by uuid after its caller proved scope — startChargeCheckout read the charge under memberSelfScope; startPlanCheckout found the buyer's open offer checkout under memberSelfScope; closeOpenCheckouts runs behind requireClubStaff (members.erase, settings.manage) or the NGO admin guard, pinned to the club id; closeChargeCheckout runs only after cancelReservation or reverseSale committed a scoped cancellation of that charge's booking or sale",
  'payments.ts:fakeSettle':
    'the development-only fake provider (resolvePaymentProvider never selects it in production)',
  'promotions.ts:resolveOffer':
    "a row LOCK (FOR NO KEY UPDATE) on a capped offer, not a write — taken inside the purchase's own scoped transaction",
  'promotions.ts:recordRedemption':
    "helper: called only inside a purchase's transaction (recordTillSale, sellMembership) that proved the actor's scope and the feature first",
  'links.ts:acceptMemberInvite':
    "the member's own act: invite token + the account's verified email",
  'links.ts:claimRecord':
    "the member's own act: the account's verified email must match the record",
  'links.ts:setLinkPreference': "the member's own link only (user_id in the WHERE)",
  'links.ts:requestErasure': "the member's own linked record only (user_id in the EXISTS)",
  'staff.ts:acceptStaffInvite': "invite token + the account's verified email",
  'inbox.ts:underDailyLimit':
    "a row LOCK (FOR NO KEY UPDATE) on the writer's own record and a count, not a write — called only inside writeAsMember/sendInquiry after memberSelfScope or ensureSelfRecord proved the record",
  'staff.ts:lockOwners':
    'a row LOCK (FOR UPDATE), not a write — taken inside changeStaffRole/removeStaff, which are scoped',
  'unsubscribe.ts:unsubscribe':
    'the per-record opt-out token is the authority and grants nothing else',
};

interface Segment {
  file: string;
  name: string;
  body: string;
}

function segments(): Segment[] {
  const out: Segment[] = [];
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    const source = readFileSync(join(DIR, file), 'utf8');
    for (const part of source.split(/\n(?=(?:export )?(?:const \w+ = |(?:async )?function \w+))/)) {
      const name = /^(?:export )?(?:const (\w+) = |(?:async )?function (\w+))/.exec(part);
      if (name) out.push({ file, name: (name[1] ?? name[2]) as string, body: part });
    }
  }
  return out;
}

describe('every club write carries its scope in the statement', () => {
  const writes = segments().filter((segment) => WRITE.test(segment.body));

  it('finds the writes (the gate is not vacuous)', () => {
    expect(writes.length).toBeGreaterThan(30);
  });

  it.each(writes.map((w) => [`${w.file}:${w.name}`, w] as const))('%s', (key, segment) => {
    if (key in UNSCOPED_BY_DESIGN) return;
    expect(
      SCOPE.test(segment.body),
      `${key} writes without a scope fragment from scope.ts — embed one, or add it to ` +
        'UNSCOPED_BY_DESIGN with the reason it needs none',
    ).toBe(true);
  });

  it('keeps the allowlist honest: every entry still exists and still writes', () => {
    const present = new Set(writes.map((w) => `${w.file}:${w.name}`));
    for (const key of Object.keys(UNSCOPED_BY_DESIGN)) {
      expect(present.has(key), `${key} is allowlisted but no longer writes`).toBe(true);
    }
  });
});

/**
 * The ranges of every template literal in `src`, nested ones included, found
 * by a small tokenizer (strings, comments, `${…}` nesting). Enough for the
 * club modules, which hold no regex literal containing a backtick.
 */
function templateRanges(src: string): [number, number][] {
  const ranges: [number, number][] = [];
  type Frame = { kind: 'code'; depth: number } | { kind: 'template'; start: number };
  const stack: Frame[] = [{ kind: 'code', depth: 0 }];
  let i = 0;
  while (i < src.length) {
    const top = stack[stack.length - 1] as Frame;
    const ch = src[i];
    if (top.kind === 'template') {
      if (ch === '\\') i += 2;
      else if (ch === '`') {
        ranges.push([top.start, i]);
        stack.pop();
        i += 1;
      } else if (ch === '$' && src[i + 1] === '{') {
        stack.push({ kind: 'code', depth: 0 });
        i += 2;
      } else i += 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end;
    } else if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (ch === "'" || ch === '"') {
      i += 1;
      while (i < src.length && src[i] !== ch) i += src[i] === '\\' ? 2 : 1;
      i += 1;
    } else if (ch === '`') {
      stack.push({ kind: 'template', start: i });
      i += 1;
    } else if (ch === '{') {
      top.depth += 1;
      i += 1;
    } else if (ch === '}') {
      if (top.depth === 0 && stack.length > 1) stack.pop();
      else top.depth -= 1;
      i += 1;
    } else i += 1;
  }
  return ranges;
}

describe('every scope fragment names an alias its statement declares', () => {
  // clubScope(actor, permission, 'pay') expands to `pay.club_id = …`. If the
  // statement calls the table `p`, Postgres refuses the whole query at run
  // time (42P01) — a refund that could never work passed every other test.
  const CALL =
    /(clubScope|clubWriteScope|occurrenceStaffScope)\(\s*[^,()]+,\s*(?:'[^']*'\s*,\s*)?'([a-z]+)'\s*\)/g;
  const calls: { key: string; alias: string; templates: string[] }[] = [];
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    const source = readFileSync(join(DIR, file), 'utf8');
    const ranges = templateRanges(source);
    for (const match of source.matchAll(CALL)) {
      const at = match.index ?? 0;
      const enclosing = ranges.filter(([start, end]) => start < at && at < end);
      // A fragment collected outside a statement (a conditions array) is
      // joined into one later; this check cannot follow it there.
      if (enclosing.length === 0) continue;
      calls.push({
        key: `${file}:${source.slice(0, at).split('\n').length}`,
        alias: match[2] as string,
        templates: enclosing.map(([start, end]) => source.slice(start, end)),
      });
    }
  }

  it('finds scoped statements (the check is not vacuous)', () => {
    expect(calls.length).toBeGreaterThan(50);
  });

  it.each(calls.map((c) => [c.key, c] as const))('%s', (_key, call) => {
    const declared = new RegExp(
      `\\b(?:FROM|JOIN|UPDATE|INTO)\\s+(?:public\\.)?"?[a-z_]+"?\\s+(?:AS\\s+)?${call.alias}\\b`,
      'i',
    );
    expect(
      call.templates.some((text) => declared.test(text)),
      `the scope fragment uses alias '${call.alias}', which no enclosing statement declares`,
    ).toBe(true);
  });
});

describe('the operator club actions are admin-only', () => {
  const actions = readFileSync(
    join(__dirname, '..', 'app', '[locale]', 'admin', '(protected)', 'klubove', 'actions.ts'),
    'utf8',
  );
  const exported = actions
    .split(/\nexport async function /)
    .slice(1)
    .map((part) => [/^(\w+)/.exec(part)?.[1] ?? '?', part] as const);

  it('has actions to check', () => {
    expect(exported.length).toBeGreaterThan(2);
  });

  it('routes through a guard that calls requireRole(admin) — never requireAdmin()', () => {
    const guard = /async function guard\([\s\S]*?\n\}/.exec(actions)?.[0] ?? '';
    expect(guard).toMatch(/requireRole\('admin'\)/);
    expect(actions).not.toMatch(/await requireAdmin\(/);
  });

  it.each(exported)('%s is admin-gated', (_name, body) => {
    expect(body).toMatch(/await guard\(|requireRole\('admin'\)/);
  });
});
