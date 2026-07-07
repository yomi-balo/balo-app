import { MessageSquare } from 'lucide-react';

import type { ChangeRequestBannerView } from '@/lib/engagement/engagement-view';

interface ChangeRequestBannerProps {
  banner: ChangeRequestBannerView;
}

/**
 * "Client requested changes" banner, pinned on an `active` engagement whose last
 * review loop was declined. The view mapper returns `changeRequestBanner === null`
 * for the client lens (the client already knows), so the composer never mounts
 * this for that lens. Expert/admin see the attribution + note; the expert lens
 * also carries a trailing nudge. READ-ONLY.
 */
export function ChangeRequestBanner({
  banner,
}: Readonly<ChangeRequestBannerProps>): React.JSX.Element {
  return (
    <div className="border-warning/20 bg-warning/10 flex items-start gap-2.5 rounded-xl border px-4 py-3">
      <MessageSquare className="text-warning mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="text-foreground text-xs leading-relaxed">
        <strong className="text-warning font-semibold">
          {banner.attribution} requested changes before accepting:
        </strong>{' '}
        {banner.note}
        {banner.expertNudge !== null && (
          <span className="text-muted-foreground"> {banner.expertNudge}</span>
        )}
      </p>
    </div>
  );
}
