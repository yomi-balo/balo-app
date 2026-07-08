import { Check, Target } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { RICH_TEXT_CONTENT_CLASS } from '@/components/balo/rich-text/types';
import { cn } from '@/lib/utils';
import type { MilestoneNodeVariant, MilestoneNodeView } from '@/lib/engagement/engagement-view';

/** The signature blue→violet gradient used by completed nodes + filled connectors. */
export const GRADIENT = 'bg-gradient-to-br from-primary to-violet-600';

/** Status-pill tone classes keyed by milestone node variant. */
export const STATUS_PILL: Record<MilestoneNodeVariant, string> = {
  completed: 'text-success bg-success/10 border-success/20',
  in_progress: 'text-primary bg-primary/10 border-primary/20',
  pending: 'text-muted-foreground bg-muted border-border',
};

/**
 * The rail node circle for a milestone: gradient + check (completed), a breathing
 * primary ring (in_progress), or a bordered circle (pending). CLIENT-SAFE — pure
 * presentation, no server-only imports, so both the read-only server rail and the
 * interactive client rail can render it.
 */
export function MilestoneRailNode({
  variant,
}: Readonly<{ variant: MilestoneNodeVariant }>): React.JSX.Element {
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

interface MilestoneRowProps {
  node: MilestoneNodeView;
  isLast: boolean;
  /** Optional per-status action buttons rendered at the row foot (expert rail only). */
  actions?: React.ReactNode;
  /**
   * Optional edit / remove / reorder icon buttons rendered in the title cluster,
   * top-right of the row (design L804–809). Expert rail only; presentational here.
   */
  controls?: React.ReactNode;
}

/**
 * One milestone row on the delivery rail: node + gradient-fillable connector, title,
 * status pill, optional value pill, description, acceptance criteria ("Done when:"),
 * timing labels, and the success-tinted "Delivered:" completion note — plus an
 * optional `actions` slot at the foot.
 *
 * CLIENT-SAFE and SHARED: it carries NO `'use client'` and NO server-only imports.
 * The description is injected via `dangerouslySetInnerHTML` inside a div carrying
 * `RICH_TEXT_CONTENT_CLASS` — the HTML is ALREADY sanitised by the server view-mapper
 * (`deriveMilestones` → `sanitizeProjectHtml`), so this component never calls the
 * `server-only` `RichText`/`sanitizeProjectHtml`. That lets the interactive
 * `ExpertMilestoneRail` re-render nodes optimistically on the client while the
 * read-only `MilestoneRail` stays a server component.
 */
export function MilestoneRow({
  node,
  isLast,
  actions,
  controls,
}: Readonly<MilestoneRowProps>): React.JSX.Element {
  const timing = [node.startedLabel, node.completedLabel].filter(
    (label): label is string => label !== null
  );

  return (
    <div className="flex gap-4">
      {/* Rail column: node + gradient-fillable connector. */}
      <div className="flex flex-col items-center">
        <MilestoneRailNode variant={node.nodeVariant} />
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
          {controls !== undefined && (
            <span className="ml-auto inline-flex shrink-0 items-center gap-0.5">{controls}</span>
          )}
        </div>

        {node.descriptionHtml !== null && (
          <div
            className={cn(
              'text-muted-foreground mt-1.5 text-sm leading-relaxed',
              RICH_TEXT_CONTENT_CLASS
            )}
            // Server-sanitised in the view-mapper (`sanitizeProjectHtml`). Safe-by-construction.
            dangerouslySetInnerHTML={{ __html: node.descriptionHtml }}
          />
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

        {actions !== undefined && <div className="mt-2.5 flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  );
}
