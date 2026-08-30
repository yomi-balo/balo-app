import { getCurrentUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { toMarketingViewer, type MarketingViewer } from '@/components/marketing/marketing-viewer';
import { MarketingHeader } from '@/components/marketing/marketing-header';

/**
 * ⚠⚠ THIS LAYOUT READS THE SESSION ON THE SERVER, DELIBERATELY. (BAL-502 / ADR-1053)
 *
 * BAL-502's ticket asked for a client-only session probe so `(marketing)` could stay
 * static/ISR. That premise does not hold on this codebase and the ticket was amended.
 * Every one of `apps/web`'s routes is already `ƒ (Dynamic)`: the ROOT layout awaits
 * `getCurrentUser()` (`app/layout.tsx:29-34` → `cookies()`), which de-statics the whole
 * app; `/experts` additionally awaits `searchParams`; `/experts/[username]` additionally
 * calls `getCurrentUser()` itself (`page.tsx:99`). Nothing scoped to this route group can
 * undo a root-layout cookie read, so a client hook would have bought ZERO rendering
 * benefit while costing a net-new `/api/me` endpoint, a hydration flicker and CLS.
 *
 * Consequences that are correct BECAUSE this read is server-side:
 *   • No layout shift — the right variant is in the first byte of HTML, not swapped in
 *     after hydration. CLS is satisfied by CONSTRUCTION, not by reserved space.
 *   • `NotificationBell` (which polls `/api/notifications` every 30s and 401s without a
 *     session, `notification-bell.tsx:26,52-56`) can never mount for an anonymous visitor.
 *
 * ⚠ IF THE ROOT LAYOUT IS EVER FIXED (BAL-504 — "Root layout reads the session
 * unconditionally — every route in the app is dynamic") so `(marketing)` can genuinely be
 * static/ISR, THIS READ BECOMES THE NEXT BLOCKER and must be revisited in the same change —
 * along with `/experts`' `searchParams` await and `/experts/[username]`'s own
 * `getCurrentUser()`. Fixing one without the others achieves nothing.
 *
 * The read FAILS OPEN to the signed-out header. This is chrome, never an authorization
 * decision — every protected surface is gated by middleware and by `withAuth`/`requireUser`.
 */
export default async function MarketingLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): Promise<React.JSX.Element> {
  // BAL-502 FIX round — `toMarketingViewer` moved INSIDE the try. This layout advertises
  // "fails open" to the signed-out header on ANY session-read problem; the projection itself
  // isn't currently exploitable to throw (`toMarketingViewer` only touches `SessionUser` fields
  // that are `notNull` in the schema — `packages/db/src/schema/users.ts:14`), but the fail-open
  // contract should cover the whole derivation, not just the cookie read, so a future change to
  // the projection can't silently reintroduce an uncaught throw here.
  let viewer: MarketingViewer | null = null;
  try {
    const user = await getCurrentUser();
    viewer = toMarketingViewer(user);
  } catch (error) {
    log.warn('Marketing layout session read failed; rendering the signed-out header', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return (
    <>
      <MarketingHeader viewer={viewer} />
      {children}
    </>
  );
}
