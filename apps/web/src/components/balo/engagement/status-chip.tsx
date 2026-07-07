import {
  Layers,
  Clock,
  Check,
  Ban,
  DollarSign,
  CalendarDays,
  FileText,
  Target,
  Flag,
  type LucideIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { StatusChipView, StatusTone, ViewIcon } from '@/lib/engagement/engagement-view';

/** Maps the view's `ViewIcon` name to its lucide component. */
const ICONS: Record<ViewIcon, LucideIcon> = {
  Layers,
  Clock,
  Check,
  Ban,
  DollarSign,
  CalendarDays,
  FileText,
  Target,
  Flag,
};

/** Semantic tone → tinted token classes (dark-mode safe). */
const TONE_CLASSES: Record<StatusTone, string> = {
  success: 'text-success bg-success/10 border-success/20',
  warning: 'text-warning bg-warning/10 border-warning/20',
  destructive: 'text-destructive bg-destructive/10 border-destructive/20',
  neutral: 'text-muted-foreground bg-muted border-border',
};

interface StatusChipProps {
  status: StatusChipView;
}

/**
 * The engagement status pill. Read-only: renders the pre-derived
 * `status.label`/`status.tone`/`status.icon` from the view (e.g. "Awaiting
 * client review" for `pending_acceptance`). All copy + tone come from the view;
 * this component only maps the icon name and tone to classes.
 */
export function StatusChip({ status }: Readonly<StatusChipProps>): React.JSX.Element {
  const Icon = ICONS[status.icon];
  return (
    <Badge variant="outline" className={cn('gap-1 font-medium', TONE_CLASSES[status.tone])}>
      <Icon aria-hidden="true" />
      {status.label}
    </Badge>
  );
}
