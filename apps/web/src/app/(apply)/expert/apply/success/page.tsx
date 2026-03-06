import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { SuccessContent } from './_components/success-content';

export const metadata: Metadata = {
  title: 'Application Received | Balo',
};

export default async function ExpertApplySuccessPage(): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (!user) redirect('/login?returnTo=/expert/apply/success');

  return <SuccessContent email={user.email} />;
}
