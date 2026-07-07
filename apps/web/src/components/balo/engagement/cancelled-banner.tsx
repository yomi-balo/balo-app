import { Ban } from 'lucide-react';

import type { CancelledBannerView } from '@/lib/engagement/engagement-view';

interface CancelledBannerProps {
  banner: CancelledBannerView;
}

/**
 * Terminal `cancelled` banner. Title + body ("Cancelled by Balo on {date}.") are
 * pre-derived on the view; the optional reason renders as an italic quote.
 * READ-ONLY.
 */
export function CancelledBanner({ banner }: Readonly<CancelledBannerProps>): React.JSX.Element {
  return (
    <div className="border-destructive/20 bg-destructive/10 flex items-start gap-3 rounded-2xl border px-5 py-4">
      <div className="bg-destructive flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]">
        <Ban className="h-4 w-4 text-white" aria-hidden="true" />
      </div>
      <div>
        <p className="text-foreground text-sm font-semibold">{banner.title}</p>
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{banner.body}</p>
        {banner.reason !== null && (
          <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed italic">
            &ldquo;{banner.reason}&rdquo;
          </p>
        )}
      </div>
    </div>
  );
}
