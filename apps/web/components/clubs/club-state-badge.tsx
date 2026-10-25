import type { ClubAccessState } from '@sportkarta/lib/clubs';
import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  Hourglass,
  PauseCircle,
  type LucideIcon,
} from 'lucide-react';

import { Badge, type BadgeTone } from '@/components/ui/badge';

/**
 * State badges for the club module. NEVER colour alone (a COLOR_ONLY_DIRS
 * rule): every badge pairs its tone with an icon and the words, and the words
 * are what a screen reader reads.
 */

const CLUB_STATE: Record<ClubAccessState, { tone: BadgeTone; icon: LucideIcon }> = {
  pending: { tone: 'info', icon: Hourglass },
  trial: { tone: 'brand', icon: Clock },
  active: { tone: 'success', icon: CircleCheck },
  past_due: { tone: 'warning', icon: CircleAlert },
  lapsed: { tone: 'danger', icon: CircleX },
  suspended: { tone: 'danger', icon: Ban },
  archived: { tone: 'neutral', icon: CircleDashed },
};

export function ClubStateBadge({ state, label }: { state: ClubAccessState; label: string }) {
  const { tone, icon: Icon } = CLUB_STATE[state];
  return (
    <Badge tone={tone}>
      <Icon size={14} aria-hidden="true" />
      {label}
    </Badge>
  );
}

/** The validity vocabulary shared by memberships, members and charges. */
export type StatusKind = 'good' | 'pending' | 'warning' | 'bad' | 'neutral' | 'paused';

const STATUS: Record<StatusKind, { tone: BadgeTone; icon: LucideIcon }> = {
  good: { tone: 'success', icon: CircleCheck },
  pending: { tone: 'info', icon: Clock },
  warning: { tone: 'warning', icon: CircleAlert },
  bad: { tone: 'danger', icon: CircleX },
  neutral: { tone: 'neutral', icon: CircleDashed },
  paused: { tone: 'info', icon: PauseCircle },
};

export function StatusBadge({
  kind,
  label,
  title,
}: {
  kind: StatusKind;
  label: string;
  /** A fuller sentence for assistive tech, when the label alone is terse. */
  title?: string;
}) {
  const { tone, icon: Icon } = STATUS[kind];
  return (
    <Badge tone={tone} aria-label={title} title={title}>
      <Icon size={14} aria-hidden="true" />
      {label}
    </Badge>
  );
}

/** membership state → badge kind */
export function membershipKind(state: string): StatusKind {
  switch (state) {
    case 'active':
      return 'good';
    case 'upcoming':
      return 'pending';
    case 'paused':
      return 'paused';
    case 'exhausted':
    case 'expired':
      return 'warning';
    case 'cancelled':
      return 'neutral';
    default:
      return 'neutral';
  }
}

/** charge status → badge kind */
export function chargeKind(status: string): StatusKind {
  switch (status) {
    case 'paid':
      return 'good';
    case 'open':
      return 'pending';
    case 'partial':
      return 'warning';
    case 'overdue':
      return 'bad';
    default:
      return 'neutral';
  }
}

/** member status → badge kind */
export function memberKind(status: string): StatusKind {
  switch (status) {
    case 'active':
      return 'good';
    case 'trial':
      return 'pending';
    case 'lapsed':
      return 'warning';
    default:
      return 'neutral';
  }
}
