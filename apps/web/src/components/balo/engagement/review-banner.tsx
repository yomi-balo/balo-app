import { Clock, Eye } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import type { ReviewBannerView } from '@/lib/engagement/engagement-view';
import type { EngagementLens } from '@/lib/engagement/resolve-engagement-lens';
import { ReviewBannerActions, type ReviewInitialAction } from './review-banner-actions';

interface ReviewBannerProps {
  banner: ReviewBannerView;
  lens: EngagementLens;
  engagementId: string;
  clientCompanyName: string;
  /** Email deep-link intent — auto-opens the matching client modal once. */
  initialAction: ReviewInitialAction | null;
}

/**
 * `pending_acceptance` state banner. Renders the per-lens completion-review copy
 * (pre-derived on the view), the client's previous change request when there was one, an
 * INFORMATIONAL auto-accept countdown pill and the
 * per-lens {@link ReviewBannerActions} (D4: expert "Withdraw request"; D7: the client
 * accept / request-changes decision).
 */
export function ReviewBanner({
  banner,
  lens,
  engagementId,
  clientCompanyName,
  initialAction,
}: Readonly<ReviewBannerProps>): React.JSX.Element {
  return (
    <div className="border-violet/25 bg-violet/10 flex items-start gap-3 rounded-2xl border px-5 py-4">
      <div className="bg-violet flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]">
        <Eye className="h-4 w-4 text-white" aria-hidden="true" />
      </div>
      <div className="flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-foreground min-w-[180px] flex-1 text-sm font-semibold">
            {banner.title}
          </p>
          {banner.countdown !== null && (
            <Badge className="border-violet/25 bg-card text-foreground">
              <Clock className="h-3 w-3" aria-hidden="true" />
              {banner.countdown.autoInLabel}
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">{banner.body}</p>
        {banner.lastRequest !== null && (
          <blockquote className="border-warning/40 bg-card mt-3 rounded-lg border-l-2 px-3 py-2">
            <p className="text-muted-foreground text-xs font-medium">
              {banner.lastRequest.heading}
            </p>
            <p className="text-foreground mt-0.5 text-sm leading-relaxed">
              {banner.lastRequest.note}
            </p>
          </blockquote>
        )}
        <ReviewBannerActions
          lens={lens}
          engagementId={engagementId}
          clientCompanyName={clientCompanyName}
          clientDecision={banner.clientDecision}
          initialAction={initialAction}
        />
      </div>
    </div>
  );
}
