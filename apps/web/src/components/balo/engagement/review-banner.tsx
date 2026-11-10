import { Eye } from 'lucide-react';

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
 * (pre-derived on the view, with the auto-accept date stated in the body), the client's
 * previous change request when there was one, and the per-lens {@link ReviewBannerActions} (D4: expert "Withdraw request"; D7: the client
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
        <p className="text-foreground text-sm font-semibold">{banner.title}</p>
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
        {banner.changedSinceProposal !== null && (
          <div className="border-border bg-card mt-3 rounded-lg border px-3 py-2">
            <p className="text-foreground text-xs font-medium">
              {banner.changedSinceProposal.heading}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
              {banner.changedSinceProposal.intro}
            </p>
            <ul className="text-foreground mt-1.5 space-y-0.5 text-sm">
              {banner.changedSinceProposal.items.map((item) => (
                <li key={item.milestoneId}>
                  {item.milestoneTitle} — {item.fieldsLabel}
                </li>
              ))}
            </ul>
          </div>
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
