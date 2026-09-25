'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useMeetingRoute } from '@/lib/meetings/meeting-route-context';

/**
 * BAL-435 — the quiet "Back to {context}" escape.
 *
 * ⚠ RENDERED IN EXACTLY THREE PLACES: the fatal-error card (`meeting-frame-impl.tsx`), PreJoin,
 * and the More menu's last item. **NEVER IN THE TOP BAR** — a live call needs no escape hatch
 * competing with Leave. (PreJoin is the addition: it suppresses the top bar, the toolbar and the
 * More menu, so without a link there somebody who opened the call and decided not to join had NO
 * affordance on the page at all.)
 *
 * ⚠⚠ **ABSENT FOR AN ANONYMOUS GUEST, BUT NOT BECAUSE ONLY THE MEMBER ROUTE MOUNTS THE
 * PROVIDER.** All three routes mount `MeetingRouteContextProvider` now (BAL-445) — the guest
 * mounts (`join-control.tsx`, `lobby-client.tsx`) pass `backTo={null}` explicitly, which is what
 * hides this link for a guest. A member whose context did not resolve gets `DASHBOARD_BACK_TO`
 * (`resolveBackTo(null)`), so the link still renders for them, pointed at the dashboard. A guest
 * has no Balo dashboard, and offering them "Back to your dashboard" mid-call threw them at a
 * login wall and lost them the meeting. The `/dashboard` fallback constant is still live where it
 * belongs: on the member route's own pre-call cards.
 */
export function BackToContextLink(): React.JSX.Element | null {
  const { backTo } = useMeetingRoute();
  if (backTo === null) return null;
  // ⚠ NEVER A DEAD LINK. Every href here comes from `resolveBackTo`, which as of BAL-567 (R6)
  // delegates to `hrefForMeeting` — the ONE context→href table — and falls back to
  // `DASHBOARD_BACK_TO` whenever that answers `null`. A context with no reachable page therefore
  // arrives here as the dashboard, never as a route that 404s.
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
