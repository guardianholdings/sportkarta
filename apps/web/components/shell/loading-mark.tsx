/**
 * The animated „Усмивката" — the brand's loading state: the mark writes
 * itself on a 4.4s loop (choreography in globals.css, .sk-loading-mark__*).
 *
 * Pure and props-driven like PopsMark: `label` is the announced text, passed
 * in so this renders identically from server loading.tsx files and client
 * components. `role="status"` makes screen readers announce it politely,
 * once — the visual loop itself is aria-hidden.
 */
export function LoadingMark({
  size = 64,
  label,
  className,
}: {
  size?: number;
  /** Accessible announcement, e.g. Nav.loading. */
  label: string;
  className?: string;
}) {
  return (
    <span role="status" className={className}>
      <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
        <circle className="sk-loading-mark__eye" cx="31" cy="22" r="9" fill="currentColor" />
        <circle
          className="sk-loading-mark__eye sk-loading-mark__eye--right"
          cx="69"
          cy="22"
          r="9"
          fill="currentColor"
        />
        <path
          className="sk-loading-mark__lane"
          pathLength="100"
          d="M8 44 A42 42 0 0 0 92 44"
          fill="none"
          stroke="currentColor"
          strokeWidth="11"
          strokeLinecap="round"
        />
        <path
          className="sk-loading-mark__lane sk-loading-mark__lane--inner"
          pathLength="100"
          d="M24 44 A26 26 0 0 0 76 44"
          fill="none"
          stroke="currentColor"
          strokeWidth="11"
          strokeLinecap="round"
        />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}
