'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

import {
  FIELDS,
  MAX_TITLE_LENGTH,
  PUBLISH_PATH,
  STATUS_PATH,
  VIDEO_TYPES,
  type CreatorView,
  type PrivacyLevel,
  type PublishStatus,
} from '@/lib/tiktok/shared';

/**
 * The post form, built to TikTok's content-sharing guidelines
 * (developers.tiktok.com/doc/content-sharing-guidelines) — the PR description
 * maps each requirement to this file:
 *   - a preview of the video, and its length checked against the creator's
 *     max_video_post_duration_sec;
 *   - an editable caption, empty to start with;
 *   - privacy from the creator's privacy_level_options, with NO default;
 *   - comment / Duet / Stitch off until the user turns them on, and greyed out
 *     where the creator's TikTok settings disable them;
 *   - the commercial-content disclosure, off by default, with „Your brand“ /
 *     „Branded content“, their labels, and branded content never private;
 *   - the Music Usage Confirmation (and Branded Content Policy) declaration
 *     right above the button;
 *   - nothing leaves the browser until „Post to TikTok“ is pressed;
 *   - afterwards: the processing note and the polled publish status.
 * The server re-checks every rule (lib/tiktok/publish-form.ts).
 */

const PRIVACY_LABELS: Record<PrivacyLevel, string> = {
  PUBLIC_TO_EVERYONE: 'Everyone',
  MUTUAL_FOLLOW_FRIENDS: 'Friends',
  FOLLOWER_OF_CREATOR: 'Followers',
  SELF_ONLY: 'Only me',
};

const STATUS_LABELS: Record<PublishStatus, string> = {
  PROCESSING_UPLOAD: 'TikTok is processing your video…',
  PROCESSING_DOWNLOAD: 'TikTok is processing your video…',
  SEND_TO_USER_INBOX: 'Sent to your TikTok inbox to finish posting.',
  PUBLISH_COMPLETE: 'Posted to your TikTok profile.',
  FAILED: 'TikTok could not post this video.',
};

const ERROR_MESSAGES = {
  session: 'Your TikTok session has ended. Reload the page and connect again.',
  rate: 'You’ve posted several videos in a short time. Please wait a few minutes.',
  busy: 'Another video is uploading right now. Please try again in a minute.',
  too_large: 'This video is larger than 50 MB.',
  bad_type: 'Please choose an MP4, MOV or WebM video.',
  no_video: 'Please choose a video.',
  title_too_long: `The caption can be at most ${MAX_TITLE_LENGTH} characters.`,
  privacy: 'Please choose who can see this video.',
  disclosure_choice:
    'You need to indicate if your content promotes yourself, a third party, or both.',
  branded_private: 'Branded content visibility cannot be set to private.',
  cannot_post: 'TikTok says this account can’t post more videos right now. Please try again later.',
  private_account_required:
    'TikTok only lets this app post to private accounts until its review is complete. Set the TikTok account to private and try again.',
  scope:
    'POPS doesn’t have permission to post to this TikTok account. Disconnect and connect again.',
  tiktok_rate: 'TikTok is busy right now. Please try again in a minute.',
} as const;
const GENERIC_ERROR = 'Something went wrong while sending the video to TikTok. Please try again.';

/** The message for an error code from /tiktok/publish; the generic one for anything else. */
function errorMessage(code: string | undefined): string {
  return code !== undefined && Object.hasOwn(ERROR_MESSAGES, code)
    ? ERROR_MESSAGES[code as keyof typeof ERROR_MESSAGES]
    : GENERIC_ERROR;
}

const MUSIC_USAGE_URL = 'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en';
const BRANDED_CONTENT_POLICY_URL = 'https://www.tiktok.com/legal/page/global/bc-policy/en';

const POLL_EVERY_MS = 5_000;
const POLL_FOR_MS = 2 * 60_000;

type Phase =
  | { kind: 'editing' }
  | { kind: 'sending' }
  | {
      kind: 'sent';
      publishId: string;
      status: PublishStatus | null;
      failReason: string | null;
      gaveUp: boolean;
    };

function formatSeconds(total: number): string {
  const s = Math.round(total);
  if (s < 60) return `${s} s`;
  const rest = s % 60;
  return rest ? `${Math.floor(s / 60)} min ${rest} s` : `${s / 60} min`;
}

export function PostForm({ creator, maxBytes }: { creator: CreatorView; maxBytes: number }) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [durationUnknown, setDurationUnknown] = useState(false);
  const [title, setTitle] = useState('');
  const [privacy, setPrivacy] = useState<PrivacyLevel | ''>('');
  const [allowComment, setAllowComment] = useState(false);
  const [allowDuet, setAllowDuet] = useState(false);
  const [allowStitch, setAllowStitch] = useState(false);
  const [disclose, setDisclose] = useState(false);
  const [yourBrand, setYourBrand] = useState(false);
  const [branded, setBranded] = useState(false);
  const [aigc, setAigc] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'editing' });
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // The preview's object URL lives exactly as long as the chosen file.
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setPreviewUrl(null);
    };
  }, [file]);

  // Poll the publish status every 5 s for up to 2 min, until TikTok says done or failed.
  const publishId = phase.kind === 'sent' ? phase.publishId : null;
  useEffect(() => {
    if (!publishId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const poll = async () => {
      try {
        const response = await fetch(`${STATUS_PATH}?publish_id=${encodeURIComponent(publishId)}`, {
          cache: 'no-store',
        });
        const body = (await response.json()) as {
          status?: PublishStatus;
          failReason?: string | null;
        };
        if (stopped) return;
        if (response.ok && body.status) {
          const status = body.status;
          setPhase((p) =>
            p.kind === 'sent' ? { ...p, status, failReason: body.failReason ?? null } : p,
          );
          if (status === 'PUBLISH_COMPLETE' || status === 'FAILED') return;
        }
      } catch {
        // A missed poll is retried on the next tick.
      }
      if (stopped) return;
      if (Date.now() - started >= POLL_FOR_MS) {
        setPhase((p) => (p.kind === 'sent' ? { ...p, gaveUp: true } : p));
        return;
      }
      timer = setTimeout(() => void poll(), POLL_EVERY_MS);
    };
    timer = setTimeout(() => void poll(), 1_000);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [publishId]);

  const maxDuration = creator.maxVideoPostDurationSec;
  const tooLong = maxDuration !== null && duration !== null && duration > maxDuration;
  const tooBig = file !== null && file.size > maxBytes;
  const wrongType = file !== null && !(VIDEO_TYPES as readonly string[]).includes(file.type);
  const disclosureIncomplete = disclose && !yourBrand && !branded;
  const brandedLabel = disclose && branded;

  const blocker: string | null = !file
    ? 'Choose a video first.'
    : wrongType
      ? ERROR_MESSAGES.bad_type
      : tooBig
        ? ERROR_MESSAGES.too_large
        : tooLong
          ? `This video is ${formatSeconds(duration)} long; this account can post videos up to ${formatSeconds(maxDuration)}.`
          : !privacy
            ? 'Choose who can see this video.'
            : disclosureIncomplete
              ? ERROR_MESSAGES.disclosure_choice
              : null;

  const busy = phase.kind === 'sending';

  function chooseFile(next: File | null) {
    setFile(next);
    setDuration(null);
    setDurationUnknown(false);
    setError(null);
  }

  function choosePrivacy(value: string) {
    const next = value as PrivacyLevel | '';
    setPrivacy(next);
    // Branded content can't be private: picking „Only me“ clears it (the
    // checkbox is disabled while „Only me“ is selected).
    if (next === 'SELF_ONLY') setBranded(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocker || busy || !file || !privacy) return;
    setError(null);
    setPhase({ kind: 'sending' });

    const data = new FormData();
    data.set(FIELDS.video, file);
    data.set(FIELDS.title, title);
    data.set(FIELDS.privacy, privacy);
    if (allowComment && !creator.commentDisabled) data.set(FIELDS.allowComment, '1');
    if (allowDuet && !creator.duetDisabled) data.set(FIELDS.allowDuet, '1');
    if (allowStitch && !creator.stitchDisabled) data.set(FIELDS.allowStitch, '1');
    if (disclose) {
      data.set(FIELDS.disclose, '1');
      if (yourBrand) data.set(FIELDS.yourBrand, '1');
      if (branded) data.set(FIELDS.brandedContent, '1');
    }
    if (aigc) data.set(FIELDS.aigc, '1');

    try {
      const response = await fetch(PUBLISH_PATH, { method: 'POST', body: data });
      const body = (await response.json().catch(() => ({}))) as {
        publishId?: string;
        error?: string;
      };
      if (response.ok && body.publishId) {
        setPhase({
          kind: 'sent',
          publishId: body.publishId,
          status: null,
          failReason: null,
          gaveUp: false,
        });
        return;
      }
      setError(errorMessage(body.error));
    } catch {
      setError(GENERIC_ERROR);
    }
    setPhase({ kind: 'editing' });
  }

  function reset() {
    chooseFile(null);
    if (fileInput.current) fileInput.current.value = '';
    setTitle('');
    setPrivacy('');
    setAllowComment(false);
    setAllowDuet(false);
    setAllowStitch(false);
    setDisclose(false);
    setYourBrand(false);
    setBranded(false);
    setAigc(false);
    setPhase({ kind: 'editing' });
  }

  if (phase.kind === 'sent') {
    const done = phase.status === 'PUBLISH_COMPLETE';
    const failed = phase.status === 'FAILED';
    return (
      <section
        aria-live="polite"
        className="flex flex-col gap-3 rounded-card border border-line bg-surface p-5 shadow-sm"
        data-testid="tiktok-status"
      >
        <h2 className="text-h3 font-bold text-ink">Your video is on its way to TikTok</h2>
        <p className="text-body-sm text-ink-soft">
          It may take a few minutes for TikTok to process it and for it to appear on your profile.
        </p>
        <p className="text-body font-semibold text-ink" data-testid="tiktok-status-text">
          {phase.status ? STATUS_LABELS[phase.status] : 'Checking the status with TikTok…'}
          {failed && phase.failReason ? ` (${phase.failReason})` : ''}
        </p>
        {done && privacy ? (
          <p className="text-body-sm text-ink-soft">Who can see it: {PRIVACY_LABELS[privacy]}.</p>
        ) : null}
        {phase.gaveUp && !done && !failed ? (
          <p className="text-body-sm text-ink-soft">
            Still processing. Check your TikTok profile in a few minutes.
          </p>
        ) : null}
        <button
          type="button"
          onClick={reset}
          className="self-start text-body-sm font-semibold text-brand underline-offset-2 hover:underline"
        >
          Post another video
        </button>
      </section>
    );
  }

  const checkboxRow = 'flex items-start gap-3 text-body-sm text-ink';
  const box = 'mt-0.5 size-5 shrink-0 accent-[var(--brand)] disabled:cursor-not-allowed';

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-6"
      data-testid="tiktok-post-form"
      noValidate
    >
      {/* 1. The video, with a preview and the creator's length limit. */}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-body font-semibold text-ink">Video</legend>
        <input
          ref={fileInput}
          type="file"
          name={FIELDS.video}
          accept={VIDEO_TYPES.join(',')}
          onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
          className="text-body-sm text-ink file:mr-3 file:rounded-pill file:border file:border-line-strong file:bg-surface file:px-4 file:py-2 file:font-semibold"
          data-testid="tiktok-video-input"
        />
        <p className="text-caption text-text-muted">
          MP4, MOV or WebM, up to 50 MB
          {maxDuration !== null ? `, up to ${formatSeconds(maxDuration)} long` : ''}.
        </p>
        {previewUrl ? (
          <video
            key={previewUrl}
            src={previewUrl}
            controls
            muted
            playsInline
            preload="metadata"
            data-testid="tiktok-preview"
            onLoadedMetadata={(e) => {
              const d = e.currentTarget.duration;
              if (Number.isFinite(d)) setDuration(d);
              else setDurationUnknown(true);
            }}
            onError={() => setDurationUnknown(true)}
            className="max-h-96 w-full rounded-card bg-ink object-contain"
          />
        ) : null}
        {duration !== null ? (
          <p className="text-caption text-text-muted" data-testid="tiktok-duration">
            Length: {formatSeconds(duration)}
          </p>
        ) : null}
        {durationUnknown ? (
          <p className="text-caption text-text-muted">
            This browser can’t preview the video, so its length can’t be checked here; TikTok will
            check it.
          </p>
        ) : null}
      </fieldset>

      {/* 2. The caption: empty to start with, entirely the user's. */}
      <label className="flex flex-col gap-2">
        <span className="text-body font-semibold text-ink">Caption</span>
        <textarea
          name={FIELDS.title}
          value={title}
          maxLength={MAX_TITLE_LENGTH}
          rows={4}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Write a caption (optional)"
          className="w-full rounded-input border border-line-strong bg-surface px-3.5 py-2.5 text-body text-ink placeholder:text-text-muted focus-visible:border-brand"
          data-testid="tiktok-caption"
        />
        <span className="self-end text-caption text-text-muted">
          {title.length} / {MAX_TITLE_LENGTH}
        </span>
      </label>

      {/* 3. Privacy: TikTok's options for this creator, no default. */}
      <label className="flex flex-col gap-2">
        <span className="text-body font-semibold text-ink">Who can see this video</span>
        <select
          name={FIELDS.privacy}
          value={privacy}
          required
          onChange={(e) => choosePrivacy(e.target.value)}
          className="h-11 w-full rounded-input border border-line-strong bg-surface px-3.5 text-body text-ink focus-visible:border-brand"
          data-testid="tiktok-privacy"
        >
          <option value="" disabled>
            Choose…
          </option>
          {creator.privacyLevelOptions.map((level) => {
            const blockedByBranded = level === 'SELF_ONLY' && brandedLabel;
            return (
              <option
                key={level}
                value={level}
                disabled={blockedByBranded}
                title={
                  blockedByBranded
                    ? 'Branded content visibility cannot be set to private.'
                    : undefined
                }
              >
                {PRIVACY_LABELS[level]}
                {blockedByBranded ? ' (not available for branded content)' : ''}
              </option>
            );
          })}
        </select>
        {brandedLabel ? (
          <span className="text-caption text-text-muted">
            Branded content visibility cannot be set to private.
          </span>
        ) : null}
      </label>

      {/* 4. Interactions: off by default, greyed out where TikTok settings say no. */}
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-body font-semibold text-ink">Allow others to</legend>
        {(
          [
            [
              'Comment',
              allowComment,
              setAllowComment,
              creator.commentDisabled,
              FIELDS.allowComment,
            ],
            ['Duet', allowDuet, setAllowDuet, creator.duetDisabled, FIELDS.allowDuet],
            ['Stitch', allowStitch, setAllowStitch, creator.stitchDisabled, FIELDS.allowStitch],
          ] as const
        ).map(([label, checked, set, disabled, name]) => (
          <label key={name} className={`${checkboxRow} ${disabled ? 'opacity-50' : ''}`}>
            <input
              type="checkbox"
              name={name}
              checked={checked && !disabled}
              disabled={disabled}
              onChange={(e) => set(e.target.checked)}
              className={box}
              data-testid={`tiktok-allow-${label.toLowerCase()}`}
            />
            <span>
              {label}
              {disabled ? (
                <span className="block text-caption text-text-muted">
                  Turned off in your TikTok settings.
                </span>
              ) : null}
            </span>
          </label>
        ))}
      </fieldset>

      {/* 5. Commercial content disclosure: off by default. */}
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-body font-semibold text-ink">Commercial content</legend>
        <label className={checkboxRow}>
          <input
            type="checkbox"
            role="switch"
            name={FIELDS.disclose}
            checked={disclose}
            onChange={(e) => {
              setDisclose(e.target.checked);
              if (!e.target.checked) {
                setYourBrand(false);
                setBranded(false);
              }
            }}
            className={box}
            data-testid="tiktok-disclose"
          />
          <span>
            Disclose video content
            <span className="block text-caption text-text-muted">
              Turn on to say this video promotes yourself, a brand, a product or a service.
            </span>
          </span>
        </label>
        {disclose ? (
          <div className="ml-8 flex flex-col gap-3">
            <label className={checkboxRow}>
              <input
                type="checkbox"
                name={FIELDS.yourBrand}
                checked={yourBrand}
                onChange={(e) => setYourBrand(e.target.checked)}
                className={box}
                data-testid="tiktok-your-brand"
              />
              <span>
                Your brand
                <span className="block text-caption text-text-muted">
                  You are promoting yourself or your own business. This video will be classified as
                  Brand Organic.
                </span>
              </span>
            </label>
            <label
              className={`${checkboxRow} ${privacy === 'SELF_ONLY' ? 'opacity-50' : ''}`}
              title={
                privacy === 'SELF_ONLY'
                  ? 'Branded content visibility cannot be set to private.'
                  : undefined
              }
            >
              <input
                type="checkbox"
                name={FIELDS.brandedContent}
                checked={branded}
                disabled={privacy === 'SELF_ONLY'}
                onChange={(e) => setBranded(e.target.checked)}
                className={box}
                data-testid="tiktok-branded"
              />
              <span>
                Branded content
                <span className="block text-caption text-text-muted">
                  You are promoting another brand or a third party. This video will be classified as
                  Branded Content.
                  {privacy === 'SELF_ONLY'
                    ? ' Branded content visibility can’t be set to private.'
                    : ''}
                </span>
              </span>
            </label>
            <p className="text-body-sm font-semibold text-ink" data-testid="tiktok-label-prompt">
              {branded
                ? 'Your video will be labeled as “Paid partnership”.'
                : yourBrand
                  ? 'Your video will be labeled as “Promotional content”.'
                  : 'You need to indicate if your content promotes yourself, a third party, or both.'}
            </p>
          </div>
        ) : null}
      </fieldset>

      {/* 6. AI-generated content label (is_aigc). */}
      <label className={checkboxRow}>
        <input
          type="checkbox"
          name={FIELDS.aigc}
          checked={aigc}
          onChange={(e) => setAigc(e.target.checked)}
          className={box}
          data-testid="tiktok-aigc"
        />
        <span>
          AI-generated content
          <span className="block text-caption text-text-muted">
            Turn on if this video was made or substantially edited with AI. TikTok will label it as
            AI-generated.
          </span>
        </span>
      </label>

      {/* 7. The declaration, then the one button that sends anything. */}
      <div className="flex flex-col gap-3 border-t border-line pt-5">
        <p className="text-body-sm text-ink-soft" data-testid="tiktok-declaration">
          {brandedLabel ? (
            <>
              By posting, you agree to TikTok’s{' '}
              <a
                href={BRANDED_CONTENT_POLICY_URL}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-brand underline"
              >
                Branded Content Policy
              </a>{' '}
              and{' '}
              <a
                href={MUSIC_USAGE_URL}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-brand underline"
              >
                Music Usage Confirmation
              </a>
              .
            </>
          ) : (
            <>
              By posting, you agree to TikTok’s{' '}
              <a
                href={MUSIC_USAGE_URL}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-brand underline"
              >
                Music Usage Confirmation
              </a>
              .
            </>
          )}
        </p>
        <span title={blocker ?? undefined} className="self-start">
          <button
            type="submit"
            disabled={Boolean(blocker) || busy}
            className="inline-flex h-11 items-center rounded-pill bg-brand px-5 text-body-sm font-semibold text-on-brand shadow-xs hover:bg-brand-hover disabled:pointer-events-none disabled:opacity-50"
            data-testid="tiktok-post"
          >
            {busy ? 'Sending to TikTok…' : 'Post to TikTok'}
          </button>
        </span>
        {blocker && file ? (
          <p className="text-caption text-text-muted" data-testid="tiktok-blocker">
            {blocker}
          </p>
        ) : null}
        {error ? (
          <p
            role="alert"
            className="rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink"
            data-testid="tiktok-error"
          >
            {error}
          </p>
        ) : null}
        <p className="text-caption text-text-muted">
          Nothing is sent to TikTok until you press “Post to TikTok”. POPS adds no watermark or text
          to your video.
        </p>
      </div>
    </form>
  );
}
