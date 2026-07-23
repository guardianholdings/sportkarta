-- 0015_open_data: the /danni portal — free API keys and the index of nightly
-- bulk dumps (docs/ROADMAP.md §8, Stage 6.1). Two new tables. No existing
-- column is altered, no data is rewritten, and no enum gains a value — so
-- neither 0013's nor 0014's enum-and-transaction traps apply here. `users` IS
-- touched, though only by gaining a referential action: every later DELETE
-- from it now cascades into api_keys as well. See the locking note below,
-- which is about precisely that.
--
-- NO COLUMN IN THIS TABLE CAN HOLD A KEY, AND THAT IS THE DESIGN. Every project
-- says it stores only the hash of an API key; the ones that turn out not to
-- have a `key_last_four` somebody added for a support ticket, or a
-- `key_plaintext` from a migration that was never finished. Here
-- `api_keys_hash_is_sha256_hex` pins key_hash to exactly 64 lowercase hex
-- characters. An issued key is `skbg_` + 43 base64url characters — 48, never
-- 64 — so writing one into that column raises SQLSTATE 23514. It is the
-- LENGTH that makes this unfalsifiable, not the alphabet: a 43-character
-- base64url secret happens to contain neither `-` nor `_` about a quarter of
-- the time, so an argument from the character set would have been only
-- probabilistic.
--   AND THE FREE-TEXT COLUMN IS COVERED TOO, which it was not in the first
--   draft of this file — caught in review. `label` is a name the member types,
--   60 characters are allowed, and a key is 48: somebody pasting their key
--   into the label box (people do) would have stored it in cleartext, had it
--   rendered back to them on the keys page, and shipped it into every nightly
--   backup, while the hash carried on authenticating it. That is exactly the
--   `key_last_four` failure this paragraph opens by warning about, arriving
--   through the one column nobody was looking at. `api_keys_label_no_key`
--   forbids the `skbg_` marker in a label, on the same principle as 0013's
--   `calendar_tokens_token_is_not_the_account_id`.
--
-- `prefix` IS STORED ON PURPOSE and is not a weakening of that. A member with
-- three keys has to be able to tell them apart to revoke the right one, and
-- revoking the wrong key because the screen could only say "created 3 weeks
-- ago" is how people end up not revoking at all. `api_keys_prefix_shape` pins
-- it to the `skbg_` marker plus exactly SIX characters of the secret, so the
-- 36 bits it reveals and the 220 it withholds are constraints rather than a
-- convention the writer happens to follow.
--
-- ON DELETE CASCADE, NOT SET NULL — the opposite of most FKs on `users` in
-- this schema, and deliberately. Everywhere else the pattern is "the fact
-- survives, the identity does not": a facility edit, a result, a frozen
-- campaign placing are records of something that HAPPENED, and they outlive the
-- account with the person stripped out of them. An API key is not a record of
-- anything. It is a LIVE CREDENTIAL, and an ownerless credential that still
-- authenticates is the worst available reading of "erasure". So it goes with
-- the account, through the cascade, exactly as 0013 does with calendar_tokens —
-- and for the same stated reason, it is NOT counted on the account_deletions
-- tombstone. A receipt enumerates what was destroyed of the person's RECORD;
-- one credential row is not part of that record, and this migration therefore
-- does not touch account_deletions at all.
--
-- THERE IS NO REQUEST LOG IN THIS MIGRATION, AND THAT IS A DECISION. The
-- obvious next table is `api_key_requests` — timestamp, key, path, status — and
-- every API product has one. Ours would be a standing record of which
-- municipality's data an identified account keeps asking about, retained
-- indefinitely, for a service whose entire premise is that the data is public
-- and needs no account at all. That table would be more sensitive than anything
-- it protected. Rate limiting therefore lives in memory, per web process, and
-- is allowed to forget on restart (apps/web/lib/opendata/limits.ts states the
-- trade). The one trace a request leaves is `last_used_at`, rounded to the
-- minute by the writer so it cannot accumulate into a timeline, and it exists
-- so an unused key can be recognised as unused before somebody revokes it.
--
-- opendata_dumps: THE TABLE IS THE INDEX, THE FILE IS THE ARTIFACT. The
-- manifest endpoint reads these rows rather than listing a directory, because a
-- directory is whatever is on the volume right now — a half-written file
-- mid-dump, a leftover from a pruned version, a typo. A row is inserted only
-- after its file is completely written and hashed. The failure mode that
-- creates is stated rather than hidden: wipe the volume without wiping the
-- database and a row outlives its file, in which case the download route 404s
-- instead of serving something truncated.
--
-- `version` IS A CIVIL SOFIA DATE, NOT A TIMESTAMP. "The 2026-07-23 dump" is
-- what a citation in a municipal report says. A UTC timestamp would file the
-- dump produced on a Sofia morning under the previous day for the four months
-- of the year when Sofia is UTC+3, and the version in the URL would then
-- disagree with the date in the report quoting it.
--
-- `sha256` IS WHAT MAKES A DUMP CITABLE. "Computed from the 2026-07-23 extract,
-- sha256 ab12…" can be checked by anybody who still has the file. That is the
-- difference between an open dataset and a published number, and it is the
-- property Stage 6's grant reports and quarterly national report will lean on.
--
-- LOCKING, AND WHY THIS FILE IS NOT 0012's DEADLOCK AGAIN. Both statements are
-- CREATE TABLE, which locks only the new relation. The one lock that reaches an
-- existing table is `ALTER TABLE api_keys ADD CONSTRAINT ... FOREIGN KEY`,
-- taking SHARE ROW EXCLUSIVE on `users` for the rest of the transaction
-- (drizzle runs the whole migration as one), so it is placed LAST, after the
-- indexes and comments, as 0012 and 0013 established.
--   The deadlock 0012 warns about needs a CYCLE, and the obvious reading says
--   there is one: this file locks api_keys and then users, while an erasure
--   locks users and then cascades INTO api_keys — textbook inversion. There is
--   no cycle, and the reason has to be stated precisely, because the imprecise
--   version of it is wrong in a way that would mislead the next author.
--     The WRONG version (an earlier draft of this header): "api_keys does not
--     exist for any transaction that started before this migration commits."
--     Catalogue visibility is decided by the COMMIT, not by when the reader
--     began. deleteAccount runs at READ COMMITTED and takes a fresh snapshot
--     per statement, so a transaction that started an hour ago and issues its
--     `DELETE FROM users` after this file commits absolutely does see the new
--     FK and does cascade into api_keys.
--     The CORRECT version: until this transaction commits, the FK is invisible
--     to every other transaction whenever it started — so no concurrent erasure
--     can cascade into api_keys — and once it HAS committed, this transaction
--     holds no locks at all. There is no interval in which one side holds
--     api_keys while the other holds users wanting it.
--   THE RULE TO CARRY FORWARD is therefore not "a new table is exempt". It is:
--   this file locks only api_keys and users, and takes users LAST, so it can
--   only ever wait — it can never close a cycle. A later migration that adds an
--   FK to `users` AND also touches any table deleteAccount locks first
--   (account_deletions above all) satisfies the "new table" reading and still
--   deadlocks, with deadlock_timeout at 1 s firing well before lock_timeout at
--   3 s and aborting either the deploy or somebody's erasure mid-flight.
--   lock_timeout makes queueing behind a long reader fail fast rather than
--   blocking sign-in and erasure behind a deploy; statement_timeout bounds the
--   hold once the lock is taken.
--
-- rollback (compensating SQL, reverse order; DESTRUCTIVE where noted):
--   ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_user_id_users_id_fk";
--   DROP TABLE "opendata_dumps";  -- DESTRUCTIVE: the index of every published
--       dump. The FILES survive on the storage volume, but the manifest
--       endpoint and the retention pruner both read this table, so /danni stops
--       offering downloads that still exist and the next dump run will not
--       prune the old versions it can no longer see. Recoverable only by
--       re-running the dump job, which republishes under TODAY's version — the
--       historical versions become uncitable.
--   DROP TABLE "api_keys";        -- DESTRUCTIVE: revokes every issued key
--       irreversibly (only hashes are stored, so they cannot be reconstructed
--       or re-issued). Every integration built against the API drops to the
--       anonymous rate limit — degraded, not broken, because a key has never
--       been required to READ. Tell key holders first; they cannot be told
--       afterwards, since we hold no address for a key.
SET lock_timeout = '3s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_hash_is_sha256_hex" CHECK ("api_keys"."key_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "api_keys_prefix_shape" CHECK ("api_keys"."prefix" ~ '^skbg_[A-Za-z0-9_-]{6}$'),
	CONSTRAINT "api_keys_label_not_blank" CHECK (btrim("api_keys"."label") <> ''),
	CONSTRAINT "api_keys_label_len" CHECK (char_length("api_keys"."label") <= 60),
	CONSTRAINT "api_keys_label_no_key" CHECK (position('skbg_' in "api_keys"."label") = 0)
);
--> statement-breakpoint
CREATE TABLE "opendata_dumps" (
	"version" date NOT NULL,
	"dataset" text NOT NULL,
	"format" text NOT NULL,
	"storage_path" text NOT NULL,
	"bytes" bigint NOT NULL,
	"row_count" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opendata_dumps_pkey" PRIMARY KEY("version","dataset","format"),
	CONSTRAINT "opendata_dumps_storage_path_unique" UNIQUE("storage_path"),
	CONSTRAINT "opendata_dumps_sha256_hex" CHECK ("opendata_dumps"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "opendata_dumps_bytes_positive" CHECK ("opendata_dumps"."bytes" > 0),
	CONSTRAINT "opendata_dumps_row_count_non_negative" CHECK ("opendata_dumps"."row_count" >= 0),
	CONSTRAINT "opendata_dumps_format_known" CHECK ("opendata_dumps"."format" IN ('geojson', 'csv', 'json')),
	CONSTRAINT "opendata_dumps_dataset_not_blank" CHECK (btrim("opendata_dumps"."dataset") <> '')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_unique" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_user_idx" ON "api_keys" USING btree ("user_id");
--> statement-breakpoint

COMMENT ON TABLE "api_keys" IS
  'Free open-data API keys (Stage 6.1). A key raises the rate limit; it never gates access, because the data is ODbL-public and the API serves anonymous callers. No column here can hold a key: api_keys_hash_is_sha256_hex pins the hash to 64 hex characters, and api_keys_label_no_key keeps one out of the free-text label.';--> statement-breakpoint
COMMENT ON COLUMN "api_keys"."key_hash" IS
  'SHA-256 of the issued key, lowercase hex. An issued key is 48 characters, so this column is structurally incapable of holding one.';--> statement-breakpoint
COMMENT ON COLUMN "api_keys"."label" IS
  'Member-supplied name, so keys can be told apart when revoking one. CHECK-forbidden from containing the skbg_ marker: a key pasted in here would otherwise sit in cleartext, in the UI and in every backup.';--> statement-breakpoint
COMMENT ON COLUMN "api_keys"."prefix" IS
  'The skbg_ marker plus exactly six characters of the secret, so a member can tell their own keys apart when revoking one. The remaining 220 bits are unpublished.';--> statement-breakpoint
COMMENT ON COLUMN "api_keys"."last_used_at" IS
  'Minute-rounded, and the only trace a request leaves anywhere — there is deliberately no request-log table. Exists so an unused key can be recognised as unused before revocation.';--> statement-breakpoint

COMMENT ON TABLE "opendata_dumps" IS
  'Index of published nightly bulk dumps (Stage 6.1). A row is written only after its file is fully written and hashed; the manifest endpoint reads these rows rather than listing the storage volume.';--> statement-breakpoint
COMMENT ON COLUMN "opendata_dumps"."version" IS
  'Civil Europe/Sofia date. A UTC timestamp would file a Sofia-morning dump under the previous day for four months of the year.';--> statement-breakpoint
COMMENT ON COLUMN "opendata_dumps"."sha256" IS
  'Checksum of the published file. What makes a dump citable: a figure quoted from a version can be recomputed by anyone who still has it.';--> statement-breakpoint

-- LAST, deliberately: the only lock in this file that reaches an existing
-- table. See the locking note in the header for why that ordering is what
-- makes a concurrent GDPR erasure wait rather than deadlock.
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
