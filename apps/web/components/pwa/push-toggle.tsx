'use client';

import { useEffect, useState } from 'react';

import {
  pushDeviceMineAction,
  subscribePushAction,
  unsubscribePushAction,
} from '@/app/[locale]/profil/push-actions';

/**
 * Notifications on THIS device (0051). The browser keeps the subscription;
 * the server keeps a copy so the worker can reach it. Nothing is asked of the
 * browser until the person presses the button — no permission prompt on page
 * load.
 *
 * Where the browser cannot do Web Push (an iPhone outside the installed app,
 * or a page without the service worker), the toggle says so instead of
 * offering a button that cannot work.
 */

type State = 'checking' | 'unsupported' | 'denied' | 'off' | 'on' | 'busy';

export interface PushToggleLabels {
  on: string;
  off: string;
  enable: string;
  disable: string;
  denied: string;
  unsupported: string;
  failed: string;
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function supported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

const BUTTON =
  'inline-flex min-h-11 items-center rounded-pill border border-line-strong bg-surface px-4 text-body-sm font-semibold text-ink hover:bg-surface-2 focus-visible:shadow-[var(--ring)] focus-visible:outline-none disabled:opacity-60';

export function PushToggle({ publicKey, labels }: { publicKey: string; labels: PushToggleLabels }) {
  const [state, setState] = useState<State>('checking');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!supported()) {
        if (!cancelled) setState('unsupported');
        return;
      }
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) {
        if (!cancelled) setState('unsupported');
        return;
      }
      const subscription = await registration.pushManager.getSubscription();
      if (cancelled) return;
      if (subscription) {
        // A shared browser may hold ANOTHER account's subscription: drop it
        // here, so that account's notices stop showing on this device.
        const { mine } = await pushDeviceMineAction(subscription.endpoint);
        if (cancelled) return;
        if (mine) {
          setState('on');
          return;
        }
        await subscription.unsubscribe().catch(() => undefined);
      }
      setState(Notification.permission === 'denied' ? 'denied' : 'off');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function enable() {
    setFailed(false);
    setState('busy');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'off');
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(publicKey),
      });
      const saved = await subscribePushAction(subscription.toJSON());
      if (!saved.ok) {
        await subscription.unsubscribe();
        setFailed(true);
        setState('off');
        return;
      }
      setState('on');
    } catch {
      setFailed(true);
      setState('off');
    }
  }

  async function disable() {
    setFailed(false);
    setState('busy');
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await unsubscribePushAction(subscription.endpoint);
        await subscription.unsubscribe();
      }
      setState('off');
    } catch {
      setFailed(true);
      setState('on');
    }
  }

  if (state === 'checking') return null;
  if (state === 'unsupported' || state === 'denied') {
    return (
      <p className="text-caption text-ink-soft" role="status">
        {state === 'unsupported' ? labels.unsupported : labels.denied}
      </p>
    );
  }
  const on = state === 'on';
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="min-w-0 flex-1 text-caption text-ink-soft" role="status">
        {failed ? labels.failed : on ? labels.on : labels.off}
      </p>
      <button
        type="button"
        onClick={() => void (on ? disable() : enable())}
        disabled={state === 'busy'}
        aria-pressed={on}
        className={BUTTON}
      >
        {on ? labels.disable : labels.enable}
      </button>
    </div>
  );
}
