import { Ban, Check, CircleCheck, Clock, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { RecapStatusTone, RecapStatusView } from '@/lib/meetings/recap-view-types';

/**
 * BAL-388 §R1 — the recap status pill.
 *
 * ⚠ IT IS **NOT** `components/balo/engagement/status-chip.tsx`, and that is deliberate rather
 * than an oversight. That component's `StatusChipView` REQUIRES an
 * `EngagementWorkspaceStatus` — a project-delivery status a meeting recap does not have and
 * cannot honestly supply. This chip carries the recap's own four labels, reuses the same
 * shipped `Badge` primitive and the same semantic tokens, and adds nothing else.
 *
 * ⚠ THE CHIP NEVER NAMES WHO WAS ABSENT. Both no-show outcomes read "Not held"; who was where
 * is R11's body copy's job, stated exactly once.
 */
const ICONS: Record<RecapStatusView['icon'], LucideIcon> = {
  check: Check,
  clock: Clock,
  ban: Ban,
  'circle-check': CircleCheck,
};

const TONE_CLASSES: Record<RecapStatusTone, string> = {
  success: 'text-success bg-success/10 border-success/20',
  warning: 'text-warning bg-warning/10 border-warning/20',
  neutral: 'text-muted-foreground bg-muted border-border',
};

export function RecapStatusChip({
  status,
}: Readonly<{ status: RecapStatusView }>): React.JSX.Element {
  const Icon = ICONS[status.icon];
  return (
    <Badge variant="outline" className={cn('gap-1 font-medium', TONE_CLASSES[status.tone])}>
      <Icon aria-hidden="true" />
      {status.label}
    </Badge>
  );
}
