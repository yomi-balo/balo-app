import { MarketingHeader } from '@/components/marketing/marketing-header';

/**
 * BAL-504 Phase 3 — the static, session-free anonymous home's layout. Renders the SAME
 * `MarketingHeader` as `(marketing)/layout.tsx`, but with a hardcoded `viewer={null}` and no
 * `<AnalyticsIdentify>` — this group can never legitimately serve a signed-in visitor (the
 * middleware rewrite only fires when a session cookie is absent), so there is nothing to
 * identify and nothing to derive. It imports no session, no `next/headers`, and no
 * `@/lib/auth/impersonation` — enforced by the invariant this file is scanned in
 * (`invariants/static-shell-never-reads-session.test.ts`).
 */
export default function MarketingAnonLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <>
      <MarketingHeader viewer={null} />
      {children}
    </>
  );
}
