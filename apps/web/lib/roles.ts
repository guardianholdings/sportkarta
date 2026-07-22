import { sql, type SQL } from '@sportkarta/db';

/**
 * Role model for Stage 3 (docs/ROADMAP.md §5). Replaces the Stage 1 shared
 * ADMIN_TOKENS allowlist: authorization is now a property of a real account.
 *
 * Ranks are ordered, so a check reads "at least moderator" rather than an
 * enumeration that silently forgets a role when a new one is added.
 */
export const ROLE_RANK = {
  user: 0,
  ambassador: 1,
  moderator: 2,
  admin: 3,
} as const;

export type Role = keyof typeof ROLE_RANK;

/** Lowest role allowed into /admin. Moderators see moderation; imports are admin-only. */
export const ADMIN_PANEL_MIN_ROLE: Role = 'moderator';

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && value in ROLE_RANK;
}

/** Unknown/missing roles collapse to the least privileged one — fail closed. */
export function toRole(value: unknown): Role {
  return isRole(value) ? value : 'user';
}

export function hasAtLeast(role: unknown, minimum: Role): boolean {
  return ROLE_RANK[toRole(role)] >= ROLE_RANK[minimum];
}

export function canAccessAdminPanel(role: unknown): boolean {
  return hasAtLeast(role, ADMIN_PANEL_MIN_ROLE);
}

interface SqlRunner {
  execute(query: SQL): Promise<unknown>;
}

/**
 * Make `users.role = 'admin'` follow the ADMIN_EMAILS allowlist on every
 * sign-in. This is the bootstrap path for the very first admin — no terminal,
 * no manual UPDATE — and the revocation path: remove an address from the
 * environment and the next sign-in demotes it.
 *
 * Only the 'admin' role is environment-managed. ambassador/moderator are
 * granted in-app and are never touched here.
 *
 * An empty allowlist is treated as "not configured" and does nothing at all:
 * a dropped environment variable must not silently demote every admin and lock
 * the operator out of their own site.
 */
export async function syncAdminRole(
  db: SqlRunner,
  userId: string,
  adminEmails: ReadonlySet<string>,
): Promise<void> {
  if (adminEmails.size === 0) return;
  // sql.param binds the whole list as ONE array parameter. Interpolating the
  // array directly would expand it to `ANY(($1, $2)::text[])`, which is not
  // valid SQL — see the rendering assertion in tests/roles.test.ts.
  const allowlist = sql.param([...adminEmails]);

  // email_verified is defence in depth: with email OTP the address is verified
  // by definition, but once Google login is enabled the allowlist would
  // otherwise trust whatever address the provider asserts.
  await db.execute(sql`
    UPDATE users SET role = 'admin'
    WHERE id = ${userId}
      AND role <> 'admin'
      AND email_verified
      AND lower(email) = ANY(${allowlist}::text[])
  `);
  await db.execute(sql`
    UPDATE users SET role = 'user'
    WHERE id = ${userId} AND role = 'admin' AND lower(email) <> ALL(${allowlist}::text[])
  `);
}
