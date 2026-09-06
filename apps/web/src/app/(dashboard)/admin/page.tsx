import { redirect } from 'next/navigation';

/**
 * BAL-534 — `/admin` has no home of its own yet (the pending-actions queue is BAL-548), so it
 * unconditionally redirects to the one real admin surface this ticket ships.
 *
 * No session read, matching `settings/page.tsx`: this page renders nothing, so there is nothing
 * to protect here. Reachability is already gated twice above it — `middleware.ts`'s
 * `isAdminRoute` prefix (which matches the bare `/admin`) and `admin/layout.tsx` — and the
 * destination carries its own gate. A third read would cost an iron-session unseal to protect
 * a `redirect()`.
 */
export default function AdminPage(): never {
  redirect('/admin/catalogue');
}
