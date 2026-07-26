# Local test accounts (dev only)

Sign-in is email-OTP only — there are no passwords anywhere in the product, and
a fresh one-time code is minted per sign-in attempt. Locally nothing is ever
actually emailed: the file mail transport writes every message to
`apps/web/var/mail`, and the dev-only inbox page renders them:

**http://localhost:3000/dev/poshta** — request a code on `/vhod`, and it
appears at the top of this page within a few seconds (auto-refreshes). The
page is `notFound()` on production builds and unlinked from all navigation;
in production the file transport itself is refused, so there is no outbox to
read anywhere.

## Accounts

| Email | Role | State |
|---|---|---|
| `pavel.petkoff@icloud.com` | admin | the operator's own address (via `ADMIN_EMAILS`) |
| `e2e@example.org` | admin | display name „Одит Админ“; also used by the e2e suite |
| `audit-amb@example.org` | ambassador | „Одит Амбасадор“, scoped to **Невестино + Столична** |
| `audit-adult@example.org` | member (adult) | „Одит Възрастен“ — has points and contribution history |
| `audit-minor@example.org` | member (**minor**) | „Одит Дете“, `is_minor=true` — kept as a fixture, but **there are no minor protections left to verify**: migration `0020_minors_as_adults` (operator decision 2026-07-25) removed the CHECK, the leaderboard predicate and the read-path guards, so this account can publish a passport and appear on public boards exactly like an adult. Useful for the opposite assertion — that nothing gates on `is_minor` any more |
| `audit-org@example.org` | member (organizer) | „Одит Организатор“ — organizer of the audit's play session (sees that session's QR screen) |

All of these live only in the local dev database; they are fixtures from the
2026-07-24 audit run, not part of the seed. **`pnpm db:reset` deletes them** —
re-create by signing up through `/vhod` (any address becomes a member; addresses
in `ADMIN_EMAILS` become admin; ambassador is granted per-municipality from
`/admin/ambasadori`; a minor is any account whose profile birth date is under 18).
