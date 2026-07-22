'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';

import type { VerifyCard } from '@/lib/admin-data';

import { decideFacility, type VerifyDecision } from './actions';

/**
 * One-keystroke clearing: V/В = active, S/С = skip (rotates to the back of
 * the local deck), G/Г = gone. Optimistic advance — the server action runs in
 * the background and is status-guarded, so a stale decision is a no-op. When
 * the local deck is exhausted the page refreshes for the next batch.
 */
export function VerifyDeck({ cards, remaining }: { cards: VerifyCard[]; remaining: number }) {
  const t = useTranslations('AdminVerify');
  const tSport = useTranslations('AdminSport');
  const tSurface = useTranslations('AdminSurface');
  const tAccess = useTranslations('AdminAccess');
  const tEdit = useTranslations('AdminEdit');
  const tMap = useTranslations('AdminMap');
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [deck, setDeck] = useState<VerifyCard[]>(cards);
  const [cleared, setCleared] = useState(0);
  const decidedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // Fresh server batch: drop cards already decided optimistically.
    setDeck(cards.filter((c) => !decidedRef.current.has(c.id)));
  }, [cards]);

  const advance = useCallback(
    (decision: VerifyDecision | 'skip') => {
      const card = deck[0];
      if (!card) return;
      if (decision === 'skip') {
        setDeck((d) => {
          const [head, ...rest] = d;
          return head && rest.length > 0 ? [...rest, head] : d;
        });
        return;
      }
      decidedRef.current.add(card.id);
      setCleared((n) => n + 1);
      setDeck((d) => d.slice(1));
      startTransition(async () => {
        await decideFacility(card.id, decision);
        if (deck.length <= 1) router.refresh();
      });
    },
    [deck, router],
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
  const left = Math.max(remaining - cleared, deck.length);

  if (!card) {
    return <p className="rounded bg-green-50 p-6 text-center text-green-800">{t('empty')}</p>;
  }

  const d = 0.003;
  const bbox = `${String(card.lon - d)},${String(card.lat - d)},${String(card.lon + d)},${String(card.lat + d)}`;
  const mapSrc = `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${String(card.lat)}%2C${String(card.lon)}`;

  return (
    <div className="mx-auto max-w-lg space-y-3">
      <p className="text-sm text-neutral-500">
        {t('cleared', { count: cleared })} · {t('remaining', { count: left })}
      </p>

      <div className="space-y-3 rounded-lg border border-neutral-200 p-4 shadow-sm">
        <div>
          <h2 className="text-lg font-semibold">
            {card.name ?? <span className="text-neutral-400">—</span>}
          </h2>
          <p className="text-sm text-neutral-500">
            {[card.municipalityName, card.quarter].filter(Boolean).join(' · ') || '—'}
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          {card.sportTypes.map((sport) => (
            <span key={sport} className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs">
              {tSport.has(sport) ? tSport(sport) : sport}
            </span>
          ))}
        </div>
        <p className="text-sm text-neutral-600">
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
            className="h-56 w-full rounded border border-neutral-200"
          />
          <figcaption className="text-xs text-neutral-500">{tMap('attribution')}</figcaption>
        </figure>
        {card.osmTags && (
          <details>
            <summary className="cursor-pointer text-sm font-medium">{tEdit('rawTags')}</summary>
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-neutral-50 p-2 text-xs">
              {JSON.stringify(card.osmTags, null, 2)}
            </pre>
          </details>
        )}
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            advance('active');
          }}
          className="min-h-14 flex-1 rounded-lg bg-green-600 font-semibold text-white"
        >
          ✓ {t('verify')}
        </button>
        <button
          type="button"
          onClick={() => {
            advance('skip');
          }}
          className="min-h-14 flex-1 rounded-lg bg-neutral-200 font-semibold"
        >
          {t('skip')}
        </button>
        <button
          type="button"
          onClick={() => {
            advance('gone');
          }}
          className="min-h-14 flex-1 rounded-lg bg-red-600 font-semibold text-white"
        >
          {t('gone')}
        </button>
      </div>
      <p className="text-center text-xs text-neutral-400">{t('keysHint')}</p>
    </div>
  );
}
