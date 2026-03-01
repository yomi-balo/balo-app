import type { Metadata } from 'next';
import { KeyRound } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Reset Password | Balo',
};

export default function ResetPasswordPage(): React.JSX.Element {
  return (
    <div className="bg-card w-full max-w-sm rounded-xl border p-8 shadow-sm">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="bg-primary/10 flex h-14 w-14 items-center justify-center rounded-full">
          <KeyRound className="text-primary h-7 w-7" />
        </div>

        <div className="space-y-2">
          <h2 className="text-foreground text-xl font-semibold">Reset your password</h2>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Password reset functionality is coming soon. Please email{' '}
            <a
              href="mailto:support@getbalo.com"
              className="text-primary hover:text-primary/80 font-medium transition-colors"
            >
              support@getbalo.com
            </a>{' '}
            if you need immediate assistance.
          </p>
        </div>

        <a
          href="/login"
          className="text-primary hover:text-primary/80 focus-visible:ring-ring mt-2 rounded-sm text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Back to sign in
        </a>
      </div>
    </div>
  );
}
