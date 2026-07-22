'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

// Stub for the anonymous problem-report flow (docs/ROADMAP.md Stage 2.2).
// Until that lands, the button just surfaces a "coming soon" note.
export function ReportProblemButton() {
  const t = useTranslations('Facility');
  const [shown, setShown] = useState(false);

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => {
          setShown(true);
        }}
        className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50"
      >
        {t('reportProblem')}
      </button>
      {shown && (
        <p role="status" className="text-sm text-neutral-600">
          {t('reportComingSoon')}
        </p>
      )}
    </div>
  );
}
