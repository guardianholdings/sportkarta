import { config } from 'dotenv';
import pg from 'pg';

// Root .env (this file lives in db/scripts/).
config({ path: new URL('../../.env', import.meta.url).pathname });

/**
 * READ-ONLY snapshot of the moderation queue, as JSON, for the weekly
 * pre-screen session (docs/prompts/moderation-prescreen.md).
 *
 * It computes signals — facts that MIGHT indicate junk — and never a verdict.
 * The session reads this, decides which items deserve a flag, and writes flags
 * with db/scripts/moderation-flag.ts. Nothing here or there can change a status:
 * this script opens a read-only transaction, so an accidental UPDATE fails
 * loudly instead of quietly moderating something.
 */

interface QueueItem {
  targetType: 'photo' | 'report' | 'facility';
  targetId: string;
  facilityId: string;
  facilityName: string | null;
  municipality: string | null;
  createdAt: string;
  waitingHours: number;
  existingFlags: string[];
  signals: Record<string, unknown>;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required (see .env.example)');

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // Belt and braces: the session must not be able to decide anything.
    await client.query('BEGIN TRANSACTION READ ONLY');

    const photos = await client.query<QueueRow>(`
      SELECT 'photo' AS target_type, p.id AS target_id, f.id AS facility_id, f.name AS facility_name,
             m.name_bg AS municipality, p.created_at,
             jsonb_build_object(
               'storagePath', p.storage_path,
               'uploaderPresent', p.uploaded_by IS NOT NULL,
               'uploaderRejectedBefore', COALESCE((
                 SELECT count(*) FROM facility_photos p2
                  WHERE p2.uploaded_by = p.uploaded_by AND p2.status = 'rejected'), 0),
               'facilityPendingPhotos', (
                 SELECT count(*) FROM facility_photos p3
                  WHERE p3.facility_id = p.facility_id AND p3.status = 'pending')
             ) AS signals
        FROM facility_photos p
        JOIN facilities f ON f.id = p.facility_id
        LEFT JOIN municipalities m ON m.id = f.municipality_id
       WHERE p.status = 'pending'
       ORDER BY p.created_at
    `);

    const reports = await client.query<QueueRow>(`
      SELECT 'report' AS target_type, r.id AS target_id, f.id AS facility_id, f.name AS facility_name,
             m.name_bg AS municipality, r.created_at,
             jsonb_build_object(
               'issue', r.issue,
               'bodyLength', COALESCE(char_length(r.body), 0),
               'hasPhoto', r.photo_id IS NOT NULL,
               'pendingOnSameFacility', (
                 SELECT count(*) FROM facility_reports r2
                  WHERE r2.facility_id = r.facility_id AND r2.status = 'pending'),
               'facilityAlreadyGone', f.status = 'gone'
             ) AS signals
        FROM facility_reports r
        JOIN facilities f ON f.id = r.facility_id
        LEFT JOIN municipalities m ON m.id = f.municipality_id
       WHERE r.status = 'pending'
       ORDER BY r.created_at
    `);

    const facilities = await client.query<QueueRow>(`
      SELECT 'facility' AS target_type, f.id AS target_id, f.id AS facility_id, f.name AS facility_name,
             m.name_bg AS municipality, f.created_at,
             jsonb_build_object(
               'sportTypes', f.sport_types,
               'hasName', f.name IS NOT NULL,
               'hasPhoto', EXISTS (SELECT 1 FROM facility_photos p WHERE p.facility_id = f.id),
               'municipalityMissing', f.municipality_id IS NULL,
               'neighboursWithin100m', (
                 SELECT count(*) FROM facilities f2
                  WHERE f2.id <> f.id AND f2.status <> 'gone'
                    AND ST_DWithin(f2.geom, f.geom, 0.0015)
                    AND ST_DistanceSphere(f2.geom, f.geom) <= 100)
             ) AS signals
        FROM facilities f
        LEFT JOIN municipalities m ON m.id = f.municipality_id
       WHERE f.status = 'needs_verification' AND f.source = 'crowd'
       ORDER BY f.created_at
    `);

    const flags = await client.query<{ target_type: string; target_id: string; reason: string }>(
      `SELECT target_type, target_id, reason FROM moderation_flags`,
    );
    const flagged = new Map<string, string[]>();
    for (const row of flags.rows) {
      const key = `${row.target_type}:${row.target_id}`;
      flagged.set(key, [...(flagged.get(key) ?? []), row.reason]);
    }

    const items: QueueItem[] = [...photos.rows, ...reports.rows, ...facilities.rows].map((row) => ({
      targetType: row.target_type,
      targetId: row.target_id,
      facilityId: row.facility_id,
      facilityName: row.facility_name,
      municipality: row.municipality,
      createdAt: new Date(row.created_at).toISOString(),
      waitingHours:
        Math.round(((Date.now() - new Date(row.created_at).getTime()) / 3_600_000) * 10) / 10,
      existingFlags: flagged.get(`${row.target_type}:${row.target_id}`) ?? [],
      signals: row.signals,
    }));

    const stats = await client.query<{ median_hours: string | null; decisions: string }>(`
      SELECT percentile_cont(0.5) WITHIN GROUP (
               ORDER BY extract(epoch FROM decided_at - queued_at)) / 3600.0 AS median_hours,
             count(*) AS decisions
        FROM moderation_decisions
       WHERE decided_at >= now() - interval '30 days'
    `);

    await client.query('COMMIT');

    process.stdout.write(
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          queue: {
            photos: photos.rowCount ?? 0,
            reports: reports.rowCount ?? 0,
            facilities: facilities.rowCount ?? 0,
            total: items.length,
          },
          last30Days: {
            decisions: Number(stats.rows[0]?.decisions ?? 0),
            medianHoursToDecision:
              stats.rows[0]?.median_hours === null || stats.rows[0] === undefined
                ? null
                : Math.round(Number(stats.rows[0].median_hours) * 10) / 10,
          },
          items,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await client.end();
  }
}

interface QueueRow {
  target_type: 'photo' | 'report' | 'facility';
  target_id: string;
  facility_id: string;
  facility_name: string | null;
  municipality: string | null;
  created_at: string;
  signals: Record<string, unknown>;
}

main().catch((error: unknown) => {
  console.error('[moderation-queue]', error);
  process.exit(1);
});
