import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { AdminSectionNav } from './_components/admin-section-nav';

/**
 * BAL-534 / ADR-1053 Amendment 1 — the `/admin/*` shell gate. Admin lives INSIDE the member
 * `(dashboard)` shell (D6 "Option B cheap"), so this layout exists purely to gate the whole
 * subtree once instead of per page.
 *
 * BAL-548 (folded from the BAL-534 / PR #285 review, item 1) — it now renders chrome: the
 * `AdminSectionNav` chip sub-nav above `{children}`. BAL-534's pre-flight deferred this because
 * one admin page would have shipped a one-chip tab bar; with Home and Config & catalogue as
 * siblings it earns its place. The old "adds NO chrome today" claim is deliberately removed
 * from this docblock — it is no longer true, and leaving it would mislead the next reader.
 *
 * `getCurrentUser()` + an explicit `redirect('/login')` — matching `settings/layout.tsx` and
 * `settings/team/page.tsx`, and NOT `requireUser()`: that also throws on incomplete onboarding,
 * which middleware already redirects for on page navigations (workos-auth skill). Throwing here
 * would surface an error boundary instead of the onboarding wizard.
 *
 * ⚠ THE CAPABILITY, NOT `isPlatformAdmin`. `/promo-codes` and `/engagements` still gate on the
 * `isPlatformAdmin` ROLE SET — that is out of scope here and deliberately untouched — but every
 * NEW admin surface gates on the ADR-1029 capability axis, exactly as the promo-code Server
 * Actions already do (`create-promo-code.ts:37`).
 *
 * ⚠ LAYERED, NOT REDUNDANT. Middleware bounces a non-staff viewer to `/dashboard` before this
 * ever runs; this is the second line, and each page under it carries a third.
 *
 * ⚠ A `notFound()` THROWN HERE RENDERS NEXT'S BUILT-IN 404, not `./not-found.tsx`: a segment's
 * `not-found` boundary wraps that segment's CHILDREN, and this layout sits outside it
 * (`create-component-tree.js:289,394`). `(dashboard)` has no group-level boundary. That is a
 * real 404 with no existence leak — a non-staff viewer cannot distinguish "no route" from
 * "not for you" — which is the property that matters. Do not "fix" it by adding a
 * `(dashboard)/not-found.tsx`; that changes the 404 UI for every dashboard route. Adding
 * `AdminSectionNav` chrome below does not move this boundary — the gate above still runs, and
 * still throws, before the nav (or `{children}`) ever renders.
 */
export default async function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)) {
    notFound();
  }

  return (
    <div className="flex flex-col gap-6">
      <AdminSectionNav />
      {children}
    </div>
  );
}
