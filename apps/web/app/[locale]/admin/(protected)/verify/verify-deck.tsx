'use client';

import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import type { VerifyCard } from '@/lib/admin-data';
import { arrangeDeck } from '@/lib/admin-verify-deck';

import { decideFacility, type VerifyDecision } from './actions';

/**
 * One-keystroke clearing: V/В = active, S/С = skip (to the back of the deck),
 * G/Г = gone — after a confirmation, because «gone» takes the facility off the
 * map and emails its author the reason (A-12). Optimistic advance — the server
 * action runs in the background and is status-guarded, so a stale decision is
 * a no-op. When the local deck is exhausted the page refreshes for the next
 * batch.
 *
 * Every decision revalidates the page, so a fresh batch arrives in name order
 * after each one. Decided cards are dropped from it and SKIPPED ones go to the
 * back again — before, the next decision brought a skipped card straight back
 * on top (A-3).
 */
export function VerifyDeck({ cards, remaining }: { cards: VerifyCard[]; remaining: number }) {
  const t = useTranslations('AdminVerify');
  const tSport = useTranslations('Sport');
  const tSurface = useTranslations('Surface');
  const tAccess = useTranslations('Access');
  const tEdit = useTranslations('AdminEdit');
  const tMap = useTranslations('AdminMap');
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [deck, setDeck] = useState<VerifyCard[]>(cards);
  const [cleared, setCleared] = useState(0);
  // Decisions sent but not yet answered: the server's `remaining` already
  // leaves out every decision it has applied, so only these are subtracted —
  // subtracting every card cleared counted each decision twice (A-3).
  const [inFlight, setInFlight] = useState(0);
  const decidedRef = useRef<Set<string>>(new Set());
  // In the order they were skipped, so the back of the deck stays a queue.
  const skippedRef = useRef<string[]>([]);

  useEffect(() => {
    // Fresh server batch: drop cards already decided optimistically, and put
    // the skipped ones back where the operator sent them.
    setDeck(arrangeDeck(cards, decidedRef.current, skippedRef.current));
  }, [cards]);

  const advance = useCallback(
    (decision: VerifyDecision | 'skip') => {
      const card = deck[0];
      if (!card) return;
      if (decision === 'skip') {
        skippedRef.current = [...skippedRef.current.filter((id) => id !== card.id), card.id];
        setDeck((d) => {
          const [head, ...rest] = d;
          return head && rest.length > 0 ? [...rest, head] : d;
        });
        return;
      }
      if (decision === 'gone' && !window.confirm(t('goneConfirm'))) return;
      decidedRef.current.add(card.id);
      setCleared((n) => n + 1);
      setInFlight((n) => n + 1);
      setDeck((d) => d.slice(1));
      startTransition(async () => {
        try {
          await decideFacility(card.id, decision);
        } finally {
          setInFlight((n) => n - 1);
        }
        if (deck.length <= 1) router.refresh();
      });
    },
    [deck, router, t],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
      const key = event.key.toLowerCase();
      if (key === 'v' || key === 'в') advance('active');
      else if (key === 's' || key === 'с') advance('skip');
      else if (key === 'g' || key === 'г') advance('gone');
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [advance]);

  const card = deck[0];
  const left = Math.max(remaining - inFlight, deck.length);

  if (!card) {
    return (
      <p className="rounded-card border border-success-border bg-success-bg p-6 text-center text-success">
        {t('empty')}
      </p>
    );
  }

  const d = 0.003;
  const bbox = `${String(card.lon - d)},${String(card.lat - d)},${String(card.lon + d)},${String(card.lat + d)}`;
  const mapSrc = `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${String(card.lat)}%2C${String(card.lon)}`;

  return (
    <div className="mx-auto max-w-2xl space-y-3">
      <p className="font-mono text-caption text-text-muted tabular-nums">
        {t('cleared', { count: cleared })} · {t('remaining', { count: left })}
      </p>

      <div className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm">
        <div>
          <h2 className="text-h4 font-bold text-ink">
            {card.name ?? <span className="text-text-faint">—</span>}
          </h2>
          <p className="text-body-sm text-text-muted">
            {[card.municipalityName, card.quarter].filter(Boolean).join(' · ') || '—'}
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          {card.sportTypes.map((sport) => (
            <span
              key={sport}
              className="rounded-pill bg-paper-sunk px-2.5 py-0.5 text-caption font-medium text-ink-soft"
            >
              {tSport.has(sport) ? tSport(sport) : sport}
            </span>
          ))}
        </div>
        <p className="text-body-sm text-ink-soft">
          {tEdit('access')}: {tAccess(card.access)}
          {card.surface && (
            <>
              {' '}
              · {tEdit('surface')}:{' '}
              {tSurface.has(card.surface) ? tSurface(card.surface) : card.surface}
            </>
          )}
          {' · '}
          {tEdit('lighting')}:{' '}
          {card.lighting === null
            ? tEdit('lightingUnknown')
            : card.lighting
              ? tEdit('lightingYes')
              : tEdit('lightingNo')}
        </p>
        <figure className="space-y-1">
          <iframe
            src={mapSrc}
            title={tMap('openInOsm')}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="h-56 w-full rounded-card border border-line"
          />
          <figcaption className="text-caption text-text-muted">{tMap('attribution')}</figcaption>
        </figure>
        {card.osmTags && (
          <details>
            <summary className="cursor-pointer text-body-sm font-medium text-ink-soft">
              {tEdit('rawTags')}
            </summary>
            <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-paper-sunk p-2 text-caption">
              {JSON.stringify(card.osmTags, null, 2)}
            </pre>
          </details>
        )}
      </div>

      <div className="flex gap-2">
        <Button
          type="button"
          size="lg"
          iconLeft={<Check size={20} />}
          onClick={() => {
            advance('active');
          }}
          className="min-h-14 flex-1"
        >
          {t('verify')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="lg"
          onClick={() => {
            advance('skip');
          }}
          className="min-h-14 flex-1"
        >
          {t('skip')}
        </Button>
        <Button
          type="button"
          variant="danger"
          size="lg"
          onClick={() => {
            advance('gone');
          }}
          className="min-h-14 flex-1"
        >
          {t('gone')}
        </Button>
      </div>
      <p className="text-center text-caption text-text-muted">{t('keysHint')}</p>
    </div>
  );
}
