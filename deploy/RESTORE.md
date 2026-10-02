# Disaster recovery

For the operator, working through Claude Code. **You never type a command.**
Tell Claude what happened and point it at this file; Claude runs every command
below. Steps marked **YOU** happen in a browser or a provider console, and only
you can do them.

Calm first: most "the site is down" moments are a deploy in progress or a
container that needs a restart, and are over in minutes. Restoring data (§3) is
for when data is actually wrong or gone.

## 0. What is backed up, and what is not

| What                                                        | Where the copies are                                                                                                                             | Kept                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| App database `sportkarta` (map, accounts, points, sessions) | Nightly `pg_dump` at 03:30 Sofia into the server's `backups` volume, `/backups/pg/sportkarta-YYYYMMDD-HHMMSS.dump`; checked readable every night | 14 days (3 once off-box copies work) |
| `umami`, `glitchtip` databases                              | Same, `umami-….dump`, `glitchtip-….dump`                                                                                                         | same                                 |
| Uploads volume (facility photos, open-data dumps)           | **Only** in the off-box restic copy — which is not configured yet                                                                                | —                                    |
| Map tiles volume                                            | Nowhere; rebuilt from source (`deploy/tiles/README.md`)                                                                                          | —                                    |
| Secrets                                                     | GitHub Actions secrets (the source of truth); rendered into `/opt/sportkarta/.env` on every deploy                                               | —                                    |
| Code and server configuration                               | Git                                                                                                                                              | —                                    |

**The honest bottom line.** Until off-box copies are set up (§5), every backup
lives on the same disk as the database it protects. If the server's disk is
lost, members' accounts, contributions, points and sessions are lost with it;
the map itself can be rebuilt from OpenStreetMap. Setting up §5 is the single
most valuable thing on this page.

The newest `sportkarta` dump is restored into a throwaway database every
Tuesday by the **Restore rehearsal** workflow (`.github/workflows/restore-test.yml`),
so the restore in §3 is one that has been done before, not one being tried
for the first time mid-incident.

## 1. "Is it down?" — the Uptime alert fired

The **Uptime** workflow checks `/api/health` every ten minutes and fails when
the site or its database does not answer. GitHub emails you a failed run.

1. **YOU** — GitHub → the repository → **Actions**. Is a **Deploy** running?
   A deploy swaps containers and the site can blink for a minute. Wait for it,
   then check whether the next Uptime run is green.
2. Tell Claude: _"The uptime check failed — follow deploy/RESTORE.md §1."_
   Claude runs **Uptime** again by hand (`gh workflow run uptime.yml`) and
   reads its log, then looks at the server over SSH (§6) — read-only:
   `docker compose -f compose.prod.yml ps`, and the last lines of `web` and
   `db` logs. Most outages end here with `docker compose -f compose.prod.yml up -d`.
3. If the last deploy broke it: §2.
4. If the server does not answer SSH at all: **YOU** — Hetzner console → the
   server → is it running? Power-cycle it there. If it is gone: §4.

## 2. Roll back a bad release

No data changes; the previous release's images come back as they were.

1. Claude finds the last good commit (the one before the bad deploy) and
   gives you its full 40-character SHA.
2. **YOU** — GitHub → Actions → **Deploy** → _Run workflow_ → branch `main`,
   paste the SHA into **rollback_to** → _Run workflow_.

A release whose **migration** broke data is not fixed by a rollback — the
database stays migrated. That is §3.

## 3. Restore the database from a nightly dump (the server is still there)

When: a bad migration, mass vandalism, an accidental deletion. **Everything
written after the dump you choose is lost** — decide the moment to go back to,
and plan a short public note ("changes made between … and … need re-doing").

Claude runs each step over SSH (§6), in `/opt/sportkarta`, and shows you the
output. `C` below stands for `docker compose -f compose.prod.yml`.

1. **List the dumps** and choose one (newest before the damage):
   `docker run --rm -v sportkarta_backups:/backups:ro alpine:3.20 ls -l /backups/pg`
2. **Rehearse it first.** **YOU** — Actions → **Restore rehearsal** → _Run
   workflow_ (it takes the newest dump; for an older one Claude runs the
   same commands by hand against that file). Green means it restores cleanly.
3. **Stop everything that writes** — the site shows its "updating" page:
   `C stop web worker backup`
   **YOU** — do not merge to `main` or run **Deploy** / **Import OSM** until
   step 8: either would start the app again against a half-restored
   database.
4. **Keep a copy of the damaged state**, in case the choice in step 1 was
   wrong:
   `C run --rm --no-deps backup pg_dump --format=custom --dbname=sportkarta --file=/backups/pg/pre-restore-$(date +%Y%m%d-%H%M%S).dump`
5. **Recreate the database empty** (the dump brings its own extensions):
   `C exec -T db dropdb -U sportkarta --force sportkarta`
   `C exec -T db createdb -U sportkarta -T template0 sportkarta`
6. **Restore** (stops at the first error rather than half-restoring):
   `C run --rm --no-deps backup pg_restore --dbname=sportkarta --no-owner --exit-on-error /backups/pg/<chosen>.dump`
   If this fails, the database is empty — restore the step-4 copy the same
   way, then work out the failure calmly.
7. **Bring the schema up to the running release** (a dump older than the
   latest migration is missing it; this is a no-op otherwise):
   `C --profile ops run --rm migrate`
8. **Start again**: `C up -d web worker backup`, then Claude checks
   `/api/health` and you open the site and look at a few facilities you know.
9. Keep the `pre-restore-…` dump for a couple of weeks; the nightly prune
   removes it after 14 days.

The `umami` and `glitchtip` databases restore the same way (their own dump,
their own name in steps 4–6, stopping `umami` or the three `glitchtip*`
services instead of `web`/`worker`). Nobody's data is in them; starting them
empty is also acceptable.

## 4. The server is gone — rebuild it

1. **YOU** — Hetzner console → new server: **CPX32**, **Ubuntu 24.04**,
   **x86 (amd64)** — not an ARM "CAX" type, the images do not run there.
   Paste `deploy/cloud-init.yml` as _cloud-init / user data_. Note the new IP.
2. Claude reads the new server's host key (`ssh-keyscan -t ed25519 <IP>`).
   **YOU** compare it with the fingerprint the Hetzner console shows for the
   server. Claude replaces the pinned key in every workflow that pins it
   (`grep -l sportkarta-prod .github/workflows/*.yml` — today `deploy.yml`
   and `restore-test.yml`) in one commit — a deploy to an unverified host
   would hand it every production secret.
3. **YOU** — GitHub → Settings → Secrets and variables → Actions → update
   **DEPLOY_HOST** to the new IP. At your domain registrar, point the site's
   A record at it.
4. Merge Claude's commit to `main`; the deploy builds a fresh, empty stack
   (migrations and seed). The site is up, with an empty map.
5. **Data:**
   - _Off-box copies exist (§5):_ Claude pulls the newest dumps and the
     uploads back from restic
     (`C run --rm backup restic restore latest --target / --include /backups/pg --include /data/uploads`
     — the uploads mount is read-only in that service, so Claude adds a
     writable mount for that one run), then follows §3 steps 3–8.
   - _No off-box copies:_ there is nothing to restore. Claude re-imports the
     map (**YOU** — Actions → **Import OSM** → tick _live_ → _Run_), and
     members must sign up again. Say so publicly and plainly.
6. Map tiles: Claude rebuilds and loads them per `deploy/tiles/README.md`.

## 5. Off-box copies — set these up before you need them

1. **YOU** — Backblaze → B2 → create a private bucket and an application key
   limited to it.
2. **YOU** — GitHub → Settings → Secrets and variables → Actions → add
   `RESTIC_REPOSITORY` (e.g. `s3:s3.eu-central-003.backblazeb2.com/<bucket>`),
   `RESTIC_PASSWORD` (a long random phrase — **also keep it in your password
   manager**: without it the copies can never be read), and `AWS_ACCESS_KEY_ID`
   / `AWS_SECRET_ACCESS_KEY` (the B2 key id and key).
3. Merge anything to `main`, or run **Deploy** by hand, so the server gets them.
4. The next morning Claude checks the backup log for `restic push complete`
   and runs `C run --rm backup restic snapshots`. After that, local dumps are
   kept for 3 days and the history lives off-box.
5. Once, to prove it: Claude restores the newest restic snapshot of
   `/backups/pg` into a scratch directory on the server and runs the rehearsal
   commands against that dump.

## 6. How Claude reaches the server

The same way the workflows do: user `deploy`, the deploy key, and the host key
pinned in `deploy.yml` (strict checking — never `accept-new`). The private key
is in `secrets-local/deploy_key_ed25519` on the Mac that generated it
(`scripts/gen-deploy-key`); **it is never pasted into a chat**. If that Mac is
lost, Claude generates a new pair with the same script and **YOU** put the new
private key into the `DEPLOY_SSH_KEY` secret and the public key into
`deploy/cloud-init.yml` and the server's `~deploy/.ssh/authorized_keys`
(through the Hetzner console's rescue shell).

Everything on the server that is not data comes from the repository and is
overwritten by the next deploy: fix things in git, never by hand-editing
`/opt/sportkarta`.

## 7. When the Restore rehearsal goes red

It says why in its log (Actions → Restore rehearsal → the failed run) — in
outline only. The repository is public, so its Actions logs are too, and
PostgreSQL's own error text quotes the row it choked on: a member's email,
name, anything. That text never reaches GitHub. It stays on the server in
`~deploy/restore-rehearsal/<run id>.log` (the run id is the number at the end
of the run's address), readable only by `deploy`, and is deleted after 14 days
— no longer than the dump it quotes is kept.

- **"the newest dump is …h old"** — the nightly backup stopped. Claude checks
  the `backup` container (`C ps`, `C logs backup`, `/backups/backup.log`).
  Fix this first: until it runs, every day's changes are unprotected.
- **"pg_restore stopped (exit …)"** — it names the table whose rows failed to
  load, if it was a table — or **"… errored on the restored copy"**: a dump
  exists but would not come back cleanly. Treat it as urgent: it is the
  restore §3 relies on. Claude reads the full error on the server over SSH
  (§6): `cat ~/restore-rehearsal/<run id>.log`, then reproduces the failure on
  a throwaway container and fixes the cause. That file can hold members' data:
  Claude tells you the cause in its own words and never copies its lines into
  an issue, a pull request or a commit — all of them public.
- **SSH / host key errors** — the server was rebuilt or its key changed:
  §4 step 2.
