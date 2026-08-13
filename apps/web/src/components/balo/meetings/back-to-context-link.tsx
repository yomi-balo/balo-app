'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useMeetingRoute } from '@/lib/meetings/meeting-route-context';

/**
 * BAL-435 — the quiet "Back to {context}" escape.
 *
 * ⚠ RENDERED IN EXACTLY FOUR PLACES: PreJoin, the not-provisioned card, the fatal-error card, and
 * the More menu's last item. **NEVER IN THE TOP BAR** — a live call needs no escape hatch
 * competing with Leave. (PreJoin is the addition: it suppresses the top bar, the toolbar and the
 * More menu, so without a link there somebody who opened the call and decided not to join had NO
 * affordance on the page at all.)
 *
 * ⚠⚠ **ABSENT ENTIRELY FOR AN ANONYMOUS GUEST, AND STRUCTURALLY SO.** Only the member route
 * mounts `MeetingRouteContextProvider`, so `backTo === null` IS "this viewer is a guest" — no
 * lens check, no role read. A guest has no Balo dashboard, and offering them "Back to your
 * dashboard" mid-call threw them at a login wall and lost them the meeting. The `/dashboard`
 * fallback constant is still live where it belongs: on the member route's own pre-call cards,
 * and for a member whose context did not resolve (`resolveBackTo(null)`).
 */
export function BackToContextLink(): React.JSX.Element | null {
  const { backTo } = useMeetingRoute();
  if (backTo === null) return null;
  // ⚠ NEVER A DEAD LINK. Every href here comes from `back-to-context.ts`'s single table, which
  // points `case` at `/consultations` until BAL-421 ships `/cases/[caseId]`.
  const { label, href } = backTo;

  return (
    <Link
      href={href}
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring mt-5 inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-[13px] font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      {label}
    </Link>
  );
}
