import { ArrowRight, Pencil, Plus, Trash2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ChangeOrderLineView } from '@/lib/engagement/change-order-view';
import { TonePill, type ChangeOrderTone } from './change-order-tone';

interface ChangeOrderLinesProps {
  lines: ChangeOrderLineView[];
}

const OP_PILL: Record<
  ChangeOrderLineView['op'],
  { tone: ChangeOrderTone; label: string; icon: typeof Plus }
> = {
  add: { tone: 'success', label: 'New', icon: Plus },
  edit: { tone: 'info', label: 'Edited', icon: Pencil },
  remove: { tone: 'destructive', label: 'Removed', icon: Trash2 },
};

interface BeforeAfterProps {
  label: string;
  before: string | null;
  after: string | null;
  inline?: boolean;
}

/** One before / after pair: stacked columns for prose, a single arrowed line for short values. */
function BeforeAfter({
  label,
  before,
  after,
  inline = false,
}: Readonly<BeforeAfterProps>): React.JSX.Element {
  if (inline) {
    return (
      <p className="flex flex-wrap items-center gap-1.5 text-sm">
        <span className="text-muted-foreground text-xs font-medium">{label}</span>
        <span className="text-muted-foreground line-through">{before ?? '—'}</span>
        <ArrowRight className="text-muted-foreground size-3" aria-hidden />
        <span className="text-foreground font-medium">{after ?? '—'}</span>
      </p>
    );
  }
  return (
    <div className="grid gap-1 text-sm sm:grid-cols-2 sm:gap-3">
      <div>
        <p className="text-muted-foreground text-xs font-medium">{label} before</p>
        <p className="text-muted-foreground leading-relaxed line-through">{before ?? '—'}</p>
      </div>
      <div>
        <p className="text-muted-foreground text-xs font-medium">{label} after</p>
        <p className="text-foreground leading-relaxed">{after ?? '—'}</p>
      </div>
    </div>
  );
}

/**
 * The milestone lines of a change order: New / Edited / Removed, with a before / after pair
 * for each edited field. Server-safe and presentational; every string is pre-derived on the
 * view, and an edit line shows only the fields that actually differ, plus, on an open T&M
 * order, the hours already logged on a milestone whose estimate it changes.
 */
export function ChangeOrderLines({ lines }: Readonly<ChangeOrderLinesProps>): React.JSX.Element {
  if (lines.length === 0) {
    return <p className="text-muted-foreground mt-3 text-sm">No change to the milestones.</p>;
  }
  return (
    <ul className="mt-3 space-y-2">
      {lines.map((line) => {
        const pill = OP_PILL[line.op];
        const { before } = line;
        return (
          <li
            key={`${line.op}-${line.title}-${before?.title ?? ''}`}
            className="border-border bg-card rounded-xl border p-3 text-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <TonePill tone={pill.tone} icon={pill.icon}>
                {pill.label}
              </TonePill>
              <span
                className={cn(
                  'text-foreground font-medium',
                  line.op === 'remove' && 'text-muted-foreground line-through'
                )}
              >
                {line.title}
              </span>
              {line.op === 'add' && line.estimateLabel !== null && (
                <span className="text-muted-foreground text-xs">Estimate {line.estimateLabel}</span>
              )}
            </div>
            {line.op === 'add' && line.descriptionText !== null && (
              <p className="text-muted-foreground mt-1.5 leading-relaxed">{line.descriptionText}</p>
            )}
            {line.op === 'edit' && before !== null && (
              <div className="mt-2 space-y-1.5">
                {before.title !== line.title && (
                  <BeforeAfter label="Name" before={before.title} after={line.title} />
                )}
                {before.descriptionText !== line.descriptionText && (
                  <BeforeAfter
                    label="Description"
                    before={before.descriptionText}
                    after={line.descriptionText}
                  />
                )}
                {before.estimateLabel !== line.estimateLabel && (
                  <BeforeAfter
                    label="Estimate"
                    before={before.estimateLabel}
                    after={line.estimateLabel}
                    inline
                  />
                )}
                {line.loggedLabel !== null && (
                  <p className="text-muted-foreground text-xs">{line.loggedLabel}</p>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
