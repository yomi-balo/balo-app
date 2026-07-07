import { Check, Flag, Target } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { RichText } from '@/components/balo/project-request/rich-text';
import { cn } from '@/lib/utils';
import type { MilestoneNodeVariant, MilestoneNodeView } from '@/lib/engagement/engagement-view';

interface MilestoneRailProps {
  milestones: MilestoneNodeView[];
}

const GRADIENT = 'bg-gradient-to-br from-primary to-violet-600';

/** Status-pill tone classes keyed by milestone node variant. */
const STATUS_PILL: Record<MilestoneNodeVariant, string> = {
  completed: 'text-success bg-success/10 border-success/20',
  in_progress: 'text-primary bg-primary/10 border-primary/20',
  pending: 'text-muted-foreground bg-muted border-border',
};

function RailNode({ variant }: Readonly<{ variant: MilestoneNodeVariant }>): React.JSX.Element {
  if (variant === 'completed') {
    return (
      <div
        className={cn(
          'flex size-[26px] shrink-0 items-center justify-center rounded-full shadow-sm',
          GRADIENT
        )}
      >
        <Check className="size-3.5 text-white" aria-hidden />
      </div>
    );
  }
  if (variant === 'in_progress') {
    return (
      <div className="border-primary bg-card flex size-[26px] shrink-0 items-center justify-center rounded-full border-2 motion-safe:animate-[nodeBreathe_2.2s_ease-in-out_infinite] motion-reduce:animate-none">
        <div className="bg-primary size-2.5 rounded-full" />
      </div>
    );
  }
  return <div className="border-border bg-card size-[26px] shrink-0 rounded-full border-2" />;
}

function MilestoneRow({
  node,
  isLast,
}: Readonly<{ node: MilestoneNodeView; isLast: boolean }>): React.JSX.Element {
  const timing = [node.startedLabel, node.completedLabel].filter(
    (label): label is string => label !== null
  );

  return (
    <div className="flex gap-4">
      {/* Rail column: node + gradient-fillable connector. */}
      <div className="flex flex-col items-center">
        <RailNode variant={node.nodeVariant} />
        {!isLast && (
          <div
            className={cn(
              'my-1 min-h-7 w-[2.5px] flex-1 rounded-full',
              node.connectorFilled ? GRADIENT : 'bg-border'
            )}
          />
        )}
      </div>

      <div className={cn('min-w-0 flex-1', isLast ? 'pb-0' : 'pb-6')}>
        <div className="flex flex-wrap items-start gap-2">
          <p
            className={cn(
              'min-w-40 flex-1 text-sm font-semibold',
              node.nodeVariant === 'pending' ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {node.title}
          </p>
          <Badge variant="outline" className={cn('shrink-0', STATUS_PILL[node.nodeVariant])}>
            {node.statusLabel}
          </Badge>
          {node.valueLabel !== null && (
            <Badge
              variant="outline"
              className="text-muted-foreground bg-muted border-border shrink-0"
            >
              {node.valueLabel}
            </Badge>
          )}
        </div>

        {node.descriptionHtml !== null && (
          <div className="mt-1.5">
            <RichText html={node.descriptionHtml} size="sm" />
          </div>
        )}

        {node.acceptanceCriteria !== null && (
          <p className="text-muted-foreground mt-1.5 flex gap-1.5 text-xs leading-relaxed">
            <Target className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span>
              <strong className="text-foreground font-semibold">Done when:</strong>{' '}
              {node.acceptanceCriteria}
            </span>
          </p>
        )}

        {timing.length > 0 && (
          <p className="text-muted-foreground mt-2 text-xs">{timing.join(' · ')}</p>
        )}

        {node.completionNote !== null && (
          <div className="bg-success/10 border-success/20 mt-2.5 rounded-lg border px-3 py-2">
            <p className="text-foreground text-sm leading-relaxed">
              <strong className="text-success font-semibold">Delivered:</strong>{' '}
              {node.completionNote}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The delivery plan — a vertical milestone rail. Each node reflects its status
 * (pending: bordered circle, in_progress: breathing primary ring, completed:
 * gradient circle + check), with the connector below a completed node filled by
 * the signature blue→violet gradient. Read-only: descriptions render through the
 * sanitising `RichText`, acceptance criteria under "Done when:", timing labels,
 * and the success-tinted "Delivered:" completion note. NO action buttons — all
 * mutations belong to later delivery slices. Caller guards on `hasMilestones`.
 */
export function MilestoneRail({ milestones }: Readonly<MilestoneRailProps>): React.JSX.Element {
  return (
    <Card className="border-border bg-card p-6">
      <div className="text-muted-foreground flex items-center gap-2 text-xs font-semibold tracking-wide uppercase">
        <Flag className="size-3.5" aria-hidden />
        Delivery plan
      </div>
      <div className="mt-4">
        {milestones.map((node, index) => (
          <MilestoneRow key={node.id} node={node} isLast={index === milestones.length - 1} />
        ))}
      </div>
    </Card>
  );
}
