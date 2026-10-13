import { describe, expect, it } from 'vitest';

import {
  acceptedVideoType,
  MAX_REQUEST_BYTES,
  parsePublishForm,
  readBodyCapped,
  sniffVideoType,
} from '@/lib/tiktok/publish-form';
import { FIELDS, MAX_TITLE_LENGTH, MAX_VIDEO_BYTES, type PrivacyLevel } from '@/lib/tiktok/shared';

/** The first bytes of real files: an MP4 `ftyp isom` box, a MOV `ftyp qt  `, a WebM EBML header. */
const MP4_HEAD = Uint8Array.from([
  0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
]);
const MOV_HEAD = Uint8Array.from([
  0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20, 0x00, 0x00, 0x00, 0x00,
]);
const OLD_MOV_HEAD = Uint8Array.from([0x00, 0x00, 0x00, 0x08, 0x77, 0x69, 0x64, 0x65]);
const WEBM_HEAD = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
const PNG_HEAD = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const CREATOR = {
  privacyLevelOptions: ['PUBLIC_TO_EVERYONE', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'] as PrivacyLevel[],
  commentDisabled: false,
  duetDisabled: false,
  stitchDisabled: false,
};

function form(fields: Record<string, string>, video: File | null = videoFile()): FormData {
  const data = new FormData();
  if (video) data.set(FIELDS.video, video);
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

function videoFile(type = 'video/mp4', head: Uint8Array<ArrayBuffer> = MP4_HEAD): File {
  return new File([head, new Uint8Array(64)], 'clip.mp4', { type });
}

describe('what a video file really is', () => {
  it('reads the container from the first bytes', () => {
    expect(sniffVideoType(MP4_HEAD)).toBe('video/mp4');
    expect(sniffVideoType(MOV_HEAD)).toBe('video/quicktime');
    expect(sniffVideoType(OLD_MOV_HEAD)).toBe('video/quicktime');
    expect(sniffVideoType(WEBM_HEAD)).toBe('video/webm');
    expect(sniffVideoType(PNG_HEAD)).toBeNull();
    expect(sniffVideoType(new Uint8Array(3))).toBeNull();
  });

  it('accepts a declared type only when the bytes agree (MP4 and MOV are one family)', () => {
    expect(acceptedVideoType('video/mp4', MP4_HEAD)).toBe('video/mp4');
    expect(acceptedVideoType('video/quicktime', MP4_HEAD)).toBe('video/quicktime');
    expect(acceptedVideoType('video/mp4', MOV_HEAD)).toBe('video/mp4');
    expect(acceptedVideoType('video/webm', WEBM_HEAD)).toBe('video/webm');
    expect(acceptedVideoType('video/webm', MP4_HEAD)).toBeNull();
    expect(acceptedVideoType('video/mp4', WEBM_HEAD)).toBeNull();
    expect(acceptedVideoType('video/mp4', PNG_HEAD)).toBeNull();
    expect(acceptedVideoType('video/x-msvideo', MP4_HEAD)).toBeNull();
  });
});

describe('the post form, as the server enforces it', () => {
  it('needs a non-empty video of an accepted type', () => {
    expect(parsePublishForm(form({ [FIELDS.privacy]: 'SELF_ONLY' }, null), CREATOR)).toEqual({
      ok: false,
      error: 'no_video',
    });
    const empty = new File([], 'empty.mp4', { type: 'video/mp4' });
    expect(parsePublishForm(form({ [FIELDS.privacy]: 'SELF_ONLY' }, empty), CREATOR)).toEqual({
      ok: false,
      error: 'no_video',
    });
    const avi = videoFile('video/x-msvideo');
    expect(parsePublishForm(form({ [FIELDS.privacy]: 'SELF_ONLY' }, avi), CREATOR)).toEqual({
      ok: false,
      error: 'bad_type',
    });
  });

  it('caps the caption at TikTok’s 2200 characters', () => {
    const ok = parsePublishForm(
      form({ [FIELDS.privacy]: 'SELF_ONLY', [FIELDS.title]: 'а'.repeat(MAX_TITLE_LENGTH) }),
      CREATOR,
    );
    expect(ok.ok).toBe(true);
    expect(
      parsePublishForm(
        form({ [FIELDS.privacy]: 'SELF_ONLY', [FIELDS.title]: 'а'.repeat(MAX_TITLE_LENGTH + 1) }),
        CREATOR,
      ),
    ).toEqual({ ok: false, error: 'title_too_long' });
  });

  it('has no default privacy: it must be one of the options TikTok offered', () => {
    expect(parsePublishForm(form({}), CREATOR)).toEqual({ ok: false, error: 'privacy' });
    expect(parsePublishForm(form({ [FIELDS.privacy]: 'MUTUAL_FOLLOW_FRIENDS' }), CREATOR)).toEqual({
      ok: false,
      error: 'privacy',
    });
    expect(parsePublishForm(form({ [FIELDS.privacy]: 'EVERYONE' }), CREATOR)).toEqual({
      ok: false,
      error: 'privacy',
    });
  });

  it('turns every interaction off unless the user allowed it', () => {
    const parsed = parsePublishForm(form({ [FIELDS.privacy]: 'PUBLIC_TO_EVERYONE' }), CREATOR);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.postInfo).toEqual({
      title: '',
      privacy_level: 'PUBLIC_TO_EVERYONE',
      disable_comment: true,
      disable_duet: true,
      disable_stitch: true,
      brand_content_toggle: false,
      brand_organic_toggle: false,
      is_aigc: false,
    });
  });

  it('keeps an interaction off where the creator’s own settings turned it off', () => {
    const allowAll = {
      [FIELDS.privacy]: 'PUBLIC_TO_EVERYONE',
      [FIELDS.allowComment]: '1',
      [FIELDS.allowDuet]: '1',
      [FIELDS.allowStitch]: '1',
    };
    const open = parsePublishForm(form(allowAll), CREATOR);
    if (!open.ok) throw new Error(open.error);
    expect(open.value.postInfo).toMatchObject({
      disable_comment: false,
      disable_duet: false,
      disable_stitch: false,
    });
    const locked = parsePublishForm(form(allowAll), {
      ...CREATOR,
      commentDisabled: true,
      duetDisabled: true,
      stitchDisabled: true,
    });
    if (!locked.ok) throw new Error(locked.error);
    expect(locked.value.postInfo).toMatchObject({
      disable_comment: true,
      disable_duet: true,
      disable_stitch: true,
    });
  });

  it('asks which kind of commercial content once disclosure is on', () => {
    expect(
      parsePublishForm(form({ [FIELDS.privacy]: 'SELF_ONLY', [FIELDS.disclose]: '1' }), CREATOR),
    ).toEqual({ ok: false, error: 'disclosure_choice' });

    const ownBrand = parsePublishForm(
      form({ [FIELDS.privacy]: 'SELF_ONLY', [FIELDS.disclose]: '1', [FIELDS.yourBrand]: '1' }),
      CREATOR,
    );
    if (!ownBrand.ok) throw new Error(ownBrand.error);
    expect(ownBrand.value.postInfo).toMatchObject({
      brand_organic_toggle: true,
      brand_content_toggle: false,
    });
  });

  it('never posts branded content as private', () => {
    expect(
      parsePublishForm(
        form({
          [FIELDS.privacy]: 'SELF_ONLY',
          [FIELDS.disclose]: '1',
          [FIELDS.brandedContent]: '1',
        }),
        CREATOR,
      ),
    ).toEqual({ ok: false, error: 'branded_private' });

    const branded = parsePublishForm(
      form({
        [FIELDS.privacy]: 'FOLLOWER_OF_CREATOR',
        [FIELDS.disclose]: '1',
        [FIELDS.brandedContent]: '1',
      }),
      CREATOR,
    );
    if (!branded.ok) throw new Error(branded.error);
    expect(branded.value.postInfo.brand_content_toggle).toBe(true);
  });

  it('ignores the commercial-content boxes while disclosure is off', () => {
    const parsed = parsePublishForm(
      form({
        [FIELDS.privacy]: 'SELF_ONLY',
        [FIELDS.yourBrand]: '1',
        [FIELDS.brandedContent]: '1',
      }),
      CREATOR,
    );
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.postInfo).toMatchObject({
      brand_organic_toggle: false,
      brand_content_toggle: false,
    });
  });
});

describe('reading an upload with a hard cap', () => {
  function stream(chunks: number[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const size of chunks) controller.enqueue(new Uint8Array(size).fill(7));
        controller.close();
      },
    });
  }

  it('returns the whole body when it fits', async () => {
    const body = await readBodyCapped(stream([3, 4, 5]), 12);
    expect(body?.byteLength).toBe(12);
    expect(body?.every((b) => b === 7)).toBe(true);
    expect((await readBodyCapped(null, 10))?.byteLength).toBe(0);
  });

  it('stops as soon as the body passes the cap', async () => {
    expect(await readBodyCapped(stream([8, 8]), 12)).toBeNull();
  });

  it('leaves room for the form envelope around a 50 MB video', () => {
    expect(MAX_VIDEO_BYTES).toBe(50 * 1024 * 1024);
    expect(MAX_REQUEST_BYTES).toBeGreaterThan(MAX_VIDEO_BYTES);
    expect(MAX_REQUEST_BYTES - MAX_VIDEO_BYTES).toBeLessThanOrEqual(64 * 1024);
  });
});
