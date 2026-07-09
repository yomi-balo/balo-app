import Link from 'next/link';
import { Check, DollarSign, MessageSquare, Plus } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { CompletedBannerView } from '@/lib/engagement/engagement-view';
import { AcceptCelebration } from './accept-celebration';

interface CompletedBannerProps {
  banner: CompletedBannerView;
  engagementId: string;
}

/**
 * Terminal `completed` banner. Per-lens title + body (client-accepted vs auto-accepted
 * attribution) are pre-derived on the view. The CLIENT lens gets the next-step CTA row
 * (start a new project · message the expert) and a transition-only confetti overlay
 * (fires once, on the in-session accept — {@link AcceptCelebration}); the ADMIN lens
 * gets the "Ready to invoice" money flag. `relative overflow-hidden` clips the confetti
 * to the banner.
 */
export function CompletedBanner({
  banner,
  engagementId,
}: Readonly<CompletedBannerProps>): React.JSX.Element {
  return (
    <div className="border-success/20 bg-success/10 relative flex items-start gap-3 overflow-hidden rounded-2xl border px-5 py-4">
      {banner.clientCta !== null && <AcceptCelebration engagementId={engagementId} />}
      <div className="bg-success flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]">
        <Check className="h-4 w-4 text-white" aria-hidden="true" />
      </div>
      <div className="flex-1">
        <p className="text-foreground text-sm font-semibold">{banner.title}</p>
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{banner.body}</p>

        {banner.clientCta !== null && (
          // v1 ships only affordances whose destinations already exist. The v2
          // marketplace hooks (review-request CTA, then a rehire-{expert} shortcut —
          // BAL-329 flywheel) slot into THIS same row.
          <div className="mt-3 flex flex-wrap gap-2">
            <Button asChild size="sm">
              <Link href={banner.clientCta.nextProjectHref}>
                <Plus className="size-3.5" aria-hidden />
                Start your next project
              </Link>
            </Button>
            {banner.clientCta.messageHref !== null && (
              <Button asChild variant="ghost" size="sm">
                <Link href={banner.clientCta.messageHref}>
                  <MessageSquare className="size-3.5" aria-hidden />
                  Message {banner.clientCta.messagePersonLabel}
                </Link>
              </Button>
            )}
          </div>
        )}

        {banner.readyToInvoice && (
          <div className="mt-2.5">
            <Badge className="border-warning/20 bg-warning/10 text-warning">
              <DollarSign className="h-3 w-3" aria-hidden="true" />
              Ready to invoice: final installment
            </Badge>
          </div>
        )}
      </div>
    </div>
  );
}
