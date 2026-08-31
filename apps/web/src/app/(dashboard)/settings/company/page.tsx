import { Building2 } from 'lucide-react';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { TabPlaceholder } from '@/components/balo/tab-placeholder';

/**
 * BAL-503 — the Company Settings section. No backing surface exists yet (pre-flight M5: the
 * only `companiesRepository` writer in `apps/web` is the onboarding action) — a synchronous
 * placeholder, invitation-framed. No `h1` — the breadcrumb owns it (`nav-registry.ts`'s
 * `SUPPLEMENTAL_ROUTE_LABELS` entry for `/settings/company`).
 */
export default async function CompanySettingsPage(): Promise<React.JSX.Element> {
  // Reads nothing today, but M5's deferred surface lands in THIS file — so the gate is here from
  // the start rather than inherited from `settings/layout.tsx` (a layout is not re-rendered on
  // navigation between sibling segments, so it is not a durable authorization boundary).
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  return (
    <div className="mx-auto max-w-3xl">
      <TabPlaceholder
        icon={Building2}
        iconColor="#2563EB"
        title="Your company profile"
        description="This is where you'll keep your company's name, logo, and web domains up to date — so everything your team sends and books carries the right details."
      />
    </div>
  );
}
