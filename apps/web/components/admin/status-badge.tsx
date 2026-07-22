import { useTranslations } from 'next-intl';

import type { FacilityStatus } from '@/lib/admin-data';

const STATUS_CLASSES: Record<FacilityStatus, string> = {
  active: 'bg-green-100 text-green-800',
  needs_verification: 'bg-amber-100 text-amber-800',
  gone: 'bg-neutral-200 text-neutral-600',
};

export function StatusBadge({ status }: { status: FacilityStatus }) {
  const t = useTranslations('AdminStatus');
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${STATUS_CLASSES[status]}`}
    >
      {t(status)}
    </span>
  );
}
