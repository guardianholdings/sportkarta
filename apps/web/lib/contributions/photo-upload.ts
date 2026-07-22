import { randomUUID } from 'node:crypto';

import { InvalidPhotoError, MAX_PHOTO_BYTES, processReportPhoto } from '../image';
import { getStorage } from '../storage';

import { ContributionError } from './errors';

/**
 * Validate, EXIF-strip and store an uploaded contribution photo, returning the
 * storage key. Same pipeline the anonymous report flow uses: metadata (GPS
 * included) never survives, and the file lands through the storage adapter, so
 * a later move to MinIO/S3 changes nothing here.
 *
 * The file is written before the database transaction; callers must delete the
 * key if the transaction then fails, or it dangles with no row pointing at it.
 */
export async function storeContributionPhoto(
  file: unknown,
  prefix: 'facilities' | 'conditions',
): Promise<string> {
  if (!(file instanceof File) || file.size === 0) throw new ContributionError('photo_required');
  if (file.size > MAX_PHOTO_BYTES) throw new ContributionError('photo_too_large');

  let processed;
  try {
    processed = await processReportPhoto(new Uint8Array(await file.arrayBuffer()));
  } catch (error) {
    if (error instanceof InvalidPhotoError) throw new ContributionError('invalid_photo');
    throw error;
  }

  const now = new Date();
  const key = `${prefix}/${String(now.getUTCFullYear())}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${processed.extension}`;
  await getStorage().put(key, processed.data, { contentType: processed.contentType });
  return key;
}

/** Best-effort rollback of a stored file after a failed transaction. */
export async function discardContributionPhoto(key: string | null): Promise<void> {
  if (!key) return;
  await getStorage()
    .delete(key)
    .catch(() => undefined);
}
