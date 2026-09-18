import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { buildNavContext } from '@/lib/navigation/nav-context';
import { resolveEntityListNavEntry } from '@/components/layout/nav-registry';
import { CASES_INDEX_FALLBACK_TITLE } from './_lib/cases-index-copy';
import { loadCasesIndex, resolveCasesIndexRequest } from './_lib/load-cases-index';
import { readCasesIndexData } from './_lib/read-cases-index-data';
import { CasesIndexShell } from './_components/cases-index-shell';

/**
 * BAL-567 — `/cases`, the workspace's case index. A Server Component:
 *
 *  1. `getCurrentUser()` — `null` → `/login` (the `(dashboard)` layout already gates onboarding
 *     and drift; this guards only the unauthenticated edge).
 *  2. `resolveCasesIndexRequest` — WHICH list, from the sealed session. `null` means an
 *     expert-workspace session with no `expertProfileId`, which redirects to `/dashboard`
 *     exactly as `expert/calendar/page.tsx` does for the same state.
 *  3. `loadCasesIndex` — the capability gate, then the batched reads, inside the ONE catch
 *     boundary that turns a read failure into a user-facing state.
 *  4. render the client island.
 *
 * ⚠⚠ THERE IS NO `<h1>` HERE. BAL-499 shipped THE ONE `<h1>` in the top bar and `nav-registry`
 * resolves `/cases` to it, so the page's own heading is an `<h2>` (decisions D3 — a deliberate
 * deviation from the design reference's `PageHead`). The TITLE is read from the live nav entry
 * rather than typed as a literal, so the crumb and the heading can never disagree.
 *
 * ⚠ `/consultations` PERMANENTLY REDIRECTS HERE (`next.config.js`). Until this route existed that
 * redirect dead-ended; shipping this page is what completes it.
 */

export const metadata: Metadata = {
  title: 'Cases — Balo',
  robots: { index: false, follow: false },
};

export default async function CasesPage(): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  const request = resolveCasesIndexRequest(user);
  if (request === null) {
    // ⚠ `/dashboard`, NOT `/login` — the session IS valid; it simply has no expert profile to
    // list deliveries for. Unified with `expert/calendar/page.tsx` so two surfaces cannot send
    // the same session to two different destinations.
    redirect('/dashboard');
  }

  const navContext = await buildNavContext(user);
  const navEntry = resolveEntityListNavEntry(navContext, 'cases');

  const data = await readCasesIndexData(
    () => loadCasesIndex({ viewerUserId: user.id, request }),
    // IDS AND LABELS ONLY — never a case title or anything a customer wrote. `requestId` and
    // `userId` are attached automatically by the AsyncLocalStorage mixin.
    request.side === 'company'
      ? { workspaceType: request.side, companyId: request.companyId }
      : { workspaceType: request.side, expertProfileId: request.expertProfileId }
  );

  return <CasesIndexShell data={data} title={navEntry?.label ?? CASES_INDEX_FALLBACK_TITLE} />;
}
