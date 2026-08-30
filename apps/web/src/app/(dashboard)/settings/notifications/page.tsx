import { Bell } from 'lucide-react';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { TabPlaceholder } from '@/components/balo/tab-placeholder';

/**
 * BAL-503 — the Notifications Settings section. No backing surface exists yet (pre-flight M5:
 * zero hits for `notification_preferences` repo-wide) — a synchronous placeholder,
 * invitation-framed. No `h1` — the breadcrumb owns it (`nav-registry.ts`'s
 * `SUPPLEMENTAL_ROUTE_LABELS` entry for `/settings/notifications`).
 */
export default async function NotificationsSettingsPage(): Promise<React.JSX.Element> {
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
        icon={Bell}
        iconColor="#7C3AED"
        title="Your notification preferences"
        description="This is where you'll choose which updates reach you and how — email or in-app — for bookings, proposals, and billing."
      />
    </div>
  );
}
