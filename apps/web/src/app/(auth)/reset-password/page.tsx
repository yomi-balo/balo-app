import type { Metadata } from 'next';
import { ResetPasswordForm } from '@/components/balo/auth/reset-password-form';

export const metadata: Metadata = {
  title: 'Reset Password | Balo',
};

interface ResetPasswordPageProps {
  searchParams: Promise<{ token?: string }>;
}

export default async function ResetPasswordPage({
  searchParams,
}: ResetPasswordPageProps): Promise<React.JSX.Element> {
  const { token } = await searchParams;

  return <ResetPasswordForm token={token} />;
}
