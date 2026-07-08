import { Flag } from 'lucide-react';

import { Card } from '@/components/ui/card';
import type { MilestoneNodeView } from '@/lib/engagement/engagement-view';
import { MilestoneRow } from './milestone-row';

interface MilestoneRailProps {
  milestones: MilestoneNodeView[];
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
 * component (`ExpertMilestoneRail`). Caller guards on `hasMilestones`.
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
