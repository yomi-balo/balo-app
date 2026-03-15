import { getCurrentUser } from '@/lib/auth/session';
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
