'use client';

import { MapPinPlus, NotebookPen, Plus, QrCode, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { IconButton } from '@/components/ui/icon-button';
import { Link } from '@/i18n/navigation';
import { addFacilityHref } from '@/lib/map/add-from-view';
import { cn } from '@/lib/utils';

/**
 * The «+» of the tab bar and the rail: three things a member does in a hurry,
 * one tap away (operator, 2026-10-31; UX audit N3). It used to add a facility
 * and nothing else, while logging a training took three taps through the
 * profile and checking in needed the phone's own camera app.
 *
 * A small MODAL menu, with the filter sheet's manners (map-explorer.tsx): focus
 * moves to the first action when it opens, Tab stays inside, Escape or a tap
 * outside closes it, and focus returns to the «+». On a phone it is a sheet
 * above the tab bar; on a desktop a card beside the rail, or above the map's
 * own «+». Portalled to <body>: the rail scrolls (overflow clips) and the map's
 * chrome sits in a pointer-events-none layer.
 *
 * `fromMap`: opened over /karta, «Добави съоръжение» starts the pin picker
 * where the map is looking (lib/map/add-from-view.ts).
 */

type Variant = 'tab' | 'rail' | 'floating';

function focusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'));
}

export function QuickActions({
  variant,
  fromMap = false,
  className,
}: {
  variant: Variant;
  fromMap?: boolean;
  className?: string;
}) {
  const t = useTranslations('Nav');
  const [open, setOpen] = useState(false);
  const [href, setHref] = useState('/dobavi');
  const [place, setPlace] = useState<React.CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Where the card stands, from the «+» that opened it. The phone sheet needs
  // no measuring: it is pinned to the bottom of the screen.
  useLayoutEffect(() => {
    if (!open || variant === 'tab') return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPlace(
      variant === 'rail'
        ? { left: rect.right + 8, top: Math.max(8, Math.min(rect.top - 8, window.innerHeight - 280)) }
        : { left: rect.left, bottom: window.innerHeight - rect.top + 8 },
    );
  }, [open, variant]);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    // The first ACTION, not the close button: the menu is opened to pick one.
    panelRef.current?.querySelector<HTMLElement>('a[href]')?.focus();
    return () => {
      if (trigger?.isConnected) trigger.focus();
    };
  }, [open]);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusables(panelRef.current);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function toggle() {
    if (!open) setHref(fromMap ? addFacilityHref(window.location.search) : '/dobavi');

    setOpen((v) => !v);
  }

  const actions = [
    { key: 'addFacility', href, icon: MapPinPlus },
    { key: 'logTraining', href: '/trenirovki?nova=1', icon: NotebookPen },
    { key: 'scanQr', href: '/skenirai', icon: QrCode },
  ] as const;

  const fab =
    'grid size-[54px] place-items-center rounded-full border-[3px] border-surface bg-accent text-on-accent shadow-lg transition-[transform,box-shadow] duration-150 ease-standard focus-visible:shadow-[var(--ring-accent)] active:scale-[0.97]';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={variant === 'rail' ? undefined : t('navAdd')}
        className={cn(
          variant === 'rail'
            ? 'flex flex-col items-center gap-1 rounded-md px-2 py-2 text-overline font-semibold text-ink-soft hover:bg-surface-2'
            : fab,
          variant === 'floating' && 'pointer-events-auto hover:scale-105',
          className,
        )}
      >
        {variant === 'rail' ? (
          <>
            <span className="grid size-9 place-items-center rounded-full bg-accent text-on-accent shadow-xs">
              {open ? <X size={20} /> : <Plus size={20} />}
            </span>
            {t('navAdd')}
          </>
        ) : open ? (
          <X size={26} />
        ) : (
          <Plus size={26} />
        )}
      </button>
      {open &&
        createPortal(
          <div className="fixed inset-0 z-[60]" onKeyDown={onKeyDown}>
            {/* Tap outside to close, for pointers; the keyboard has Escape. */}
            <div
              aria-hidden
              onClick={() => setOpen(false)}
              className={cn('absolute inset-0', variant === 'tab' && 'bg-overlay-scrim')}
            />
            <div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              style={variant === 'tab' ? undefined : place}
              className={cn(
                'absolute flex flex-col gap-1 bg-surface p-3 shadow-float',
                variant === 'tab'
                  ? 'inset-x-0 bottom-0 rounded-t-xl pb-[calc(env(safe-area-inset-bottom)+1rem)]'
                  : 'w-[320px] rounded-sheet border border-line',
              )}
            >
              {/* A close button inside: a screen reader on a phone has no Escape
                  key and cannot tap the (hidden) backdrop. */}
              <div className="flex items-center justify-between gap-2 pl-2">
                <h2 id={titleId} className="text-overline font-semibold text-text-muted">
                  {t('quick.title')}
                </h2>
                <IconButton
                  aria-label={t('quick.close')}
                  variant="surface"
                  round
                  onClick={() => setOpen(false)}
                >
                  <X size={18} />
                </IconButton>
              </div>

              {actions.map(({ key, href: to, icon: Icon }) => (
                <Link
                  key={key}
                  href={to}
                  onClick={() => setOpen(false)}
                  className="flex min-h-14 items-center gap-3 rounded-card px-2 py-2 hover:bg-surface-2 focus-visible:shadow-[var(--ring)]"
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-subtle text-accent-active">
                    <Icon size={20} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-body font-semibold text-ink">
                      {t(`quick.${key}.title`)}
                    </span>
                    <span className="block text-caption text-text-muted">
                      {t(`quick.${key}.hint`)}
                    </span>
                  </span>
                </Link>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
