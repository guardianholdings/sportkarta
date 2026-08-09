/**
 * „Усмивката" — the POPS mark (docs/design/pops-brand/HANDOFF.md): two stadium
 * tracks forming a smile, two dots for eyes. Inline SVG in currentColor so the
 * caller's text colour paints it (the brand coral is `text-accent`).
 *
 * Two variants, per the brand rules: the full mark (two tracks) everywhere,
 * and the compact mark (one track) which is MANDATORY under 24px — the inner
 * track melts at favicon sizes. Static markup, safe in server and client trees.
 */
export function PopsMark({
  size = 40,
  compact = false,
  className,
}: {
  size?: number;
  /** Single-track variant — required below 24px. */
  compact?: boolean;
  className?: string;
}) {
  return compact ? (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className} aria-hidden="true">
      <circle cx="30" cy="24" r="10" fill="currentColor" />
      <circle cx="70" cy="24" r="10" fill="currentColor" />
      <path
        d="M12 46 A38 38 0 0 0 88 46"
        fill="none"
        stroke="currentColor"
        strokeWidth="13"
        strokeLinecap="round"
      />
    </svg>
  ) : (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className} aria-hidden="true">
      <circle cx="31" cy="22" r="9" fill="currentColor" />
      <circle cx="69" cy="22" r="9" fill="currentColor" />
      <path
        d="M8 44 A42 42 0 0 0 92 44"
        fill="none"
        stroke="currentColor"
        strokeWidth="11"
        strokeLinecap="round"
      />
      <path
        d="M24 44 A26 26 0 0 0 76 44"
        fill="none"
        stroke="currentColor"
        strokeWidth="11"
        strokeLinecap="round"
      />
    </svg>
  );
}
