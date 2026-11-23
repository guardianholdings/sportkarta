/**
 * The demo club's office is view-only. Its forms still render, so a visitor
 * sees every screen as a club would, but a submit that would save or send is
 * stopped in the browser and answered with one line (`ClubOffice.demoBlocked`,
 * components/clubs/demo-form-guard.tsx). That is courtesy, not the lock: every
 * office action still calls `requireClubStaff`, which never returns the demo's
 * view-only context, and the demo's status fails `clubWritableSql`.
 *
 * A GET form to a real address (a list's filters) only navigates, so it goes
 * through. Anything else is stopped: a POST (how a server action posts without
 * JavaScript), a React action (rendered on the client, its `action` is a
 * `javascript:` URL) and any other method.
 */
export interface DemoSubmit {
  /** The submitter's `formmethod` when it has one, else the form's `method`, as written. */
  method: string | null;
  /** The submitter's `formaction` when it has one, else the form's `action`, as written. */
  action: string | null;
}

export function demoBlocksSubmit({ method, action }: DemoSubmit): boolean {
  const verb = (method ?? '').trim().toLowerCase() || 'get';
  if (verb === 'dialog') return false;
  if (verb !== 'get') return true;
  return (action ?? '').trim().toLowerCase().startsWith('javascript:');
}
