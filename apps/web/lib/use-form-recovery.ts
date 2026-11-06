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

/**
 * Put kept values back into a form's own (uncontrolled) fields after the reload:
 * text and selects get their value back, checkboxes and radios are checked
 * exactly when their value was kept. Fields React drives (a radio with
 * `checked={state}`, hidden inputs rendered from state) go back through their
 * state instead, so leave them out of `names`. Files and hidden inputs are
 * never touched, and a select keeps its default when the kept value is no
 * longer one of its options.
 */
export function restoreFields(
  form: HTMLFormElement,
  entries: RecoveredEntries,
  names: readonly string[],
): void {
  for (const element of Array.from(form.elements)) {
    if (
      !(element instanceof HTMLInputElement) &&
      !(element instanceof HTMLSelectElement) &&
      !(element instanceof HTMLTextAreaElement)
    ) {
      continue;
    }
    if (!names.includes(element.name)) continue;
    const values = entries.filter(([name]) => name === element.name).map(([, value]) => value);
    if (element instanceof HTMLInputElement) {
      if (element.type === 'file' || element.type === 'hidden') continue;
      if (element.type === 'checkbox' || element.type === 'radio') {
        element.checked = values.includes(element.value);
        continue;
      }
    }
    const [first] = values;
    if (first === undefined) continue;
    if (
      element instanceof HTMLSelectElement &&
      !Array.from(element.options).some((option) => option.value === first)
    ) {
      continue;
    }
    element.value = first;
  }
}
