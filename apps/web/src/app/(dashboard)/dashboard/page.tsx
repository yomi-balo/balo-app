import Link from 'next/link';
import { Gift } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/session';
import { getChecklistStatus, type ChecklistStatus } from '@/lib/actions/expert-checklist';
import { ExpertDashboard } from './_components/expert-dashboard';
import { log } from '@/lib/logging';

export default async function DashboardPage(): Promise<React.JSX.Element> {
  const user = await getCurrentUser();

  if (user?.activeMode === 'expert' && user.expertProfileId) {
    let checklistStatus: ChecklistStatus | null = null;
    try {
      checklistStatus = await getChecklistStatus();
    } catch (error) {
      log.warn('Failed to fetch checklist status for dashboard', {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return (
      <ExpertDashboard checklistStatus={checklistStatus} userName={user.firstName ?? 'there'} />
    );
  }

  // Client dashboard -- existing placeholder for now
  return (
    <div>
      <div className="mb-8">
        <h1 className="text-foreground text-2xl font-semibold">Dashboard</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Welcome back. Here is an overview of your activity.
        </p>
      </div>
      {/* BAL-383: a lightweight entry point to the standalone /redeem surface. */}
      <Link
        href="/redeem"
        className="border-border bg-card hover:border-primary/40 focus-visible:ring-ring mb-6 flex items-center gap-3 rounded-xl border p-4 transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <span className="bg-primary/10 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
          <Gift className="text-primary h-4 w-4" aria-hidden="true" />
        </span>
        <span>
          <span className="text-foreground block text-sm font-medium">Have a promo code?</span>
          <span className="text-muted-foreground block text-xs">
            Redeem it to add credit — no card needed.
          </span>
        </span>
      </Link>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="border-border bg-card text-card-foreground rounded-xl border p-6">
            <div className="space-y-3">
              <div className="bg-muted h-4 w-24 animate-pulse rounded" />
              <div className="bg-muted h-8 w-16 animate-pulse rounded" />
              <div className="bg-muted h-3 w-32 animate-pulse rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
