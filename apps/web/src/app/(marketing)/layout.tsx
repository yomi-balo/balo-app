import { getCurrentUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { toMarketingViewer, type MarketingViewer } from '@/components/marketing/marketing-viewer';
import { MarketingHeader } from '@/components/marketing/marketing-header';
import { analyticsIdentifyPropsFor, type AnalyticsIdentifyProps } from '@/lib/auth/impersonation';
import { AnalyticsIdentify } from '@/components/providers/analytics-identify';

/**
 * ⚠⚠ THIS LAYOUT READS THE SESSION ON THE SERVER, DELIBERATELY. (BAL-502 / ADR-1053)
 *
 * BAL-502's ticket asked for a client-only session probe so `(marketing)` could stay
 * static/ISR. That premise did not hold on this codebase when written, so the root layout
 * (`app/layout.tsx`, guarded by `invariants/static-shell-never-reads-session.test.ts`) never
 * reads the session, but this layout's OWN read stays: it still serves signed-in `/`,
 * `/experts` and `/experts/[username]` (which reads the session itself, `page.tsx:99`) and
 * `/v2`, all of which need the real viewer. An ANONYMOUS `/` never reaches this layout — the
 * middleware rewrite hands it to `(marketing-anon)/anon/page.tsx` instead, which is genuinely
 * static/ISR and imports no session.
 *
 * Consequences that are correct BECAUSE this read is server-side:
 *   • No layout shift — the right variant is in the first byte of HTML, not swapped in
 *     after hydration. CLS is satisfied by CONSTRUCTION, not by reserved space.
 *   • `NotificationBell` (which polls `/api/notifications` every 30s and 401s without a
 *     session, `notification-bell.tsx:26,52-56`) can never mount for an anonymous visitor.
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
  let identifyProps: AnalyticsIdentifyProps = {};
  try {
    const user = await getCurrentUser();
    viewer = toMarketingViewer(user);
    identifyProps = analyticsIdentifyPropsFor(user);
  } catch (error) {
    log.warn('Marketing layout session read failed; rendering the signed-out header', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return (
    <>
      <MarketingHeader viewer={viewer} />
      <AnalyticsIdentify {...identifyProps} />
      {children}
    </>
  );
}
