import Link from 'next/link';
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  Layers,
  Clock,
  Check,
  Ban,
  DollarSign,
  CalendarDays,
  Target,
  Flag,
  type LucideIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import type { EngagementHeaderView, ViewIcon } from '@/lib/engagement/engagement-view';
import { StatusChip } from './status-chip';

/** Maps the view's `ViewIcon` name (terms-strip pills) to its lucide component. */
const TERMS_ICONS: Record<ViewIcon, LucideIcon> = {
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

interface EngagementHeaderProps {
  header: EngagementHeaderView;
}

/**
 * The delivery-workspace header: back-link to Projects, the engagement title,
 * the status chip, a per-lens sub-line, the snapshotted commercial-terms strip,
 * and (only for request-backed engagements) a provenance link to the source
 * request. Read-only — every string comes from the view; the only interactive
 * elements are navigational `<Link>`s. Retainers carry `provenance === null`,
 * so the provenance link is simply omitted.
 */
export function EngagementHeader({ header }: Readonly<EngagementHeaderProps>): React.JSX.Element {
  const { provenance } = header;
  return (
    <div className="mb-5">
      <Link
        href={header.backHref}
        className="text-muted-foreground hover:text-foreground mb-3 inline-flex items-center gap-1 text-xs transition-colors"
      >
        <ChevronLeft aria-hidden="true" className="size-3.5" />
        Projects
      </Link>

      <div className="flex flex-wrap items-start gap-2.5">
        <h1 className="text-foreground min-w-[220px] flex-1 text-xl leading-tight font-semibold sm:text-[22px]">
          {header.engagementTitle}
        </h1>
        <StatusChip status={header.statusChip} />
      </div>

      <p className="text-muted-foreground mt-1.5 text-sm">{header.headerLine}</p>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {header.terms.map((item, index) => {
          const Icon = TERMS_ICONS[item.icon];
          return (
            <Badge
              key={`${item.label}-${index}`}
              variant="secondary"
              aria-label={`${item.label}: ${item.value}`}
              className="bg-card text-muted-foreground border-border gap-1 font-medium"
            >
              <Icon aria-hidden="true" />
              {item.value}
            </Badge>
          );
        })}

        {provenance !== null && (
          <Link
            href={provenance.href}
            className="text-primary bg-primary/10 border-primary/20 inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-opacity hover:opacity-90"
          >
            <FileText aria-hidden="true" className="size-2.5" />
            View request
            <ChevronRight aria-hidden="true" className="size-2.5" />
          </Link>
        )}
      </div>
    </div>
  );
}
