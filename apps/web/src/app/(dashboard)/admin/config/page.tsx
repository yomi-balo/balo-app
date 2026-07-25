import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { log } from '@/lib/logging';
import { getCurrentUser } from '@/lib/auth/session';
import { isPlatformAdmin } from '@/lib/auth/is-admin';
import {
  loadPlatformConfigAdmin,
  type PlatformConfigAdminDTO,
} from '@/lib/platform-config/platform-config-admin';
import { PlatformConfigForm } from './_components/platform-config-form';

/**
 * Admin platform-config surface (BAL-398). Server Component:
 *  1. `getCurrentUser()` — null → `/login` (the unauthenticated edge; the (dashboard)
 *     layout + `/admin` middleware already gate onboarding + the admin role).
 *  2. non-admin → `notFound()` — an admin-only surface that must not leak its existence
 *     to a client/expert (a 404 is indistinguishable from "no route"); also protects the
 *     Server Action surface as a page-level backstop.
 *  3. load the DTO inside a try/catch that `log.error`s then re-throws to `error.tsx`.
 *  4. render the form (which owns the one config card + Sonner toast on save).
 *
 * Mirrors `promo-codes/page.tsx` exactly.
 */

export const metadata: Metadata = {
  title: 'Platform config — Balo',
  robots: { index: false, follow: false },
};

export default async function PlatformConfigPage(): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }
  if (!isPlatformAdmin(user)) {
    notFound();
  }

  let dto: PlatformConfigAdminDTO;
  try {
    dto = await loadPlatformConfigAdmin();
  } catch (error) {
    log.error('Failed to load platform config', {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error; // let error.tsx render the boundary
  }

  return <PlatformConfigForm dto={dto} />;
}
