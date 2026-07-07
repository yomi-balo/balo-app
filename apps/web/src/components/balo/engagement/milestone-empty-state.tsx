import { Flag } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Card } from '@/components/ui/card';
import type { EmptyStateView, ViewIcon } from '@/lib/engagement/engagement-view';

interface MilestoneEmptyStateProps {
  emptyState: EmptyStateView;
}

/** The empty state only ever carries `Flag`; map name → component defensively. */
const ICONS: Record<Extract<ViewIcon, 'Flag'>, LucideIcon> = {
  Flag,
};

/**
 * Zero-milestone empty state. Copy is pre-derived per lens on the view and is
 * framed as an invitation (never "no milestones"). READ-ONLY: no add-milestone
 * CTA (D3).
 */
export function MilestoneEmptyState({
  emptyState,
}: Readonly<MilestoneEmptyStateProps>): React.JSX.Element {
  const Icon = emptyState.icon === 'Flag' ? ICONS.Flag : Flag;
  return (
    <Card className="border-border bg-card px-8 py-12 text-center">
      <div className="bg-primary/10 text-primary mx-auto mb-4 flex h-[54px] w-[54px] items-center justify-center rounded-[15px]">
        <Icon className="h-6 w-6" aria-hidden="true" />
      </div>
      <h2 className="text-foreground text-lg font-semibold">{emptyState.title}</h2>
      <p className="text-muted-foreground mx-auto mt-2 max-w-[420px] text-sm leading-relaxed">
        {emptyState.body}
      </p>
    </Card>
  );
}
