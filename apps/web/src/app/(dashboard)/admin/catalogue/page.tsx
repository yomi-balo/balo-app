import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { ADMIN_CATALOGUE_ROWS, resolveCatalogueRows } from './_lib/admin-catalogue';
import { CatalogueList } from './_components/catalogue-list';

/**
 * BAL-534 — Config & catalogue: the admin surfaces that exist, and the ones that do not yet.
 * Server Component, ZERO I/O — the rows are a code-owned constant, so there is nothing to fail
 * and nothing to log. `error.tsx` / `loading.tsx` ship as route-segment conventions.
 *
 * The capability gate is repeated from `admin/layout.tsx` DELIBERATELY (defence in depth, D3):
 * a layout is not a hard auth boundary on its own, and this page must stand up if it is ever
 * rendered outside it.
 */
export const metadata: Metadata = {
  title: 'Config & catalogue — Balo',
  robots: { index: false, follow: false },
};

export default async function AdminCataloguePage(): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)) {
    notFound();
  }

  // The resolver needs a SET, but `hasPlatformCapability` stays the ONE interpreter of a
  // platform role (ADR-1035) — so derive the set through it rather than indexing
  // `PLATFORM_ROLE_CAPABILITIES` here and forking the interpretation.
  const heldCapabilities = Object.values(PLATFORM_CAPABILITIES).filter((capability) =>
    hasPlatformCapability(user, capability)
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-1">
        {/* BAL-534 F1 fix — the shell's Breadcrumbs already renders THE ONE <h1> for this route
            (breadcrumbs.tsx:121-131); this in-page heading is demoted to <h2> per the BAL-499 F5
            convention so a screen reader does not hear "Config & catalogue" twice. */}
        <h2 className="text-foreground text-2xl font-semibold">Config &amp; catalogue</h2>
        <p className="text-muted-foreground max-w-2xl text-sm">
          {/* pending-MJ */}
          Platform knobs and the admin surfaces that already exist. Each write is audited; view is
          staff-wide.
        </p>
      </div>
      <CatalogueList rows={resolveCatalogueRows(ADMIN_CATALOGUE_ROWS, heldCapabilities)} />
    </div>
  );
}
