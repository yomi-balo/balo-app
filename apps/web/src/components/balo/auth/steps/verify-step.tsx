'use client';

import { useState, useRef, useEffect } from 'react';
import { ArrowLeft, Loader2, Mail } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { ShimmerButton } from '@/components/magicui/shimmer-button';
import { AuthHeader } from '../auth-header';
import { VerificationCodeInput } from '../verification-code-input';
import { verifyEmailAction } from '@/lib/auth/actions';
import { track, AUTH_EVENTS, analytics } from '@/lib/analytics';

interface VerifyStepProps {
  email: string;
  pendingAuthToken: string;
  formError: string | null;
  onSuccess: () => void;
  onError: (error: string) => void;
  onBack: () => void;
}

export function VerifyStep({
  email,
  pendingAuthToken,
  formError,
  onSuccess,
  onError,
  onBack,
}: Readonly<VerifyStepProps>): React.JSX.Element {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [resendFeedback, setResendFeedback] = useState(false);
  const resendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resendTimerRef.current) {
        clearTimeout(resendTimerRef.current);
      }
    };
  }, []);

  const handleVerify = async (verificationCode: string): Promise<void> => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const result = await verifyEmailAction({
        pendingAuthToken,
        code: verificationCode,
      });

      if (result.success) {
        track(AUTH_EVENTS.EMAIL_VERIFIED, {});
        track(AUTH_EVENTS.VERIFICATION_CODE_SUBMITTED, { success: true });
        analytics.identify(result.data?.userId ?? '', {
          email: result.data?.email,
          active_mode: result.data?.activeMode,
          platform_role: result.data?.platformRole,
        });
        router.push('/onboarding');
        onSuccess();
      } else {
        track(AUTH_EVENTS.VERIFICATION_CODE_SUBMITTED, { success: false });
        onError(result.error);
        setCode('');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResend = (): void => {
    // TODO: Implement actual resend via WorkOS API when endpoint is available.
    // For now, show guidance instead of false confirmation.
    track(AUTH_EVENTS.VERIFICATION_CODE_RESENT, {});
    setResendFeedback(true);
    resendTimerRef.current = setTimeout(() => setResendFeedback(false), 5000);
  };

  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <div className="flex w-full items-center">
        <button
          type="button"
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring -ml-1 rounded-sm p-1 transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          aria-label="Go back"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
      </div>

      <div className="bg-primary/10 flex h-14 w-14 items-center justify-center rounded-full">
        <Mail className="text-primary h-7 w-7" />
      </div>

      <AuthHeader title="Check your email" subtitle={`We sent a 6-digit code to ${email}`} />

      <div className="flex justify-center">
        <VerificationCodeInput
          value={code}
          onChange={setCode}
          onComplete={handleVerify}
          disabled={isSubmitting}
          autoFocus
        />
      </div>

      {formError && (
        <p className="text-destructive text-center text-sm" role="alert">
          {formError}
        </p>
      )}

      <ShimmerButton
        type="button"
        disabled={isSubmitting || code.length !== 6}
        onClick={() => handleVerify(code)}
        className="h-11 w-full rounded-lg text-sm font-medium"
        shimmerColor="rgba(255, 255, 255, 0.15)"
        background="var(--primary)"
      >
        {isSubmitting ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Verifying...
          </>
        ) : (
          'Verify'
        )}
      </ShimmerButton>

      <p className="text-muted-foreground text-sm">
        Didn&apos;t receive the code?{' '}
        {resendFeedback ? (
          <span className="text-muted-foreground font-medium">Please check your spam folder</span>
        ) : (
          <button
            type="button"
            onClick={handleResend}
            className="text-primary hover:text-primary/80 focus-visible:ring-ring rounded-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            Resend
          </button>
        )}
      </p>
    </div>
  );
}
