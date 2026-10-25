import { Check, MessageSquare } from 'lucide-react';

import type { ChangeRequestBannerView } from '@/lib/engagement/engagement-view';
import { MarkReadyAgainButton } from './mark-ready-again-button';

interface ChangeRequestBannerProps {
  banner: ChangeRequestBannerView;
  engagementId: string;
  clientCompanyName: string;
}

/**
 * The open change request, as a banner on an `active` project (no dismiss: it clears
 * when the project is sent back). A labelled region, not a live region: it is page-load
 * state, and the `changes_made` variant holds a button. Three variants, all pre-derived on the view:
 *  - `work_outstanding` (expert / admin) — amber; who asked, the quote, and what is left.
 *  - `client_waiting` (client) — amber; the client's own acknowledgement.
 *  - `changes_made` (expert) — violet; every tagged milestone is done again, so the banner
 *    carries the one "Mark project ready again" control.
 */
export function ChangeRequestBanner({
  banner,
  engagementId,
  clientCompanyName,
}: Readonly<ChangeRequestBannerProps>): React.JSX.Element {
  if (banner.variant === 'changes_made') {
    return (
      <section
        aria-label="Change request"
        className="border-violet/25 bg-violet/10 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border px-4 py-4"
      >
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="bg-violet flex size-6 shrink-0 items-center justify-center rounded-full text-white">
            <Check className="size-3.5" strokeWidth={3} aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="text-foreground text-sm font-semibold">{banner.headline}</p>
            <p className="text-muted-foreground mt-1 text-sm leading-relaxed">{banner.reminder}</p>
          </div>
        </div>
        <MarkReadyAgainButton
          engagementId={engagementId}
          ctaLabel={banner.ctaLabel}
          modalBody={banner.modalBody}
          clientCompanyName={clientCompanyName}
        />
      </section>
    );
  }

  return (
    <section
      aria-label="Change request"
      className="border-warning/20 bg-warning/10 flex items-start gap-2.5 rounded-xl border px-4 py-3"
    >
      <MessageSquare className="text-warning mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {banner.variant === 'client_waiting' ? (
        <p className="text-foreground text-sm leading-relaxed">{banner.body}</p>
      ) : (
        <div className="text-foreground min-w-0 space-y-1.5 text-sm leading-relaxed">
          <p className="font-semibold">{banner.headline}</p>
          <p className="text-muted-foreground">“{banner.quote}”</p>
          {banner.guidance !== null && <p>{banner.guidance}</p>}
        </div>
      )}
    </section>
  );
}
