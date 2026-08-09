import { ImageResponse } from 'next/og';

import { ogFonts } from './fonts';
import { OG_PALETTE } from './palette';

/**
 * The 1080×1920 story card.
 *
 * A SEPARATE RENDERER FROM `renderOgCard`, not a parameter on it. The landscape
 * card is a LINK PREVIEW: it is scraped by Viber and Facebook, sits at 1200×630
 * beside a headline, and is read at thumbnail size. A story is a POST: it is the
 * whole screen of somebody's phone, held at arm's length, for about two seconds.
 * The two share a palette and a font stack and nothing else — trying to
 * parameterise one layout into both is how you get a landscape card with tall
 * padding.
 *
 * THE SAFE AREA IS THE WHOLE DESIGN. Instagram and Facebook overlay their own
 * chrome on a story: roughly the top 250px (avatar, name, close) and the bottom
 * 250px (reply box, share row) are covered, and both vary by device notch. So
 * nothing that must be read lives outside the middle band, and the wordmark sits
 * ABOVE the bottom reserve rather than at the edge where every other product
 * puts it. A story whose punchline is under the reply box is a story nobody
 * reposts.
 *
 * ONE HERO NUMBER. The eye gets one thing at this size — a distance, a rung, a
 * streak, a rank. Everything else is context around it. Two heroes is no hero.
 *
 * SATORI CONSTRAINTS, identical to the card and all silent when broken: every
 * multi-child element needs `display: flex`; no CSS variables; no external
 * stylesheet; no `url()` beyond a data URI; NO EMOJI (DESIGN_SYSTEM §2 forbids
 * emoji in product UI — the emoji grid belongs to the plain-TEXT share, which is
 * a different artifact for a different surface).
 *
 * A MISSING FIELD REMOVES ITS ROW. Never an empty band, never "null", never a
 * bare 0 — the reports catalogue's rule, applied to pixels.
 */

export const STORY_SIZE = { width: 1080, height: 1920 } as const;

/** Top and bottom reserves the platforms' own UI covers. Content stays inside. */
export const STORY_SAFE_TOP = 260;
export const STORY_SAFE_BOTTOM = 260;

export interface StoryStat {
  value: string;
  label: string;
}

export interface StoryCardInput {
  /** Small uppercase line — the kind of moment this is. Removed when absent. */
  eyebrow?: string | null;
  /**
   * The hero: one number or one short word, set enormous.
   *
   * OPTIONAL, and the absence is a real layout rather than a degraded one. Some
   * subjects genuinely have no interesting number — a facility's "1 sport here"
   * is a giant numeral saying nothing, and inventing a figure to fill the slot
   * is the Wrapped-2024 failure. With no hero the TITLE takes the large type and
   * the place name becomes the thing you see from across the room, which for a
   * place is the correct answer anyway.
   */
  hero?: string | null;
  /** What the hero counts. Required whenever `hero` is present. */
  heroLabel?: string | null;
  /** The sentence under the hero — the actual claim being made. */
  title: string;
  /** One more line of context: a place, a sport, a window. */
  subtitle?: string | null;
  /** Up to three supporting figures. Four does not read at arm's length. */
  stats?: StoryStat[];
  /** Wordmark, from messages — never hardcoded (the Cyrillic gate is repo-wide). */
  wordmark: string;
  /** The line that makes a story recruit rather than only announce. */
  callToAction?: string | null;
  /**
   * OSM/Protomaps credit. REQUIRED on any story naming a mapped place — the
   * attribution rule covers every map view and export, and a facility story is
   * an export of map data.
   */
  attribution?: string | null;
  accent?: string;
  /**
   * Response headers.
   *
   * REQUIRED for any story naming a person. `ImageResponse` defaults to a
   * one-year immutable PUBLIC cache, which on a named image is the frozen named
   * artifact migration 0012 forbids — an erased member cannot revoke what a CDN
   * promised to keep. Person-scoped routes pass `private, no-store` here AND
   * declare `dynamic = 'force-dynamic'` so nothing reaches the ISR cache either.
   */
  headers?: Record<string, string>;
}

export function renderStoryCard(input: StoryCardInput): ImageResponse {
  const accent = input.accent ?? OG_PALETTE.brand;
  const stats = (input.stats ?? []).slice(0, 3);

  return new ImageResponse(
    <div
      style={{
        width: '1080px',
        height: '1920px',
        display: 'flex',
        flexDirection: 'column',
        background: OG_PALETTE.paper,
        fontFamily: 'Golos Text',
      }}
    >
      {/* A full-bleed accent band at the very top: the one graphic constant
            that makes every story read as the same product, and the only thing
            allowed inside the platform's own chrome reserve. */}
      <div style={{ display: 'flex', width: '1080px', height: '24px', background: accent }} />

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          paddingTop: `${String(STORY_SAFE_TOP)}px`,
          paddingBottom: `${String(STORY_SAFE_BOTTOM)}px`,
          paddingLeft: '96px',
          paddingRight: '96px',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {input.eyebrow ? (
            <div
              style={{
                display: 'flex',
                fontFamily: 'JetBrains Mono',
                fontSize: 34,
                letterSpacing: '5px',
                color: OG_PALETTE.textMuted,
                marginBottom: '40px',
              }}
            >
              {input.eyebrow.toUpperCase()}
            </div>
          ) : null}

          {/* THE HERO. Mono so digits are the same width — a number that
                reflows between renders reads as a different design. */}
          {input.hero ? (
            <div
              style={{
                display: 'flex',
                fontFamily: 'JetBrains Mono',
                fontSize: 260,
                lineHeight: 1,
                color: accent,
              }}
            >
              {input.hero}
            </div>
          ) : null}
          {input.hero && input.heroLabel ? (
            <div
              style={{
                display: 'flex',
                fontSize: 44,
                fontWeight: 600,
                color: OG_PALETTE.inkSoft,
                marginTop: '8px',
              }}
            >
              {input.heroLabel}
            </div>
          ) : null}

          <div
            style={{
              display: 'flex',
              // Title-led when there is no hero: it becomes the large element
              // rather than sitting small under an empty space. Unbounded
              // (the display face) runs ~25% wider than a text sans, so the
              // sizes drop accordingly (76→64, 116→96) to keep the same
              // char-per-line budget inside the unchanged clip boxes.
              fontFamily: 'Unbounded',
              fontSize: input.hero ? 64 : 96,
              fontWeight: 700,
              lineHeight: 1.2,
              color: OG_PALETTE.ink,
              marginTop: input.hero ? '64px' : '0px',
              // Whole lines only: 231 = 3 lines × 64px × 1.2 and
              // 461 = 4 lines × 96px × 1.2 — the old 260/520 boxes sliced a
              // strip of chopped glyph tops off the next line.
              overflow: 'hidden',
              maxHeight: input.hero ? '231px' : '461px',
            }}
          >
            {input.title}
          </div>

          {input.subtitle ? (
            <div
              style={{
                display: 'flex',
                fontSize: input.hero ? 40 : 48,
                color: OG_PALETTE.inkSoft,
                marginTop: '24px',
              }}
            >
              {input.subtitle}
            </div>
          ) : null}
        </div>

        {stats.length > 0 ? (
          <div
            style={{
              display: 'flex',
              gap: '64px',
              borderTop: `2px solid ${OG_PALETTE.line}`,
              paddingTop: '40px',
            }}
          >
            {stats.map((stat) => (
              <div key={stat.label} style={{ display: 'flex', flexDirection: 'column' }}>
                <div
                  style={{
                    display: 'flex',
                    fontFamily: 'JetBrains Mono',
                    fontSize: 66,
                    color: OG_PALETTE.ink,
                  }}
                >
                  {stat.value}
                </div>
                <div style={{ display: 'flex', fontSize: 30, color: OG_PALETTE.textMuted }}>
                  {stat.label}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {input.callToAction ? (
            <div
              style={{
                display: 'flex',
                fontSize: 36,
                fontWeight: 600,
                color: OG_PALETTE.inkSoft,
                marginBottom: '20px',
              }}
            >
              {input.callToAction}
            </div>
          ) : null}
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <div
              style={{
                display: 'flex',
                flex: 1,
                // The wordmark is the LOGOTYPE: always the display face.
                // 30px + nowrap: „Повече от просто спорт" in Unbounded 800
                // measures ~495px here and must share the row with the
                // attribution without ever wrapping to two lines.
                fontFamily: 'Unbounded',
                fontSize: 30,
                fontWeight: 800,
                whiteSpace: 'nowrap',
                color: OG_PALETTE.brand,
              }}
            >
              {input.wordmark}
            </div>
            {input.attribution ? (
              <div style={{ display: 'flex', fontSize: 24, color: OG_PALETTE.textMuted }}>
                {input.attribution}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>,
    {
      ...STORY_SIZE,
      fonts: ogFonts(),
      ...(input.headers ? { headers: input.headers } : {}),
    },
  );
}
