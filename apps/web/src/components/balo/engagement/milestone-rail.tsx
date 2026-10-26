import { Flag } from 'lucide-react';

import { Card } from '@/components/ui/card';
import type { MilestoneNodeView } from '@/lib/engagement/engagement-view';
import type { WorkspaceTimeView } from '@/lib/engagement/time-view';
import { MilestoneRow } from './milestone-row';
import { TimeTotals } from './time/time-totals';

interface MilestoneRailProps {
  milestones: MilestoneNodeView[];
  /** Time-and-materials only: per-milestone hours and the project totals. */
  time?: WorkspaceTimeView | null;
}

/**
 * The delivery plan — a vertical milestone rail. Each node reflects its status
 * (pending: bordered circle, in_progress: breathing primary ring, completed:
 * gradient circle + check), with the connector below a completed node filled by
 * the signature blue→violet gradient. Read-only: descriptions are injected from the
 * already-server-sanitised HTML, acceptance criteria under "Done when:", timing
 * labels, and the success-tinted "Delivered:" completion note. NO action buttons —
 * this component stays a SERVER, read-only component for the client/admin lenses and
 * every non-active expert state; the interactive expert rail is a separate client
 * component (`ExpertMilestoneRail`). On a time-and-materials project each row carries its hours
 * and a time log, with the project totals below. Caller guards on `hasMilestones`.
 */
export function MilestoneRail({
  milestones,
  time = null,
}: Readonly<MilestoneRailProps>): React.JSX.Element {
  return (
    <Card className="border-border bg-card p-6">
      <div className="text-muted-foreground flex items-center gap-2 text-xs font-semibold tracking-wide uppercase">
        <Flag className="size-3.5" aria-hidden />
        Delivery plan
      </div>
      <div className="mt-4">
        {milestones.map((node, index) => (
          <MilestoneRow
            key={node.id}
            node={node}
            isLast={index === milestones.length - 1}
            time={time?.byMilestoneId[node.id]}
          />
        ))}
      </div>
      {time !== null && <TimeTotals totals={time.totals} />}
    </Card>
  );
}
