'use client';

import { useState, useCallback, useRef } from 'react';
import { AnimatePresence } from 'motion/react';
import { BlurFade } from '@/components/magicui/blur-fade';
import { EmailStep } from './steps/email-step';
import { PasswordStep } from './steps/password-step';
import { SignupStep } from './steps/signup-step';
import { VerifyStep } from './steps/verify-step';
import { ForgotStep } from './steps/forgot-step';
import { track, AUTH_EVENTS } from '@/lib/analytics';

export type AuthStep = 'email' | 'password' | 'signup' | 'verify' | 'forgot';

interface UnifiedAuthFormProps {
  /** Initial step -- used by login page to start at 'email' */
  defaultStep?: AuthStep;
  /** Pre-filled email from query params or login page error redirect */
  defaultEmail?: string;
  /** Error message from query params (e.g., OAuth callback error) */
  initialError?: string | null;
  /** Callback after successful auth (close modal, redirect) */
  onSuccess: () => void;
}

export function UnifiedAuthForm({
  defaultStep = 'email',
  defaultEmail = '',
  initialError = null,
  onSuccess,
}: Readonly<UnifiedAuthFormProps>): React.JSX.Element {
  const [step, setStep] = useState<AuthStep>(defaultStep);
  const [email, setEmail] = useState(defaultEmail);
  const [pendingAuthToken, setPendingAuthToken] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(initialError);
  const stepRef = useRef<AuthStep>(defaultStep);

  const goToStep = useCallback((nextStep: AuthStep) => {
    setFormError(null);
    track(AUTH_EVENTS.STEP_CHANGED, { from: stepRef.current, to: nextStep });
    stepRef.current = nextStep;
    setStep(nextStep);
  }, []);

  return (
    <AnimatePresence mode="wait" initial={false}>
      <BlurFade key={step} managed duration={0.3} direction="up" blur="6px">
        {step === 'email' && (
          <EmailStep
            email={email}
            formError={formError}
            onEmailChange={setEmail}
            onContinue={(submittedEmail: string) => {
              setEmail(submittedEmail);
              goToStep('password');
            }}
            onCreateAccount={() => goToStep('signup')}
          />
        )}
        {step === 'password' && (
          <PasswordStep
            email={email}
            formError={formError}
            onSuccess={onSuccess}
            onForgotPassword={() => goToStep('forgot')}
            onCreateAccount={() => goToStep('signup')}
            onBack={() => goToStep('email')}
            onError={setFormError}
          />
        )}
        {step === 'signup' && (
          <SignupStep
            email={email}
            formError={formError}
            onEmailChange={setEmail}
            onVerificationRequired={(token: string) => {
              setPendingAuthToken(token);
              goToStep('verify');
            }}
            onSuccess={onSuccess}
            onSignInInstead={() => goToStep('email')}
            onError={setFormError}
          />
        )}
        {step === 'verify' && pendingAuthToken ? (
          <VerifyStep
            email={email}
            pendingAuthToken={pendingAuthToken}
            formError={formError}
            onSuccess={onSuccess}
            onError={setFormError}
            onBack={() => goToStep('signup')}
          />
        ) : step === 'verify' ? (
          <EmailStep
            email={email}
            formError="Something went wrong. Please try signing up again."
            onEmailChange={setEmail}
            onContinue={(submittedEmail: string) => {
              setEmail(submittedEmail);
              goToStep('password');
            }}
            onCreateAccount={() => goToStep('signup')}
          />
        ) : null}
        {step === 'forgot' && <ForgotStep email={email} onBack={() => goToStep('email')} />}
      </BlurFade>
    </AnimatePresence>
  );
}
