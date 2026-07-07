import { Check, DollarSign } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import type { CompletedBannerView } from '@/lib/engagement/engagement-view';

interface CompletedBannerProps {
  banner: CompletedBannerView;
}

/**
 * Terminal `completed` banner. Per-lens title + body (with client-accepted vs
 * auto-accepted acceptance attribution) are pre-derived on the view. The admin
 * lens additionally surfaces a "Ready to invoice" flag. READ-ONLY: no confetti,
 * no client next-step CTA row (deferred — see plan §10).
 */
export function CompletedBanner({ banner }: Readonly<CompletedBannerProps>): React.JSX.Element {
  return (
    <div className="border-success/20 bg-success/10 flex items-start gap-3 rounded-2xl border px-5 py-4">
      <div className="bg-success flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]">
        <Check className="h-4 w-4 text-white" aria-hidden="true" />
      </div>
      <div className="flex-1">
        <p className="text-foreground text-sm font-semibold">{banner.title}</p>
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{banner.body}</p>
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
