/**
 * Share artifacts — what a member posts, per moment.
 *
 * THE PRODUCT GOAL is that sharing happens OFTEN. This module is the part of
 * that which can be reasoned about and tested: given a moment, it produces the
 * text, the link and the image references for it, so every surface shares in the
 * same shape and adding a new moment is one entry rather than a new component.
 *
 * WHAT MAKES SHARING FREQUENT, and what this file is built around:
 *   1. MANY TRIGGERS. Nine kinds, not one "share my profile" button — a member
 *      who just logged a run, earned a rung, changed division or turned up at a
 *      place has four different things to say, and each is a separate moment.
 *   2. FORMAT-NATIVE OUTPUT. A story is 1080×1920 and a feed post is a link with
 *      a 1200×630 preview; posting the wrong shape is what makes a share look
 *      like an ad. `storyPath` and `cardPath` are separate for that reason.
 *   3. NO FRICTION. Every network target here is a plain URL. No SDK, no iframe,
 *      no pixel — which is also the only option available: a third-party share
 *      SDK would require a consent banner and break the cookieless architecture
 *      the whole site is built on (docs/ENGAGEMENT.md §3).
 *   4. THE TEXT IS ALREADY WRITTEN. Nobody composes a caption at 6am after a
 *      run. Every kind has a caption ready to post or edit.
 *
 * WHAT THE COPY MAY NOT DO. `apps/web/tests/framing.test.ts` gates the `Share`
 * namespace against a denylist of comparison tokens, per operator decision C7 —
 * copy frames SHOWING UP and BELONGING TO A PLACE, never being better than other
 * members. That is not a softening of the goal: the evidence the decision cites
 * (Sezer/Gino/Norton, JPSP) is that brag-framed sharing leaves the sharer LESS
 * liked and less trusted, and that people systematically overestimate how well it
 * lands. Copy that makes the poster look good is copy that gets posted again.
 *
 * INSTAGRAM AND FACEBOOK STORIES HAVE NO WEB INTENT. There is no URL that opens
 * a story composer — that is a platform fact, not an omission here. The only two
 * routes to them are the OS share sheet with a file attached
 * (`navigator.share({ files })`, which does reach them on mobile) and saving the
 * image to post manually. Both are built; `NETWORKS` below therefore lists only
 * the targets that genuinely accept a URL.
 */

/** Every moment that can be shared. Adding one is an entry here plus its copy. */
export const SHARE_KINDS = [
  'training',
  'week',
  'badge',
  'passport',
  'division',
  'legend',
  'facility',
  'session',
  'campaign',
] as const;

export type ShareKind = (typeof SHARE_KINDS)[number];

/**
 * Kinds that name the member sharing them.
 *
 * This is the privacy switch, and it is a property of the KIND rather than of a
 * caller's diligence. A person-scoped artifact is rendered behind the member's
 * own session, served `private, no-store`, and never handed to a scraper — so
 * there is no cached named image for an erased account to leave behind, which is
 * the lesson migration 0012 wrote down.
 */
export const PERSON_SCOPED_KINDS: readonly ShareKind[] = [
  'training',
  'week',
  'badge',
  'passport',
  'division',
] as const;

export function isPersonScoped(kind: ShareKind): boolean {
  return PERSON_SCOPED_KINDS.includes(kind);
}

/**
 * Where a share can be sent with nothing but a URL.
 *
 * ORDER IS THE COUNTRY'S, not the world's: Viber first, then Facebook
 * (docs/ENGAGEMENT.md §1.1 — Bulgaria shares on Viber and Facebook, and
 * Instagram is a distant third for this audience). `x` is last because it is
 * marginal here and is included only so a share never feels short of options.
 *
 * MESSENGER IS DELIBERATELY ABSENT: its web dialog requires a registered
 * Facebook app id, which would mean a third-party integration and an app
 * review, and the mobile-only `fb-messenger://` scheme fails silently on
 * desktop. The native sheet already reaches Messenger on the devices that have
 * it, which is the honest route.
 */
export const NETWORKS = ['viber', 'facebook', 'telegram', 'whatsapp', 'x'] as const;

export type ShareNetwork = (typeof NETWORKS)[number];

/** Networks that take the caption and the link as ONE text blob. */
const TEXT_AND_URL_TOGETHER: readonly ShareNetwork[] = ['viber', 'whatsapp'];

/**
 * The intent URL for one network.
 *
 * Pure and total: every network returns an absolute URL, so a caller never has
 * to branch on which ones "work". Everything is `encodeURIComponent`-escaped —
 * captions contain `#`, `&` and newlines, all of which silently truncate a
 * naively-built query string.
 */
export function networkUrl(network: ShareNetwork, text: string, url: string): string {
  const both = encodeURIComponent(`${text}\n${url}`);
  const t = encodeURIComponent(text);
  const u = encodeURIComponent(url);

  switch (network) {
    // Viber's own forward scheme takes one text blob and no separate url field.
    case 'viber':
      return `viber://forward?text=${both}`;
    // sharer.php takes ONLY a url — Facebook has ignored a `quote` parameter
    // since 2017, so passing the caption here would silently drop it. The
    // caption reaches Facebook through the OG card's own title instead.
    case 'facebook':
      return `https://www.facebook.com/sharer/sharer.php?u=${u}`;
    case 'telegram':
      return `https://t.me/share/url?url=${u}&text=${t}`;
    case 'whatsapp':
      return `https://wa.me/?text=${both}`;
    case 'x':
      return `https://twitter.com/intent/tweet?text=${t}&url=${u}`;
  }
}

/** Whether this network drops a separate caption — the UI warns rather than lying. */
export function carriesCaption(network: ShareNetwork): boolean {
  return network !== 'facebook';
}

export function joinsTextAndUrl(network: ShareNetwork): boolean {
  return TEXT_AND_URL_TOGETHER.includes(network);
}

/**
 * The stats a story shows. Two or three; four is unreadable at arm's length on a
 * phone held by somebody else.
 */
export interface ShareStat {
  value: string;
  label: string;
}

/**
 * One share, fully resolved.
 *
 * EXACT SHAPE, pinned by a test. This is the object that crosses into a client
 * component and then into the OS share sheet, so it is the last place a field
 * can be added without anyone noticing — the same reason `PassportShare` has an
 * exact-key test. Nothing derived from current behaviour, no ids, no timestamps.
 */
export interface SharePayload {
  kind: ShareKind;
  /** Post caption. Already localised; ready to send unedited. */
  text: string;
  /** Absolute page URL the share points at. */
  url: string;
  /** 1080×1920 story image, or null when this kind has no story. */
  storyPath: string | null;
  /** 1200×630 link-preview card, or null. Public kinds only. */
  cardPath: string | null;
  /** True when the artifact names the member — drives no-store and session gating. */
  personScoped: boolean;
}

export interface StoryPathInput {
  kind: ShareKind;
  locale: string;
  /** Facility/session/campaign slug for a public kind; a row id for a personal one. */
  ref?: string | null;
}

/**
 * The path of a story image.
 *
 * TWO ROUTE FAMILIES, and the split is the privacy model rather than tidiness.
 *
 * `/og/lichen/...` is person-scoped: rendered behind the member's own session,
 * `private, no-store`, `force-dynamic`, `X-Robots-Tag: noindex`. It is fetched
 * by the member's own device and handed to the OS share sheet as a FILE, so no
 * scraper ever needs it and no CDN ever holds a named image.
 *
 * `/og/...` is public and cacheable, and names only places, sessions and
 * campaigns.
 *
 * THE DOTTED FINAL SEGMENT IS LOAD-BEARING. `middleware.ts` matches
 * `/((?!api|_next|_vercel|.*\..*).*)` and locale-rewrites anything without a
 * dot, so a dotless path would 307 on every fetch. The locale is a route SEGMENT
 * for the mirror-image reason: because the dot makes middleware skip the path,
 * next-intl never resolves a request locale, and every story would silently
 * render in Bulgarian.
 */
export function storyPath(input: StoryPathInput): string | null {
  const locale = input.locale === 'en' ? 'en' : 'bg';
  const ref = input.ref?.trim() ?? '';

  if (isPersonScoped(input.kind)) {
    // `passport`, `week` and `division` are "my current state" and need no ref;
    // `training` and `badge` name one row the member owns.
    const needsRef = input.kind === 'training' || input.kind === 'badge';
    if (needsRef && ref === '') return null;
    const tail = needsRef ? `${input.kind}/${encodeURIComponent(ref)}` : input.kind;
    return `/og/lichen/${locale}/${tail}/story.png`;
  }

  if (ref === '') return null;
  return `/og/${locale}/story/${input.kind}/${encodeURIComponent(ref)}/story.png`;
}

/** The 1200×630 link-preview card, for the kinds that have a public page. */
export function cardPath(input: StoryPathInput): string | null {
  if (isPersonScoped(input.kind)) return null;
  const locale = input.locale === 'en' ? 'en' : 'bg';
  const ref = input.ref?.trim() ?? '';
  if (ref === '') return null;

  // The existing public card route keys on its own kind vocabulary.
  const kindPath = input.kind === 'facility' ? 'obekt' : input.kind === 'session' ? 'sesiya' : 'kampaniya';
  return `/og/${locale}/${kindPath}/${encodeURIComponent(ref)}/card.png`;
}

export interface BuildShareInput {
  kind: ShareKind;
  locale: string;
  /** Absolute site origin, e.g. `https://sportnakarta.bg`. */
  origin: string;
  /** The page this share points at, as a site-relative path. */
  page: string;
  /** Localised caption, already composed by the caller from its own namespace. */
  text: string;
  ref?: string | null;
}

/**
 * Assemble one share.
 *
 * Deliberately takes the caption rather than composing it: every Cyrillic
 * character in a share payload has to live in `messages/*.json` (the repo-wide
 * hardcoded-Cyrillic gate covers `lib/src`), so the words are resolved by the
 * caller through next-intl and this function stays pure and locale-agnostic.
 */
export function buildShare(input: BuildShareInput): SharePayload {
  const origin = input.origin.replace(/\/$/, '');
  const page = input.page.startsWith('/') ? input.page : `/${input.page}`;
  return {
    kind: input.kind,
    text: input.text,
    url: `${origin}${page}`,
    storyPath: storyPath({ kind: input.kind, locale: input.locale, ref: input.ref }),
    cardPath: cardPath({ kind: input.kind, locale: input.locale, ref: input.ref }),
    personScoped: isPersonScoped(input.kind),
  };
}

/** Metres to a display distance, in km to one decimal. Null stays null. */
export function formatKm(metres: number | null | undefined): string | null {
  if (metres === null || metres === undefined || !Number.isFinite(metres)) return null;
  if (metres <= 0) return null;
  return (Math.round(metres / 100) / 10).toFixed(1);
}

/** Seconds to whole minutes — the unit every share surface prints. */
export function formatMinutes(seconds: number): number {
  return Math.max(Math.round(seconds / 60), 0);
}
