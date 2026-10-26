import type { CreatorInfo, PostInfo } from './api';
import {
  FIELDS,
  isPrivacyLevel,
  MAX_TITLE_LENGTH,
  MAX_VIDEO_BYTES,
  VIDEO_TYPES,
  type PrivacyLevel,
  type VideoType,
} from './shared';

/**
 * The /tiktok/publish request: the rules the server enforces whatever the form
 * in the browser allowed. The browser form applies the same rules for the
 * user's sake (TikTok's content-sharing guidelines); this is the copy that
 * cannot be bypassed.
 */

/** The multipart envelope around the video: the caption and a few flags. */
export const MAX_REQUEST_BYTES = MAX_VIDEO_BYTES + 64 * 1024;

export type PublishFormError =
  | 'no_video'
  | 'too_large'
  | 'bad_type'
  | 'title_too_long'
  | 'privacy'
  | 'disclosure_choice'
  | 'branded_private';

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.subarray(from, to));
}

const QUICKTIME_ATOMS = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);

/**
 * What the file really is, from its first bytes — the declared type is only
 * the browser's guess from the extension.
 *   WebM/Matroska: the EBML magic 1A 45 DF A3.
 *   MP4 / MOV: an ISO BMFF `ftyp` box at offset 4 (brand `qt  ` = QuickTime),
 *   or, for older QuickTime files, another top-level atom there.
 */
export function sniffVideoType(head: Uint8Array): VideoType | null {
  if (
    head.length >= 4 &&
    head[0] === 0x1a &&
    head[1] === 0x45 &&
    head[2] === 0xdf &&
    head[3] === 0xa3
  ) {
    return 'video/webm';
  }
  if (head.length >= 12 && ascii(head, 4, 8) === 'ftyp') {
    return ascii(head, 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  if (head.length >= 8 && QUICKTIME_ATOMS.has(ascii(head, 4, 8))) return 'video/quicktime';
  return null;
}

function isVideoType(value: string): value is VideoType {
  return (VIDEO_TYPES as readonly string[]).includes(value);
}

/**
 * The declared type must be on the list and agree with the bytes. MP4 and MOV
 * share a container (and phones label either way), so they count as one family.
 */
export function acceptedVideoType(declared: string, head: Uint8Array): VideoType | null {
  if (!isVideoType(declared)) return null;
  const sniffed = sniffVideoType(head);
  if (!sniffed) return null;
  const family = (t: VideoType) => (t === 'video/webm' ? 'webm' : 'isobmff');
  return family(sniffed) === family(declared) ? declared : null;
}

function on(form: FormData, name: string): boolean {
  return form.get(name) === '1';
}

export interface PublishRequest {
  postInfo: PostInfo;
  video: File;
}

const SELF_ONLY: PrivacyLevel = 'SELF_ONLY';

/** Everything but the bytes themselves, which the route checks after reading them. */
export function parsePublishForm(
  form: FormData,
  creator: Pick<
    CreatorInfo,
    'privacyLevelOptions' | 'commentDisabled' | 'duetDisabled' | 'stitchDisabled'
  >,
): { ok: true; value: PublishRequest } | { ok: false; error: PublishFormError } {
  const video = form.get(FIELDS.video);
  if (!(video instanceof File) || video.size === 0) return { ok: false, error: 'no_video' };
  if (video.size > MAX_VIDEO_BYTES) return { ok: false, error: 'too_large' };
  if (!isVideoType(video.type)) return { ok: false, error: 'bad_type' };

  const rawTitle = form.get(FIELDS.title);
  const title = typeof rawTitle === 'string' ? rawTitle : '';
  if (title.length > MAX_TITLE_LENGTH) return { ok: false, error: 'title_too_long' };

  // No default: the user must have picked one of the options TikTok offered.
  const privacy = form.get(FIELDS.privacy);
  if (!isPrivacyLevel(privacy) || !creator.privacyLevelOptions.includes(privacy)) {
    return { ok: false, error: 'privacy' };
  }

  const disclose = on(form, FIELDS.disclose);
  const yourBrand = disclose && on(form, FIELDS.yourBrand);
  const branded = disclose && on(form, FIELDS.brandedContent);
  if (disclose && !yourBrand && !branded) return { ok: false, error: 'disclosure_choice' };
  if (branded && privacy === SELF_ONLY) return { ok: false, error: 'branded_private' };

  return {
    ok: true,
    value: {
      video,
      postInfo: {
        title,
        privacy_level: privacy,
        // Off unless the user turned it on, and never on where the creator's
        // own TikTok settings turned it off.
        disable_comment: creator.commentDisabled || !on(form, FIELDS.allowComment),
        disable_duet: creator.duetDisabled || !on(form, FIELDS.allowDuet),
        disable_stitch: creator.stitchDisabled || !on(form, FIELDS.allowStitch),
        brand_content_toggle: branded,
        brand_organic_toggle: yourBrand,
        is_aigc: on(form, FIELDS.aigc),
      },
    },
  };
}

/**
 * Read a request body, counting as it arrives; null as soon as it passes the
 * cap (the rest is never read). Content-Length is checked first by the route,
 * but the count is what actually bounds memory.
 */
export async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  cap: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
