'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { demoBlocksSubmit } from '@/lib/clubs/demo-guard';

/**
 * Wraps the demo club's office pages (ClubShell, status `demo` only). A submit
 * that would save or send is stopped here, in the capture phase, before it
 * reaches the form or React's root listener, so no server action is called,
 * and `message` says why at the bottom of the screen, near the button that was
 * pressed. Without JavaScript the POST still goes and still meets
 * `requireClubStaff`, so nothing is written either way (lib/clubs/demo-guard.ts).
 */
export function DemoFormGuard({ message, children }: { message: string; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onSubmit = (event: SubmitEvent) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      const by = event.submitter;
      const submit = {
        method: by?.getAttribute('formmethod') ?? form.getAttribute('method'),
        action: by?.getAttribute('formaction') ?? form.getAttribute('action'),
      };
      if (!demoBlocksSubmit(submit)) return;
      event.preventDefault();
      event.stopPropagation();
      setTries((n) => n + 1);
    };
    el.addEventListener('submit', onSubmit, true);
    return () => el.removeEventListener('submit', onSubmit, true);
  }, []);

  return (
    <div ref={root}>
      {children}
      <div
        role="status"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4"
      >
        {tries > 0 && (
          <p
            key={tries}
            className="pointer-events-auto max-w-prose rounded-card border border-brand-border bg-brand-subtle px-4 py-2 text-body-sm text-ink shadow-md"
          >
            {message}
          </p>
        )}
      </div>
    </div>
  );
}
