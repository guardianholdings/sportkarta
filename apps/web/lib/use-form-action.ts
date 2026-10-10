import { startTransition, useActionState, useCallback, useEffect, useRef } from 'react';
import type { FormEvent, RefObject } from 'react';

/**
 * `useActionState` for a form that must KEEP what the member typed when the
 * server answers with an error.
 *
 * WHY THIS EXISTS. React 19 resets a `<form action={fn}>` once the action
 * settles — whatever the action returned. react-dom wraps every function action
 * in `requestFormReset` (startHostTransition), so a validation error came back
 * above an EMPTY form: /dobavi lost the photo, the name and the quarter, and
 * silently put access back to «свободен»; /signal lost an explanation of up to
 * 2,000 characters; the verify checklist snapped its «вече го няма» radio back
 * to «да» while the React state behind it stayed on «не», so a retry recorded
 * the wrong thing (UX audit 2026-10-10).
 *
 * HOW. The SAME action is dispatched from `onSubmit`, inside a transition, after
 * `preventDefault()`. React then hands its own form-action listener a `null`
 * action — which it runs as a no-op, with no reset — while `useActionState`
 * still drives `pending`, and a server `redirect()` still navigates.
 *
 * The `action` prop stays on the form on purpose: before hydration (a slow
 * phone, a tap during load) the browser submits the form natively, and with the
 * server action attached that is a POST to the action, as before. Without it,
 * the browser would GET the page with every field in the query string — an
 * email address or a date of birth in a URL and in the access log.
 *
 * A form that should start empty again after a SUCCESS says so with
 * `resetWhen`; nothing else is ever cleared.
 */
export interface FormActionProps {
  ref: RefObject<HTMLFormElement | null>;
  action: (payload: FormData) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export function useFormAction<State>(
  action: (state: Awaited<State>, payload: FormData) => State | Promise<State>,
  initialState: Awaited<State>,
  options: { resetWhen?: (state: Awaited<State>) => boolean } = {},
): [state: Awaited<State>, formProps: FormActionProps, pending: boolean] {
  const [state, dispatch, pending] = useActionState(action, initialState);
  const ref = useRef<HTMLFormElement>(null);

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      // A named submit button («Изпрати нов код») is part of what the browser
      // would have posted; FormData(form) alone leaves it out.
      const submitter = (event.nativeEvent as SubmitEvent).submitter;
      if (
        (submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement) &&
        submitter.name
      ) {
        data.append(submitter.name, submitter.value);
      }
      startTransition(() => dispatch(data));
    },
    [dispatch],
  );

  // Only a NEW state may reset the form: a caller's inline predicate changes on
  // every render, and re-asking it would wipe what the member types after a
  // success that is still the current state.
  const { resetWhen } = options;
  const handled = useRef(state);
  useEffect(() => {
    if (handled.current === state) return;
    handled.current = state;
    if (resetWhen?.(state)) ref.current?.reset();
  });

  return [state, { ref, action: dispatch, onSubmit }, pending];
}
