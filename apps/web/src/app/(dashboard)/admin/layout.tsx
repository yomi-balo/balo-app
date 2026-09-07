import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';

/**
 * BAL-534 / ADR-1053 Amendment 1 — the `/admin/*` shell gate. Admin lives INSIDE the member
 * `(dashboard)` shell (D6 "Option B cheap"), so this layout adds NO chrome: it exists purely to
 * gate the whole subtree once instead of per page.
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
 * `(dashboard)/not-found.tsx`; that changes the 404 UI for every dashboard route.
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

  return <>{children}</>;
}
