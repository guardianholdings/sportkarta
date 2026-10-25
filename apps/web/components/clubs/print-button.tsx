'use client';

import { Printer } from 'lucide-react';

/** Opens the browser's print dialog; the page's `print:` styles do the rest. */
export function PrintButton({ label, className }: { label: string; className?: string }) {
  return (
    <button type="button" onClick={() => window.print()} className={className}>
      <Printer aria-hidden="true" />
      {label}
    </button>
  );
}
