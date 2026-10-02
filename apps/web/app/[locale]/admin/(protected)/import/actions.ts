'use server';

import { redirect } from 'next/navigation';

import { getBoss, IMPORT_QUEUE } from '@/lib/admin-boss';
import { requireRole } from '@/lib/auth-session';

/**
 * Enqueue the OSM import as a pg-boss job — imports never need a terminal
 * (docs/ROADMAP.md §3). On a 'stately' queue the singletonKey allows at most one
 * import WAITING and one RUNNING; a further send returns null, which the page
 * reports as a conflict. On pg-boss 10's default 'standard' policy a
 * singletonKey is enforced by nothing, which is why the policy is declared here
 * and converged by the worker at boot (apps/worker/src/index.ts) — createQueue
 * alone never changes a queue that already exists.
 */
export async function enqueueImport(formData: FormData): Promise<void> {
  // Imports rewrite national data — admin only, not moderators.
  const { id: actor } = await requireRole('admin');
  const dryRun = formData.get('mode') !== 'live';

  const boss = await getBoss();
  await boss.createQueue(IMPORT_QUEUE, { name: IMPORT_QUEUE, policy: 'stately' });
  const jobId = await boss.send(IMPORT_QUEUE, { dryRun, actor }, { singletonKey: IMPORT_QUEUE });

  redirect(`/admin/import?${jobId ? 'enqueued=1' : 'conflict=1'}`);
}
