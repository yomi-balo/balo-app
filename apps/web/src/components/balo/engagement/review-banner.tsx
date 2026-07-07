import { Clock } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import type { ReviewBannerView } from '@/lib/engagement/engagement-view';

interface ReviewBannerProps {
  banner: ReviewBannerView;
}

/**
 * `pending_acceptance` state banner. Renders the per-lens completion-review copy
 * (pre-derived on the view) plus an INFORMATIONAL auto-accept countdown pill.
 * READ-ONLY: no accept / request-changes / withdraw affordances (D4/D7).
 */
export function ReviewBanner({ banner }: Readonly<ReviewBannerProps>): React.JSX.Element {
  return (
    <div className="border-warning/20 bg-warning/10 flex items-start gap-3 rounded-2xl border px-5 py-4">
      <div className="bg-warning flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]">
        <Clock className="h-4 w-4 text-white" aria-hidden="true" />
      </div>
      <div className="flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-foreground min-w-[180px] flex-1 text-sm font-semibold">
            {banner.title}
          </p>
          {banner.countdown !== null && (
            <Badge className="border-warning/20 bg-card text-warning">
              <Clock className="h-3 w-3" aria-hidden="true" />
              Auto-accepts in {banner.countdown.autoInLabel}
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">{banner.body}</p>
      </div>
    </div>
  );
}
