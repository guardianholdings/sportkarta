'use client';

import * as React from 'react';

/**
 * A submit button that asks for confirmation (`window.confirm`) before letting
 * its form submit. This is the ONE confirmation policy for one-click admin ops
 * that remove access or data but are not irreversible enough to warrant the
 * type-to-confirm guard (campaign close, account delete use that instead):
 * live OSM import, revoke ambassador, remove a municipality from an ambassador's
 * scope, cancel a campaign, mark a facility gone.
 *
 * The confirm is only a UX guard against a stray click — every one of these
 * actions is re-authorized server-side (`requireRole` / municipality scope), so
 * a dismissed dialog changes nothing the action itself would not also refuse.
 *
 * Raw <button> (not the design-system `Button`) so each caller keeps its own
 * page-local styling via `className`; the admin console is still on pre-seed
 * styling and a confirm gate must not restyle only the buttons it guards.
 */
export function ConfirmButton({
  message,
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { message: string }) {
  return (
    <button
      {...rest}
      type="submit"
      className={className}
      onClick={(event) => {
        if (!window.confirm(message)) event.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
