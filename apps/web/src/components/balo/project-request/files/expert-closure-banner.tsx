'use client';

import type { RequestTrackClosedReason } from '@/lib/request-files/load-request-files';

/**
 * The expert's own closure banner (BAL-431 / Ruling 2) — the MIRROR of the client lens's
 * decline/not-selected annotation pair (`request-file-audience-badges.tsx`'s `annotationText`).
 *
 * ⚠ WHY THIS IS ITS OWN COMPONENT. The file-plane predicate collapses declined ∨ withdrawn ∨
 * not-selected into one `closedAt`, and a boolean carried that collapse all the way to the
 * banner — which then told a NOT-SELECTED expert they had declined. Per OSD-3 a genuinely
 * declined expert cannot load this page at all, so the not-selected wording is in fact the only
 * one that ever renders; both are written out so the pair stays symmetric if that changes.
 *
 * ONE flat lookup, never a nested ternary (SonarCloud S3358) — two reasons, two strings. Copy is
 * gender-neutral and non-adversarial: it leads with what the expert KEEPS, not with what they
 * lost.
 */
const CLOSURE_COPY: Record<RequestTrackClosedReason, string> = {
  declined:
    'You declined this invitation. Files shared with you before then stay available. New files are not shared with you.',
  not_selected:
    'This project went to another expert. Files shared with you before then stay available. New files are not shared with you.',
};

interface ExpertClosureBannerProps {
  reason: RequestTrackClosedReason;
}

export function ExpertClosureBanner({
  reason,
}: Readonly<ExpertClosureBannerProps>): React.JSX.Element {
  return (
    <div className="border-b border-amber-100 bg-amber-50 px-4 py-2.5 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
      {CLOSURE_COPY[reason]}
    </div>
  );
}
