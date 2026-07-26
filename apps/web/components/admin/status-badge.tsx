import { useTranslations } from 'next-intl';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import type { FacilityStatus } from '@/lib/admin-data';

const STATUS_TONE: Record<FacilityStatus, BadgeTone> = {
  active: 'success',
  needs_verification: 'warning',
  gone: 'neutral',
};

export function StatusBadge({ status }: { status: FacilityStatus }) {
  const t = useTranslations('AdminStatus');
  return (
    <Badge tone={STATUS_TONE[status]} className="whitespace-nowrap">
      {t(status)}
    </Badge>
  );
}
