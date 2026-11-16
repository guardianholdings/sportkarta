'use client';

import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  Copy,
  GraduationCap,
  HandHeart,
  LandPlot,
  Lightbulb,
  Lock,
  LockOpen,
  Navigation,
  Share2,
  ShieldCheck,
  Ticket,
  Umbrella,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { FAMILY_COLOR } from '@/lib/design/families';
import {
  facilityVisual,
  readableHue,
  SPORT_VISUALS,
  type SportIconComponent,
} from '@/lib/design/sport-visuals';
import { NAV_PROVIDERS } from '@/lib/directions';
import { APP_TIME_ZONE, formatDate, intlLocale } from '@/lib/format';
import type { FacilityCardData, FacilityCardSession } from '@/lib/map/card';
import { photoUrl } from '@/lib/photo-url';
import { getPathname, Link } from '@/i18n/navigation';
import type { CanonicalSport } from '@sportkarta/lib/sports';

import type { MapPoint } from './map-canvas';

/**
 * The map's facility card: what opens when a pin or a list row is chosen.
 *
 * It used to be a heading and two directions buttons under a decorative icon —
 * everything else the product knows about the place was one more page away, so
 * comparing three pitches meant opening and closing three pages. The card now
 * answers the questions somebody standing in the street has, in the order they
 * have them: what does it look like, may I use it, is the information any good,
 * what is it like underfoot and after dark, is anybody playing — and only then
 * «Виж детайли».
 *
 * TWO SOURCES, TWO SPEEDS. The heading, the sports and the place come from the
 * feed the map already holds, so the card is on screen the moment the pin is
 * tapped. The rest (`details`) is read for this one facility by the explorer
 * (lib/map/card.ts) and arrives a moment later, into placeholders that hold its
 * place. If it does not arrive, the card says so and is still a card: a name, a
 * place, directions, the way to the page.
 *
 * THE STRUCTURE THE TESTS AND THE KEYBOARD RELY ON:
 *   - exactly one <h2>, carrying `data-preview-heading` — where the explorer
 *     puts focus when the card opens. Sections inside are <h3>.
 *   - exactly one link named «Виж детайли», to the facility page.
 *   - directions are plain links, as lib/directions.ts says they are.
 */

export type CardDetails =
  | { status: 'loading'; data: null }
  /** `retry` is false when the place is gone: asking again cannot help. */
  | { status: 'error'; data: null; retry: boolean }
  | { status: 'ready'; data: FacilityCardData };

export interface FacilityCardProps {
  point: MapPoint;
  /** facilityTitle — the name, or sport + place for the 91% with none. */
  title: string;
  subtitle: string;
  /**
   * The phone's half-height sheet: no hero, the close control beside the
   * heading, so the heading, the badges and the actions fit above the tab bar
   * with the map still visible above them. Everything else scrolls.
   */
  compact: boolean;
  /** «на 0,4 км», once the member has located themselves. */
  distance: string | null;
  details: CardDetails;
  onRetry: () => void;
  onClose: () => void;
  /** Phone, compact only: grow the sheet to full height (the photo opens it). */
  onExpand?: () => void;
}

/** One step of the entrance: the same rise, a beat later per block. */
function rise(step: number): CSSProperties {
  return { animationDelay: `${String(step * 45)}ms` };
}

const ACCESS_LOOK: Record<string, { tone: BadgeTone; Icon: LucideIcon }> = {
  free: { tone: 'success', Icon: LockOpen },
  paid: { tone: 'neutral', Icon: Ticket },
  restricted: { tone: 'warning', Icon: Lock },
  school: { tone: 'info', Icon: GraduationCap },
};

const CONDITION_TONE: Record<string, BadgeTone> = {
  excellent: 'success',
  good: 'success',
  poor: 'warning',
  unusable: 'danger',
};

export function FacilityCard({
  point,
  title,
  subtitle,
  compact,
  distance,
  details,
  onRetry,
  onClose,
  onExpand,
}: FacilityCardProps) {
  const t = useTranslations('Map');
  const tFacility = useTranslations('Facility');
  const tSport = useTranslations('Sport');
  const tSurface = useTranslations('Surface');
  const tAccess = useTranslations('Access');
  const tCondition = useTranslations('Condition');
  const tSource = useTranslations('Source');
  const locale = useLocale();
  const gamesId = useId();
  const errorId = useId();
  /**
   * Two controls here take themselves away when used — the phone's photo tile
   * (the sheet grows and the tile is gone) and «Опитай пак» (the notice gives
   * way to the placeholders). A control that vanishes under the keyboard drops
   * focus on <body>, where Escape no longer closes the card; the heading is
   * where focus arrived, and it is where it goes back.
   */
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusHeading = () => headingRef.current?.focus({ preventScroll: true });

  const visual = facilityVisual(point.sports);
  const data = details.data;
  /**
   * A photo that fails to load — withdrawn by a moderator since the card was
   * read — is dropped rather than shown as a broken frame; when none is left
   * the card falls back to the drawn hero.
   */
  const [broken, setBroken] = useState<string[]>([]);
  const photos = (data?.photoIds ?? []).filter((id) => !broken.includes(id));
  const dropPhoto = (id: string) => setBroken((list) => (list.includes(id) ? list : [...list, id]));

  /** «Връзката е копирана» — said once, where a screen reader hears it too. */
  const [notice, setNotice] = useState<{ text: string; n: number } | null>(null);
  const [copied, setCopied] = useState(false);
  // A new object every time, so the same words said again restart the clock —
  // and, keyed below, are a new node for a screen reader to announce.
  const say = (text: string) => setNotice((last) => ({ text, n: (last?.n ?? 0) + 1 }));
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => {
      setNotice(null);
      setCopied(false);
    }, 2200);
    return () => {
      window.clearTimeout(timer);
    };
  }, [notice]);

  const coords = `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;

  async function copyCoords() {
    try {
      await navigator.clipboard.writeText(coords);
      setCopied(true);
      say(t('card.coordsCopied'));
    } catch {
      // No clipboard (an insecure context, a refusal): the coordinates are
      // printed beside the button and can be selected by hand.
    }
  }

  /**
   * The facility PAGE is what is shared, never this map view: the page has the
   * preview image and the description a chat app unfurls, and a `/karta` link
   * would carry whatever filters and position this member happened to have.
   */
  async function share() {
    const url = `${window.location.origin}${getPathname({ href: `/obekt/${point.slug}`, locale })}`;
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, url });
        return;
      } catch (error) {
        // Closing the system sheet is an answer, not a failure.
        if (error instanceof DOMException && error.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      say(t('card.shareCopied'));
    } catch {
      // Nothing to fall back to; «Виж детайли» has the page's own share.
    }
  }

  const access = data ? (ACCESS_LOOK[data.access] ?? null) : null;
  const awaiting = data?.status === 'needs_verification';
  // A date that cannot be read is left out, never formatted: Intl THROWS on an
  // invalid one, and a throw here is the whole map replaced by the error page.
  const verifiedAt = data?.lastVerifiedAt ? new Date(data.lastVerifiedAt) : null;
  const verifiedOn =
    verifiedAt && !Number.isNaN(verifiedAt.getTime())
      ? formatDate(verifiedAt, locale, 'medium')
      : null;
  const games = (data?.sessions ?? []).filter(
    (session) => !Number.isNaN(Date.parse(session.startsAt)),
  );

  const badges = (
    <div className="flex flex-wrap items-center gap-1.5">
      {distance !== null && (
        <Badge icon={<Navigation size={12} aria-hidden />} className="font-mono">
          {distance}
        </Badge>
      )}
      {details.status === 'loading' && (
        <>
          <span className="h-6 w-32 animate-pulse rounded-pill bg-paper-sunk" />
          <span className="h-6 w-24 animate-pulse rounded-pill bg-paper-sunk" />
        </>
      )}
      {data && (
        <>
          <Badge
            tone={access?.tone ?? 'neutral'}
            icon={access ? <access.Icon size={13} aria-hidden /> : undefined}
            className="animate-card-rise"
          >
            {t.has(`card.access.${data.access}`)
              ? t(`card.access.${data.access}`)
              : tAccess(data.access)}
          </Badge>
          {data.condition && (
            <Badge
              tone={CONDITION_TONE[data.condition] ?? 'neutral'}
              variant="outline"
              className="animate-card-rise"
              style={rise(1)}
            >
              {t('card.conditionIs', { condition: tCondition(data.condition) })}
            </Badge>
          )}
          {awaiting ? (
            <Badge
              tone="warning"
              icon={<CircleDashed size={13} aria-hidden />}
              className="animate-card-rise"
              style={rise(2)}
            >
              {tFacility('awaitingVerification')}
            </Badge>
          ) : verifiedOn ? (
            <Badge
              tone="brand"
              icon={<ShieldCheck size={13} aria-hidden />}
              className="animate-card-rise"
              style={rise(2)}
            >
              {t('card.verifiedOn', { date: verifiedOn })}
            </Badge>
          ) : null}
        </>
      )}
    </div>
  );

  const unknown = tFacility('unknown');
  const yesNo = (value: boolean | null) =>
    value === null ? null : value ? tFacility('yes') : tFacility('no');

  const facts = data ? (
    <dl className="grid grid-cols-3 gap-2">
      <Fact
        Icon={LandPlot}
        label={tFacility('surface')}
        value={data.surface ? tSurface(data.surface) : null}
        unknown={unknown}
        step={0}
      />
      <Fact
        Icon={Lightbulb}
        label={tFacility('lighting')}
        value={yesNo(data.lighting)}
        unknown={unknown}
        lit={data.lighting === true}
        step={1}
      />
      <Fact
        Icon={Umbrella}
        label={tFacility('covered')}
        value={yesNo(data.covered)}
        unknown={unknown}
        step={2}
      />
    </dl>
  ) : details.status === 'loading' ? (
    <div aria-hidden className="grid grid-cols-3 gap-2">
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-[5.25rem] animate-pulse rounded-card bg-paper-sunk" />
      ))}
    </div>
  ) : (
    // The card is still a card without them: say so, offer the one thing that
    // can help, and leave the heading and the actions exactly where they were.
    // The words are announced by the status region below, which was on the
    // page before they were; this copy is for the eye.
    <div className="flex items-center justify-between gap-3 rounded-card bg-paper-sunk py-2 pr-2 pl-3">
      <p aria-hidden className="text-body-sm text-ink-soft">
        {t('card.detailsError')}
      </p>
      {details.status === 'error' && details.retry && (
        <Button
          variant="secondary"
          aria-describedby={errorId}
          onClick={() => {
            onRetry();
            focusHeading();
          }}
        >
          {t('retry')}
        </Button>
      )}
    </div>
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden lg:rounded-sheet">
      {/* On the hero's corner, and it stays there while the body scrolls under
          it: the way out of a card is never a scroll away. */}
      {!compact && (
        <IconButton
          aria-label={t('close')}
          variant="floating"
          round
          onClick={onClose}
          className="absolute right-3 top-3 z-10"
        >
          <X size={19} />
        </IconButton>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {!compact && (
          <Hero
            photos={photos}
            name={title}
            color={visual.color}
            Icon={visual.Icon}
            sport={point.sports[0] ? tSport(point.sports[0]) : null}
            onBroken={dropPhoto}
            labels={{
              group: t('card.photos', { name: title }),
              photo: (n, total) => t('card.photoOf', { n, total, name: title }),
              count: (n, total) => t('card.photoCount', { n, total }),
              prev: t('card.prevPhoto'),
              next: t('card.nextPhoto'),
            }}
          />
        )}

        <div className={`flex flex-col gap-3.5 px-4 pb-4 ${compact ? 'pt-1' : 'pt-3.5'}`}>
          {/* Always here, so that what it comes to say is a CHANGE a screen
              reader announces; a region that arrives already full is not. */}
          <p id={errorId} role="status" className="sr-only">
            {details.status === 'error' ? t('card.detailsError') : ''}
          </p>
          <div className="flex items-start gap-3">
            {compact && (
              <Thumb
                photo={photos[0] ?? null}
                more={photos.length - 1}
                color={visual.color}
                Icon={visual.Icon}
                alt={tFacility('photoAlt', { name: title })}
                expandLabel={t('expandPreview')}
                onExpand={
                  onExpand
                    ? () => {
                        onExpand();
                        focusHeading();
                      }
                    : undefined
                }
                onBroken={dropPhoto}
              />
            )}
            <div className="min-w-0 flex-1">
              {/* Where focus lands when the card opens (the explorer's focus
                  effect): the facility's name is the first thing announced. */}
              {/* A size down in the half sheet: beside the tile and the close
                  button the heading has two thirds of a phone's width, and at
                  full size a three-word name took three lines — and with them
                  the badges' place above the fold. */}
              <h2
                tabIndex={-1}
                data-preview-heading
                ref={headingRef}
                className={`font-extrabold tracking-tight text-ink ${compact ? 'text-h4' : 'text-h3'}`}
              >
                {title}
              </h2>
              {subtitle && (
                <p className={`mt-1 text-body-sm text-text-muted ${compact ? 'truncate' : ''}`}>
                  {subtitle}
                </p>
              )}
            </div>
            {compact && (
              <IconButton aria-label={t('close')} variant="surface" round onClick={onClose}>
                <X size={18} />
              </IconButton>
            )}
          </div>

          {badges}
          {facts}

          {/* With one sport the heading or the hero already names it; the row
              is for the places where more than one is played. */}
          {point.sports.length > 1 && (
            <ul className="flex flex-wrap gap-1.5" aria-label={tFacility('sports')}>
              {point.sports.map((sport) => {
                const known =
                  sport in SPORT_VISUALS ? SPORT_VISUALS[sport as CanonicalSport] : null;
                const color = known?.color ?? FAMILY_COLOR.multi;
                const Icon = known?.Icon ?? SPORT_VISUALS.multi.Icon;
                return (
                  <li
                    key={sport}
                    className="inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-caption font-medium"
                    style={{
                      background: `color-mix(in srgb, ${color} 12%, var(--surface))`,
                      color: readableHue(color),
                    }}
                  >
                    <Icon size={13} aria-hidden />
                    {tSport(sport)}
                  </li>
                );
              })}
            </ul>
          )}

          {games.length > 0 && (
            <section aria-labelledby={gamesId} className="animate-card-rise" style={rise(3)}>
              <h3
                id={gamesId}
                className="flex items-center gap-1.5 text-body-sm font-bold text-ink"
              >
                <CalendarDays size={16} className="text-brand" aria-hidden />
                {t('card.games')}
              </h3>
              <ul className="mt-2 flex flex-col gap-1.5">
                {games.map((session) => (
                  <li key={session.occurrenceId}>
                    <GameRow
                      session={session}
                      locale={locale}
                      places={
                        session.capacity === null
                          ? null
                          : t('card.places', {
                              going: session.going,
                              capacity: session.capacity,
                            })
                      }
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* A link, not a label (UX audit N6): the club's page when one club
              is here, the facility's club block when several are. */}
          {point.club && (
            <p>
              <Link
                href={point.clubSlug ? `/klub/${point.clubSlug}` : `/obekt/${point.slug}#klubove`}
                className="inline-flex min-h-11 items-center gap-1 rounded-pill border border-line-strong px-3.5 text-body-sm font-semibold text-ink-soft transition-colors duration-150 ease-standard hover:border-brand-border hover:text-brand focus-visible:shadow-[var(--ring)]"
              >
                {point.clubSlug ? t('clubChip') : t('clubChipMany')}
                <ChevronRight size={14} aria-hidden />
              </Link>
            </p>
          )}

          {/* ~6.9k places are imported and nobody has stood on them yet. The
              people opening this card are the ones who can. */}
          {awaiting && (
            <Link
              href={`/obekt/${point.slug}#prinos`}
              className="group flex min-h-11 animate-card-rise items-center gap-3 rounded-card border border-line-strong bg-surface p-2 pr-2.5 text-body-sm font-medium text-ink transition-[border-color,box-shadow] duration-150 ease-standard hover:border-accent-border hover:shadow-sm focus-visible:shadow-[var(--ring)]"
              style={rise(4)}
            >
              <span
                aria-hidden
                className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-subtle text-accent-active"
              >
                <HandHeart size={18} />
              </span>
              <span className="flex-1">{t('card.verifyNudge')}</span>
              <ChevronRight
                size={16}
                className="shrink-0 text-text-muted transition-transform duration-150 ease-standard group-hover:translate-x-0.5"
                aria-hidden
              />
            </Link>
          )}

          <div className="flex items-center gap-2 border-t border-line pt-2.5">
            <div className="min-w-0 flex-1">
              <p className="font-mono text-caption text-ink-soft">
                <span className="sr-only">{t('card.coordinates')}: </span>
                {coords}
              </p>
              {/* Provenance travels with the record wherever it is shown. An OSM
                  row is attributed once, not «OpenStreetMap · © OpenStreetMap». */}
              {data && (
                <p className="mt-0.5 text-caption text-text-muted">
                  {tFacility('dataSource')}:{' '}
                  {data.source === 'osm'
                    ? '© OpenStreetMap'
                    : `${tSource(data.source)} · © OpenStreetMap`}
                </p>
              )}
            </div>
            <IconButton
              aria-label={t('card.copyCoords')}
              title={t('card.copyCoords')}
              variant="ghost"
              onClick={() => void copyCoords()}
            >
              {copied ? <Check size={18} className="text-success" /> : <Copy size={18} />}
            </IconButton>
          </div>
        </div>
      </div>

      {/* `pb-8` below lg clears the tab bar's centre «+», which stands 22px
          proud of the bar and sat on the lower edge of «Виж детайли». */}
      <div className="relative flex shrink-0 flex-col gap-2.5 border-t border-line bg-surface p-3 pb-8 lg:pb-3">
        <p
          role="status"
          className="pointer-events-none absolute inset-x-0 bottom-full flex justify-center pb-2"
        >
          {notice && (
            <span
              key={notice.n}
              className="animate-card-rise rounded-pill bg-ink px-3 py-1.5 text-caption font-medium text-on-brand shadow-lg"
            >
              {notice.text}
            </span>
          )}
        </p>
        <div className="flex items-center gap-2.5">
          {NAV_PROVIDERS.map((provider) => (
            <Button key={provider.id} asChild block>
              <a
                href={provider.href(point.lat, point.lon)}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t('directionsWith', { app: provider.brand })}
              >
                <Navigation size={19} aria-hidden />
                {provider.brand}
              </a>
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2.5">
          <Button variant="secondary" asChild block>
            <Link href={`/obekt/${point.slug}`}>
              {t('viewDetails')}
              <ChevronRight size={18} aria-hidden />
            </Link>
          </Button>
          <IconButton
            aria-label={t('card.share')}
            title={t('card.share')}
            variant="surface"
            round
            onClick={() => void share()}
            className="shrink-0"
          >
            <Share2 size={18} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

// ── Fact tile ─────────────────────────────────────────────────────────────

/**
 * One characteristic. A value nobody has recorded is SAID — «неизвестно», in
 * the muted tone — rather than left out: three tiles in the same three places
 * on every card are what make two cards comparable at a glance, and a missing
 * tile reads as "no lighting" when the truth is "nobody has told us".
 */
function Fact({
  Icon,
  label,
  value,
  unknown,
  lit = false,
  step,
}: {
  Icon: LucideIcon;
  label: string;
  value: string | null;
  unknown: string;
  /** The one fact with a state worth lighting up: the lamp is on. */
  lit?: boolean;
  step: number;
}) {
  // dt before dd in the document, value above label on screen: the value is
  // what the eye is looking for, the label only says which value it is. The
  // mark rides inside the dd — a <dl> group holds terms and descriptions only.
  return (
    <div
      className="flex animate-card-rise flex-col rounded-card bg-paper-sunk px-3 py-2.5"
      style={rise(step)}
    >
      <dt className="order-2 mt-0.5 text-caption text-text-muted">{label}</dt>
      <dd
        className={`order-1 flex flex-col gap-1.5 text-body-sm leading-snug ${
          value === null ? 'font-medium text-text-muted' : 'font-bold text-ink'
        }`}
      >
        <Icon size={16} className={lit ? 'text-accent-active' : 'text-ink-soft'} aria-hidden />
        {value ?? unknown}
      </dd>
    </div>
  );
}

// ── Game row ──────────────────────────────────────────────────────────────

/** The next игра here: a calendar leaf, what it is, when, and how full. */
function GameRow({
  session,
  locale,
  places,
}: {
  session: FacilityCardSession;
  locale: string;
  places: string | null;
}) {
  // Sofia's calendar, not the browser's: a traveller's phone must not move a
  // 19:00 game in Plovdiv to another hour, or to another day (lib/format.ts).
  const at = new Date(session.startsAt);
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(intlLocale(locale), { ...options, timeZone: APP_TIME_ZONE }).format(at);
  // «ное», «Nov». Cut from the full name: Bulgarian's own short month is the
  // NUMBER («11»), which under a day reads as a second date, not as a month.
  const month = part({ month: 'long' }).slice(0, 3);
  return (
    <Link
      href={`/igra/${session.occurrenceId}`}
      className="group flex min-h-11 items-center gap-3 rounded-card border border-line bg-surface p-2 pr-2.5 transition-[border-color,box-shadow] duration-150 ease-standard hover:border-brand-border hover:shadow-sm focus-visible:shadow-[var(--ring)]"
    >
      <span
        aria-hidden
        className="grid size-11 shrink-0 place-items-center rounded-md bg-brand-subtle text-brand"
      >
        <span className="flex flex-col items-center leading-none">
          <span className="font-mono text-body font-bold tabular-nums">
            {part({ day: 'numeric' })}
          </span>
          <span className="mt-0.5 text-overline uppercase tracking-overline">{month}</span>
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body-sm font-semibold text-ink group-hover:text-brand">
          {session.title}
        </span>
        {/* The leaf already shows the day; the line beside it adds the weekday
            and the hour. A screen reader gets the whole date in one phrase. */}
        <span className="sr-only">
          {part({
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
        <span aria-hidden className="block text-caption text-text-muted">
          {part({ weekday: 'long', hour: '2-digit', minute: '2-digit' })}
        </span>
      </span>
      {places !== null && (
        <span className="shrink-0 font-mono text-caption tabular-nums text-ink-soft">{places}</span>
      )}
      <ChevronRight
        size={16}
        className="shrink-0 text-text-muted transition-transform duration-150 ease-standard group-hover:translate-x-0.5"
        aria-hidden
      />
    </Link>
  );
}

// ── Thumb (phone, half sheet) ─────────────────────────────────────────────

/**
 * The half sheet has no room for a hero, so the place's face is a tile beside
 * its name: its first photo when it has one — which is also the button that
 * opens the full sheet, where the photos are — and its sport's mark otherwise.
 */
function Thumb({
  photo,
  more,
  color,
  Icon,
  alt,
  expandLabel,
  onExpand,
  onBroken,
}: {
  photo: string | null;
  /** Photos beyond the one shown. */
  more: number;
  color: string;
  Icon: SportIconComponent;
  alt: string;
  expandLabel: string;
  onExpand?: () => void;
  onBroken: (id: string) => void;
}) {
  if (!photo) {
    return (
      <span
        aria-hidden
        className="grid size-12 shrink-0 place-items-center rounded-md"
        style={{ background: `color-mix(in srgb, ${color} 16%, var(--surface))`, color }}
      >
        <Icon size={22} />
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label={expandLabel}
      className="relative size-12 shrink-0 overflow-hidden rounded-md transition-transform duration-150 ease-standard focus-visible:shadow-[var(--ring)] active:scale-[0.97]"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photoUrl(photo)}
        alt={alt}
        className="h-full w-full object-cover"
        onError={() => onBroken(photo)}
      />
      {more > 0 && (
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 bg-overlay-scrim text-center font-mono text-overline leading-relaxed text-on-brand"
        >
          +{more}
        </span>
      )}
    </button>
  );
}

// ── Hero ──────────────────────────────────────────────────────────────────

interface HeroLabels {
  group: string;
  photo: (n: number, total: number) => string;
  count: (n: number, total: number) => string;
  prev: string;
  next: string;
}

/**
 * The top of the card: the place's photos, swiped or stepped through — or,
 * for the nine in ten that have none yet, its sport drawn in its own colour.
 * The fallback is the common case and is designed as one, not as a hole where
 * a photo should be.
 */
function Hero({
  photos,
  name,
  color,
  Icon,
  sport,
  onBroken,
  labels,
}: {
  photos: string[];
  name: string;
  color: string;
  Icon: SportIconComponent;
  sport: string | null;
  onBroken: (id: string) => void;
  labels: HeroLabels;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const total = photos.length;
  const shown = Math.min(index, Math.max(0, total - 1));
  /**
   * Where the strip is HEADED. `index` follows the scroll and turns over only
   * at the halfway point, so a second press of «next» during the glide asked
   * for the photo already on its way, and was swallowed. Steps count from the
   * aim instead; a swipe carries the aim with it (`onScroll`), except while
   * the strip is still gliding to a step that was asked for.
   */
  const aim = useRef(0);
  const glidingUntil = useRef(0);

  function go(to: number) {
    const el = strip.current;
    if (!el) return;
    const next = Math.max(0, Math.min(total - 1, to));
    aim.current = next;
    glidingUntil.current = performance.now() + 600;
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ left: next * el.clientWidth, behavior: calm ? 'auto' : 'smooth' });
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    go(aim.current + (event.key === 'ArrowRight' ? 1 : -1));
  }

  return (
    <div className="group/hero relative h-44 shrink-0 overflow-hidden bg-paper-sunk">
      {total > 0 ? (
        <>
          <div
            ref={strip}
            role="group"
            aria-label={labels.group}
            tabIndex={total > 1 ? 0 : undefined}
            onKeyDown={total > 1 ? onKeyDown : undefined}
            onScroll={(event) => {
              const el = event.currentTarget;
              if (el.clientWidth === 0) return;
              const at = Math.round(el.scrollLeft / el.clientWidth);
              setIndex(at);
              if (performance.now() > glidingUntil.current) aim.current = at;
            }}
            className="scrollbar-none flex h-full snap-x snap-mandatory overflow-x-auto overscroll-x-contain focus-visible:shadow-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring"
          >
            {photos.map((id, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={id}
                src={photoUrl(id)}
                alt={total > 1 ? labels.photo(i + 1, total) : name}
                loading={i === 0 ? 'eager' : 'lazy'}
                draggable={false}
                onError={() => onBroken(id)}
                className="h-full w-full shrink-0 snap-center object-cover"
              />
            ))}
          </div>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-overlay-scrim to-transparent"
          />
          {total > 1 && (
            <>
              <HeroStep
                side="left"
                label={labels.prev}
                disabled={shown === 0}
                onClick={() => go(aim.current - 1)}
              />
              <HeroStep
                side="right"
                label={labels.next}
                disabled={shown === total - 1}
                onClick={() => go(aim.current + 1)}
              />
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center gap-1.5"
              >
                {photos.map((id, i) => (
                  <span
                    key={id}
                    className={`h-1.5 rounded-full bg-surface transition-[width,opacity] duration-200 ease-standard ${
                      i === shown ? 'w-4 opacity-100' : 'w-1.5 opacity-60'
                    }`}
                  />
                ))}
              </div>
              {/* For the eye: each photo's own name already says «2 от 3». */}
              <span
                aria-hidden
                className="absolute bottom-2.5 right-3 rounded-pill bg-overlay-scrim px-2 py-0.5 font-mono text-caption tabular-nums text-on-brand"
              >
                {labels.count(shown + 1, total)}
              </span>
            </>
          )}
        </>
      ) : (
        <div
          className="absolute inset-0 grid place-items-center"
          style={{
            background: `radial-gradient(circle at 82% 18%, color-mix(in srgb, ${color} 26%, var(--surface)), transparent 52%), radial-gradient(circle at 10% 92%, color-mix(in srgb, ${color} 18%, var(--surface)), transparent 46%), linear-gradient(150deg, color-mix(in srgb, ${color} 12%, var(--surface)), var(--surface) 78%)`,
            color,
          }}
        >
          {/* A pin on a map, answering: one ring that keeps arriving, two that
              stay. Still under reduced motion — the rule in motion.css ends the
              travelling ring where it fades out. */}
          <span aria-hidden className="relative grid size-40 place-items-center">
            <span className="absolute inset-0 rounded-full border border-current opacity-10" />
            <span className="absolute inset-6 rounded-full border border-current opacity-20" />
            <span className="absolute inset-10 animate-card-ping rounded-full border-2 border-current" />
            <span className="relative grid size-16 place-items-center rounded-full bg-surface shadow-md transition-transform duration-300 ease-out group-hover/hero:scale-105">
              <Icon size={30} />
            </span>
          </span>
        </div>
      )}
      {sport && (
        <span
          className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-pill bg-surface px-2.5 py-1 text-caption font-semibold shadow-sm"
          style={{ color: readableHue(color) }}
        >
          <span aria-hidden className="size-2 rounded-full" style={{ background: color }} />
          {sport}
        </span>
      )}
    </div>
  );
}

/**
 * Previous / next. Pointer devices only: a touch screen swipes the photos.
 *
 * At either end the button STAYS, dimmed and marked unavailable. It used to
 * hide itself there — so with two photos, the first press of «next» removed
 * the button that had just been pressed, and the keyboard's focus with it.
 */
function HeroStep({
  side,
  label,
  disabled,
  onClick,
}: {
  side: 'left' | 'right';
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-disabled={disabled}
      onClick={disabled ? undefined : onClick}
      className={`absolute top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-full bg-surface text-ink opacity-0 shadow-md transition-[opacity,transform] duration-150 ease-standard focus-visible:shadow-[var(--ring)] [@media(hover:none)]:hidden ${
        disabled
          ? 'cursor-default group-hover/hero:opacity-40 focus-visible:opacity-40'
          : 'hover:scale-105 group-hover/hero:opacity-100 focus-visible:opacity-100'
      } ${side === 'left' ? 'left-2' : 'right-2'}`}
    >
      {side === 'left' ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
    </button>
  );
}
