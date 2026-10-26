import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PopsMark } from '@/components/shell/pops-mark';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  classifyTikTokError,
  fetchUserInfo,
  queryCreatorInfo,
  type CreatorInfo,
  type TikTokProblem,
  type TikTokUser,
} from '@/lib/tiktok/api';
import { getTikTokDemoConfig, TIKTOK_START_PATH } from '@/lib/tiktok/config';
import { PAGE_ERRORS, SESSION_COOKIE, type PageError } from '@/lib/tiktok/http';
import { tiktokSessions } from '@/lib/tiktok/session-store';
import { LOGOUT_PATH, MAX_VIDEO_BYTES } from '@/lib/tiktok/shared';

import { PostForm } from './post-form';

/**
 * /tiktok — the demo TikTok's app reviewers watch: connect a
 * TikTok account, see whose account a post goes to, post one video through
 * the Content Posting API, follow its status.
 *
 * Each requested scope shows on screen: user.info.basic as „Connected as …“
 * (GET /v2/user/info/), video.publish as „Videos you post here go to …“
 * (creator_info) and the post itself.
 *
 * 404 unless the flag is on (lib/tiktok/config.ts). Dynamic on purpose: the
 * flag is read per request, so a build made with the flag off can never bake
 * a static 404 — or a static page — into the image.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'POPS — post a video to TikTok',
  robots: { index: false, follow: false },
};

const PAGE_MESSAGES: Record<PageError, string> = {
  denied: 'You cancelled the TikTok sign-in. Nothing was shared with POPS.',
  tiktok: 'TikTok could not complete the sign-in. Please try again.',
  missing: 'This sign-in link is incomplete. Please start again with “Continue with TikTok”.',
  state: 'This sign-in expired or did not start on this page. Please try again.',
  token: 'We could not finish signing you in with TikTok. Please try again.',
  scope:
    'POPS needs permission to post videos to your TikTok account. Please allow it when TikTok asks.',
  rate: 'Too many sign-in attempts. Please wait a few minutes and try again.',
};

const ACCOUNT_MESSAGES: Record<TikTokProblem, string> = {
  session: 'Your TikTok session has ended. Please connect again.',
  cannot_post: 'TikTok says this account can’t post more videos right now. Please try again later.',
  private_account_required:
    'TikTok only lets this app post to private accounts for now. Set the TikTok account to private and reload this page.',
  privacy: 'TikTok did not accept the privacy settings. Please reload this page.',
  scope:
    'POPS doesn’t have permission to post to this TikTok account. Disconnect and connect again.',
  tiktok_rate: 'TikTok is busy right now. Please reload this page in a minute.',
  tiktok: 'We couldn’t reach TikTok just now. Please reload this page in a moment.',
};

function pageError(raw: string | string[] | undefined): PageError | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (PAGE_ERRORS as readonly string[]).includes(value ?? '') ? (value as PageError) : null;
}

const link = 'font-semibold text-brand underline underline-offset-2 hover:no-underline';

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TikTokDemoPage({ searchParams }: Props) {
  const config = getTikTokDemoConfig();
  if (!config.enabled) notFound();

  const params = await searchParams;
  const error = pageError(params.error);
  const signedOut = params.signed_out === '1';

  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = tiktokSessions().get(sessionId);

  let user: TikTokUser | null = null;
  let creator: CreatorInfo | null = null;
  let problem: TikTokProblem | null = null;
  if (sessionId && session) {
    // Fresh on every render, as TikTok's guidelines ask: the creator's
    // privacy options and switches can change between visits.
    const [userResult, creatorResult] = await Promise.all([
      fetchUserInfo(config, session.accessToken),
      queryCreatorInfo(config, session.accessToken),
    ]);
    if (userResult.ok) user = userResult.data;
    if (creatorResult.ok) creator = creatorResult.data;
    else problem = classifyTikTokError(creatorResult.code, creatorResult.status);
    if (!userResult.ok && classifyTikTokError(userResult.code, userResult.status) === 'session') {
      problem = 'session';
    }
    if (problem === 'session') tiktokSessions().delete(sessionId);
  }
  const connected = Boolean(session) && problem !== 'session';
  const avatar = user?.avatarUrl ?? creator?.avatarUrl ?? null;
  const name = user?.displayName || creator?.nickname || '';

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-6 px-4 py-10">
      <header className="flex items-center gap-3">
        <PopsMark size={40} className="text-accent" />
        <div>
          <p className="font-mono text-caption font-semibold uppercase tracking-overline text-text-muted">
            POPS · pops.bg
          </p>
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">Post a video to TikTok</h1>
        </div>
      </header>

      <div className="flex flex-col gap-3 text-body text-ink-soft">
        <p>
          POPS (pops.bg) is a free map of public sports facilities in Bulgaria, run by a non-profit.
          We post our own short videos — new places on the map, tips for playing outdoors — to our
          TikTok account. This page connects a TikTok account and posts a video you choose to it.
        </p>
        <p className="text-body-sm" data-testid="tiktok-legal-links">
          <Link href="/usloviya" prefetch={false} className={link}>
            Terms of use
          </Link>{' '}
          ·{' '}
          <Link href="/privacy" prefetch={false} className={link}>
            Privacy policy
          </Link>{' '}
          <span className="text-text-muted">
            (in Bulgarian; in English:{' '}
            <Link href="/en/usloviya" prefetch={false} className={link}>
              terms
            </Link>
            ,{' '}
            <Link href="/en/privacy" prefetch={false} className={link}>
              privacy
            </Link>
            )
          </span>
        </p>
      </div>

      {error ? (
        <p
          role="alert"
          data-testid="tiktok-page-error"
          className="rounded-card border border-danger-border bg-danger-bg p-4 text-body-sm text-ink"
        >
          {PAGE_MESSAGES[error]}
        </p>
      ) : null}
      {signedOut && !connected ? (
        <p
          role="status"
          data-testid="tiktok-signed-out"
          className="rounded-card border border-info-border bg-info-bg p-4 text-body-sm text-ink"
        >
          You disconnected TikTok. POPS no longer has access to your account.
        </p>
      ) : null}
      {problem ? (
        <p
          role="alert"
          data-testid="tiktok-account-problem"
          className="rounded-card border border-warning-border bg-warning-bg p-4 text-body-sm text-ink"
        >
          {ACCOUNT_MESSAGES[problem]}
        </p>
      ) : null}

      {!connected ? (
        <section className="flex flex-col items-start gap-3">
          <a
            href={TIKTOK_START_PATH}
            data-testid="tiktok-connect"
            className={buttonVariants({ size: 'lg' })}
          >
            Continue with TikTok
          </a>
          <p className="text-body-sm text-text-muted">
            You’ll sign in on TikTok and choose what to allow. POPS asks for your basic profile (to
            show which account you’re connected as) and permission to post the videos you choose
            here.
          </p>
        </section>
      ) : null}

      {connected && (user || creator) ? (
        <section
          aria-label="TikTok account"
          className="flex items-center gap-3 rounded-card border border-line bg-surface p-4 shadow-sm"
        >
          {avatar ? (
            // A TikTok-hosted, signed avatar URL: next/image would need the
            // CDN allow-listed and would proxy it; a plain img sends no
            // referrer and loads straight from TikTok.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatar}
              alt=""
              width={48}
              height={48}
              referrerPolicy="no-referrer"
              className="size-12 shrink-0 rounded-full bg-surface-2 object-cover"
            />
          ) : (
            <span
              aria-hidden="true"
              className="grid size-12 shrink-0 place-items-center rounded-full bg-surface-2 text-h3 font-bold text-ink-soft"
            >
              {name.slice(0, 1).toUpperCase() || '?'}
            </span>
          )}
          <div className="min-w-0">
            {user ? (
              <p className="text-body text-ink" data-testid="tiktok-connected-as">
                Connected to TikTok as{' '}
                <strong className="font-bold">{user.displayName || 'your TikTok account'}</strong>
              </p>
            ) : null}
            {creator ? (
              <p className="truncate text-body-sm text-ink-soft" data-testid="tiktok-posting-to">
                Videos you post here go to{' '}
                <strong className="font-semibold text-ink">
                  {creator.nickname || 'this account'}
                </strong>
                {creator.username ? ` (@${creator.username})` : ''}
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      {connected && creator && problem === null ? (
        <PostForm
          creator={{
            nickname: creator.nickname,
            privacyLevelOptions: creator.privacyLevelOptions,
            commentDisabled: creator.commentDisabled,
            duetDisabled: creator.duetDisabled,
            stitchDisabled: creator.stitchDisabled,
            maxVideoPostDurationSec: creator.maxVideoPostDurationSec,
          }}
          maxBytes={MAX_VIDEO_BYTES}
        />
      ) : null}

      {connected ? (
        <form method="post" action={LOGOUT_PATH}>
          <Button type="submit" variant="secondary" size="sm" data-testid="tiktok-disconnect">
            Disconnect TikTok
          </Button>
        </form>
      ) : null}

      <footer className="mt-auto border-t border-line pt-4 text-caption text-text-muted">
        How this page handles your TikTok data: the sign-in token stays in our server’s memory for
        at most two hours and is never written to a database or a log. Your video goes straight to
        TikTok; POPS keeps no copy. Disconnect at any time.
      </footer>
    </main>
  );
}
