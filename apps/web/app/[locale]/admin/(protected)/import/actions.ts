'use server';

import { redirect } from 'next/navigation';

import { getBoss, IMPORT_QUEUE } from '@/lib/admin-boss';
import { requireRole } from '@/lib/auth-session';

/**
 * Enqueue the OSM import as a pg-boss job — imports never need a terminal
 * (docs/ROADMAP.md §3). singletonKey guarantees only one queued/active
 * import at a time; boss.send returns null on conflict.
 */
export async function enqueueImport(formData: FormData): Promise<void> {
  // Imports rewrite national data — admin only, not moderators.
  const { id: actor } = await requireRole('admin');
  const dryRun = formData.get('mode') !== 'live';

  const boss = await getBoss();
  await boss.createQueue(IMPORT_QUEUE);
  const jobId = await boss.send(IMPORT_QUEUE, { dryRun, actor }, { singletonKey: IMPORT_QUEUE });

  redirect(`/admin/import?${jobId ? 'enqueued=1' : 'conflict=1'}`);
}
