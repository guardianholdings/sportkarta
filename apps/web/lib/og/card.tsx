import { ImageResponse } from 'next/og';

import { ogFonts } from './fonts';
import { OG_PALETTE } from './palette';

/**
 * The shared 1200×630 card grammar (docs/ENGAGEMENT.md C2).
 *
 * One layout, parameterised — so the six surfaces read as a SET rather than six
 * separately-designed images, and so the rules below are stated once.
 *
 * SAFE AREA. 64px on every edge. Facebook crops roughly 5% on some surfaces and
 * Viber renders a 1.91:1 crop; 64px absorbs both, which matters because Viber is
 * the country's primary sharing surface (§1.1) and a title clipped in half is
 * worse than no card.
 *
 * TYPE IS IN LITERAL PX because no token resolves inside satori. The scale
 * mirrors the product's: eyebrow 24 mono, title 58 Unbounded 700, subtitle 30,
 * stat 56 mono, label 22.
 *
 * SATORI CONSTRAINTS, all silent failures if broken: every element with more
 * than one child needs `display: flex`; there are no CSS variables; no external
 * stylesheet; no `url()` beyond a data URI; and NO EMOJI — the design system
 * forbids emoji in product UI, and the emoji grid belongs to the C3 plain-TEXT
 * share, not to an image.
 *
 * A MISSING FIELD REMOVES ITS ROW. Never an empty band, never the word "null",
 * never a bare 0 — the same rule the reports catalogue applies (an absent figure
 * is an em dash, not a zero).
 */

export const OG_SIZE = { width: 1200, height: 630 } as const;

/** An em dash, for a stat whose value is genuinely unknown. */
export const OG_MISSING = '—';

export interface OgStat {
  value: string;
  label: string;
}

export interface OgCardInput {
  /** Small uppercase line above the title. Omitted entirely when absent. */
  eyebrow?: string | null;
  title: string;
  subtitle?: string | null;
  stats?: OgStat[];
  /** Up to one line of footer detail beside the wordmark. */
  footnote?: string | null;
  /**
   * OSM/Protomaps credit. REQUIRED on any card naming a mapped place — the
   * attribution rule applies to every map view and export, and a facility card
   * is an export of map data. Omitted on cards that render only campaign or
   * member data.
   */
  attribution?: string | null;
  /** The 12px full-bleed left rule. Defaults to brand. */
  accent?: string;
  /** Wordmark, from messages — never hardcoded (the Cyrillic gate is repo-wide). */
  wordmark: string;
  /**
   * Response headers to override.
   *
   * REQUIRED for any card that names a person. ImageResponse defaults to
   * `public, immutable, no-transform, max-age=31536000` — a ONE-YEAR immutable
   * public copy, which for a card carrying a member's name is functionally the
   * frozen named artifact migration 0012 forbids: a member who erases their
   * account or goes private cannot revoke it. Person-scoped routes pass
   * `private, no-store` here AND declare `dynamic = 'force-dynamic'`, so nothing
   * is written to the ISR cache either.
   */
  headers?: Record<string, string>;
}

export function renderOgCard(input: OgCardInput): ImageResponse {
  const accent = input.accent ?? OG_PALETTE.brand;
  const stats = input.stats ?? [];

  return new ImageResponse(
    (
      <div
        style={{
          width: '1200px',
          height: '630px',
          display: 'flex',
          background: OG_PALETTE.paper,
          fontFamily: 'Golos Text',
        }}
      >
        {/* The one graphic constant that makes the six cards a set. */}
        <div style={{ width: '12px', height: '630px', background: accent, display: 'flex' }} />

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            padding: '64px',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {input.eyebrow ? (
              <div
                style={{
                  display: 'flex',
                  fontFamily: 'JetBrains Mono',
                  fontSize: 24,
                  letterSpacing: '3.4px',
                  color: OG_PALETTE.textMuted,
                  marginBottom: '18px',
                }}
              >
                {input.eyebrow.toUpperCase()}
              </div>
            ) : null}

            <div
              style={{
                display: 'flex',
                // Unbounded (the display face) runs ~25% wider than a text
                // sans at the same size — 58px keeps roughly the char-per-line
                // budget the 68px Manrope title had.
                fontFamily: 'Unbounded',
                fontSize: 58,
                fontWeight: 700,
                lineHeight: 1.1,
                color: OG_PALETTE.ink,
                // Two lines, then clip: a third line would collide with the
                // stat row. 128 = ceil(2 lines × 58px × 1.1) — the old 150 was
                // sized for the retired 68px face and clipped glyph tops of a
                // third line.
                overflow: 'hidden',
                maxHeight: '128px',
              }}
            >
              {input.title}
            </div>

            {input.subtitle ? (
              <div
                style={{
                  display: 'flex',
                  fontSize: 30,
                  fontWeight: 400,
                  color: OG_PALETTE.inkSoft,
                  marginTop: '16px',
                }}
              >
                {input.subtitle}
              </div>
            ) : null}
          </div>

          {stats.length > 0 ? (
            <div style={{ display: 'flex', gap: '56px' }}>
              {stats.map((stat) => (
                <div key={stat.label} style={{ display: 'flex', flexDirection: 'column' }}>
                  <div
                    style={{
                      display: 'flex',
                      fontFamily: 'JetBrains Mono',
                      fontSize: 56,
                      color: OG_PALETTE.ink,
                    }}
                  >
                    {stat.value}
                  </div>
                  <div
                    style={{ display: 'flex', fontSize: 22, color: OG_PALETTE.textMuted }}
                  >
                    {stat.label}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <div
              style={{
                display: 'flex',
                flex: 1,
                // The wordmark is the LOGOTYPE: always the display face.
                fontFamily: 'Unbounded',
                fontSize: 24,
                fontWeight: 800,
                color: OG_PALETTE.brand,
              }}
            >
              {input.wordmark}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              {input.footnote ? (
                <div style={{ display: 'flex', fontSize: 22, color: OG_PALETTE.inkSoft }}>
                  {input.footnote}
                </div>
              ) : null}
              {input.attribution ? (
                <div style={{ display: 'flex', fontSize: 20, color: OG_PALETTE.textMuted }}>
                  {input.attribution}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    ),
    { ...OG_SIZE, fonts: ogFonts(), ...(input.headers ? { headers: input.headers } : {}) },
  );
}
