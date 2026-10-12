'use client';

import { useCallback, useEffect, useRef } from 'react';

import {
  decodeRecovery,
  encodeRecovery,
  pickEntries,
  recoveryKey,
  type RecoveredEntries,
} from './form-recovery';

/**
 * The browser side of lib/form-recovery.ts (B2): `saveAndReload(form)` keeps the
 * allowed fields in sessionStorage and reloads; after the new page has hydrated,
 * `onRestore` gets them back once and the copy is deleted. Restoring after
 * hydration (in an effect) keeps the server and client renders identical.
 *
 * Storage can be unavailable (private modes, quotas): the reload still
 * happens, only without the copy.
 */
export function useFormRecovery(
  form: string,
  allow: readonly string[],
  onRestore: (entries: RecoveredEntries) => void,
): (element: HTMLFormElement | null) => void {
  const restore = useRef(onRestore);
  restore.current = onRestore;
  const allowRef = useRef(allow);
  allowRef.current = allow;

  useEffect(() => {
    const key = recoveryKey(form, window.location.pathname);
    let raw: string | null = null;
    try {
      raw = window.sessionStorage.getItem(key);
      if (raw !== null) window.sessionStorage.removeItem(key);
    } catch {
      return;
    }
    const entries = decodeRecovery(raw, Date.now(), allowRef.current);
    if (entries && entries.length > 0) restore.current(entries);
  }, [form]);

  return useCallback(
    (element: HTMLFormElement | null) => {
      if (element) {
        const key = recoveryKey(form, window.location.pathname);
        const entries = pickEntries(new FormData(element), allowRef.current);
        try {
          window.sessionStorage.setItem(key, encodeRecovery(entries, Date.now()));
        } catch {
          // No storage: reload anyway, the form just starts empty.
        }
      }
      window.location.reload();
    },
    [form],
  );
}
