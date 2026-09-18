import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { log } from '@/lib/logging';
import { loadStaffAccess, type StaffAccessPageDTO } from './_lib/load-staff-access';
import { StaffAccessWorkspace } from './_components/staff-access-workspace';
import { StaffAccessNoAccess } from './_components/staff-access-states';

/**
 * BAL-561 — Staff access: assign platform roles and per-user capability overrides. Server
 * Component, mirroring `admin/applications/page.tsx`:
 *  1. `getCurrentUser()` — null → `/login` (matching `admin/layout.tsx`, NOT `requireUser()`,
 *     which also throws on incomplete onboarding).
 *  2. non-staff → `notFound()` — repeated from `admin/layout.tsx` deliberately (defence in depth,
 *     the same D3 precedent every other `/admin/*` page follows).
 *  3. `person` comes from the URL — a Promise in Next 16.
 *  4. load through `loadStaffAccess` inside a try/catch that `log.error`s then re-throws to
 *     `error.tsx`.
 *  5. **D5** — the page resolves `VIEW_PLATFORM_ADMIN` (reachability); the loader separately
 *     resolves `MANAGE_STAFF_CAPABILITIES` and returns `{ ok: false }` for a staff member who can
 *     open `/admin` but cannot manage staff. That renders the no-access state here, not a 404.
 */

export const metadata: Metadata = {
  title: 'Staff access — Balo',
  robots: { index: false, follow: false },
};

interface StaffAccessPageProps {
  readonly searchParams: Promise<{ person?: string }>;
}

export default async function StaffAccessPage({
  searchParams,
}: Readonly<StaffAccessPageProps>): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)) {
    notFound();
  }

  const { person } = await searchParams;

  let dto: StaffAccessPageDTO;
  try {
    dto = await loadStaffAccess(user);
  } catch (error) {
    log.error('Staff access roster failed', {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error; // let error.tsx render the boundary
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-1">
        {/* The shell's Breadcrumbs already renders THE ONE <h1> for this route (BAL-499 F5
            convention) — this in-page heading is demoted to <h2>. */}
        <h2 className="text-foreground text-2xl font-semibold">Staff access</h2>
        <p className="text-muted-foreground max-w-2xl text-sm">
          {/* pending-MJ */}
          Who can open the Balo admin area, and what they can do once they are in. Every change here
          is recorded against the person who made it.
        </p>
      </div>
      {dto.ok ? (
        <StaffAccessWorkspace
          people={dto.people}
          viewerId={user.id}
          initialPersonId={person ?? null}
        />
      ) : (
        <StaffAccessNoAccess />
      )}
    </div>
  );
}
