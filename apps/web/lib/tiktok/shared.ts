/**
 * The /tiktok demo's constants and types that the browser form needs too.
 * Client-safe on purpose: no fetch, no env, no node: imports — the post form
 * (app/tiktok/post-form.tsx) imports this file and nothing else from
 * lib/tiktok, so no server code can ride into the client bundle with it.
 */

export const PRIVACY_LEVELS = [
  'PUBLIC_TO_EVERYONE',
  'MUTUAL_FOLLOW_FRIENDS',
  'FOLLOWER_OF_CREATOR',
  'SELF_ONLY',
] as const;
export type PrivacyLevel = (typeof PRIVACY_LEVELS)[number];

export function isPrivacyLevel(value: unknown): value is PrivacyLevel {
  return typeof value === 'string' && (PRIVACY_LEVELS as readonly string[]).includes(value);
}

export const PUBLISH_STATUSES = [
  'PROCESSING_UPLOAD',
  'PROCESSING_DOWNLOAD',
  'SEND_TO_USER_INBOX',
  'PUBLISH_COMPLETE',
  'FAILED',
] as const;
export type PublishStatus = (typeof PUBLISH_STATUSES)[number];

/** The video cap (the brief: 50 MB). TikTok takes up to 64 MB in one chunk. */
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
/** TikTok's limit for `title`, in UTF-16 code units — which is what .length counts. */
export const MAX_TITLE_LENGTH = 2200;

export const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'] as const;
export type VideoType = (typeof VIDEO_TYPES)[number];

/** Multipart field names shared by the form and /tiktok/publish. A flag is on when its value is "1". */
export const FIELDS = {
  video: 'video',
  title: 'title',
  privacy: 'privacy_level',
  allowComment: 'allow_comment',
  allowDuet: 'allow_duet',
  allowStitch: 'allow_stitch',
  disclose: 'disclose',
  yourBrand: 'your_brand',
  brandedContent: 'branded_content',
  aigc: 'is_aigc',
} as const;

/** What the page hands the form: the creator's settings, never the token. */
export interface CreatorView {
  nickname: string;
  privacyLevelOptions: PrivacyLevel[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec: number | null;
}

/** The URLs the form, the status poll and the sign-out post to. */
export const PUBLISH_PATH = '/tiktok/publish';
export const STATUS_PATH = '/tiktok/status';
export const LOGOUT_PATH = '/tiktok/logout';
