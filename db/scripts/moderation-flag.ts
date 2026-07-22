import { config } from 'dotenv';
import pg from 'pg';

// Root .env (this file lives in db/scripts/).
config({ path: new URL('../../.env', import.meta.url).pathname });

/**
 * Write ONE assistive pre-screen flag (docs/prompts/moderation-prescreen.md).
 *
 * This is the only write the weekly pre-screen session may make, and it can do
 * nothing else: the single statement is an INSERT into moderation_flags. There
 * is no code path here that touches facility_photos.status,
 * facility_reports.status or facilities.status — a flag says "look at this, and
 * here is why"; a human decides. Re-running is idempotent (ON CONFLICT).
 *
 *   pnpm mod:flag --target photo:<uuid> --reason blurry_or_dark --note "…"
 */

const USAGE =
  'usage: pnpm mod:flag --target <photo|report|facility>:<uuid> --reason <slug> [--note "…"]';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const TARGET_RE = /^(photo|report|facility):([0-9a-f-]{36})$/i;
const REASON_RE = /^[a-z][a-z0-9_]{2,39}$/;
const NOTE_MAX = 300;

async function main(): Promise<void> {
  const target = arg('target');
  const reason = arg('reason');
  const note = arg('note') ?? null;

  const targetMatch = target ? TARGET_RE.exec(target) : null;
  if (!targetMatch) throw new Error(`invalid or missing --target\n${USAGE}`);
  if (!reason || !REASON_RE.test(reason)) throw new Error(`invalid or missing --reason\n${USAGE}`);
  if (note !== null && note.length > NOTE_MAX) {
    throw new Error(`--note must be at most ${String(NOTE_MAX)} characters`);
  }

  const [, targetType, targetId] = targetMatch;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required (see .env.example)');

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query(
      `INSERT INTO moderation_flags (target_type, target_id, reason, note)
       VALUES ($1::moderation_target, $2::uuid, $3, $4)
       ON CONFLICT (target_type, target_id, reason) DO NOTHING
       RETURNING id`,
      [targetType?.toLowerCase(), targetId, reason, note],
    );
    const created = (result.rowCount ?? 0) > 0;
    console.log(
      created
        ? `flagged ${String(targetType)} ${String(targetId)}: ${reason}`
        : `already flagged ${String(targetType)} ${String(targetId)}: ${reason} (no change)`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('[moderation-flag]', error instanceof Error ? error.message : error);
  process.exit(1);
});
