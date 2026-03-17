import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getCurrentUser } from '@/lib/auth/session';
import { checkSessionDrift } from '@/lib/auth/session-sync';
import { getChecklistStatus } from '@/lib/actions/expert-checklist';
import { SidebarProvider } from '@/components/layout/sidebar-context';
import { TopNav } from '@/components/layout/top-nav';
import { Sidebar } from '@/components/layout/sidebar';
import { log } from '@/lib/logging';
import { getAvatarUrl } from '@/lib/storage/avatar-url';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  // Read-only drift check — if sync needed, redirect to route handler
  // which can safely mutate cookies
  const checkResult = await checkSessionDrift();

  if (checkResult.action === 'sync-needed') {
    const headersList = await headers();
    const pathname = headersList.get('x-invoke-path') || '/dashboard';
    redirect(`/api/auth/session-sync?returnTo=${encodeURIComponent(pathname)}`);
  }

  // After sync, session is guaranteed fresh — read user normally
  const user = await getCurrentUser();

  // Fetch checklist status only for expert mode users with a profile
  let checklistCompletedCount = 0;
  let checklistAllComplete = false;
  if (user?.activeMode === 'expert' && user.expertProfileId) {
    try {
      const status = await getChecklistStatus();
      checklistCompletedCount = status.completedCount;
      checklistAllComplete = status.allComplete;
    } catch (error) {
      log.warn('Failed to fetch checklist status for layout', {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const userName = user
    ? [user.firstName, user.lastName].filter(Boolean).join(' ') ||
      user.email.split('@')[0] ||
      'User'
    : 'User';
  const userInitials = user
    ? [user.firstName?.[0], user.lastName?.[0]].filter(Boolean).join('').toUpperCase() || 'U'
    : 'U';

  return (
    <SidebarProvider
      activeMode={user?.activeMode ?? 'client'}
      userName={userName}
      userInitials={userInitials}
      userAvatarUrl={getAvatarUrl(user?.avatarUrl ?? null, 'thumbnail')}
      checklistCompletedCount={checklistCompletedCount}
      checklistAllComplete={checklistAllComplete}
    >
      <div className="bg-background min-h-screen">
        <div className="flex">
          <Sidebar />
          <div className="flex min-h-screen flex-1 flex-col">
            <TopNav />
            <main className="flex-1 p-6 lg:p-8">
              <div className="mx-auto max-w-7xl">{children}</div>
            </main>
          </div>
        </div>
      </div>
    </SidebarProvider>
  );
}
