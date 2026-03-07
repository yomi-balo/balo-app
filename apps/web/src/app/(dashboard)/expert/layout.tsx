import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';

export default async function ExpertLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const user = await getCurrentUser();

  if (!user || user.activeMode !== 'expert' || !user.expertProfileId) {
    redirect('/dashboard');
  }

  return <>{children}</>;
}
