'use client';

import { X } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '@/components/ui/button';
import { useAuthModalContext } from '@/components/providers/auth-modal-provider';
import { Logo } from '@/components/layout/logo';
import { SignInForm } from './sign-in-form';
import { SignUpForm } from './sign-up-form';
import { ForgotPasswordForm } from './forgot-password-form';

interface AuthModalContentProps {
  onClose: () => void;
}

const viewVariants = {
  initial: { opacity: 0, x: 8 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -8 },
};

export function AuthModalContent({ onClose }: AuthModalContentProps): React.JSX.Element {
  const { state, setView } = useAuthModalContext();
  const currentView = state.view;

  const handleSuccess = (): void => {
    onClose();
  };

  return (
    <div className="flex h-full flex-col">
      {/* Sticky header */}
      <div className="border-border flex items-center justify-between border-b px-6 py-4">
        <Logo />
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Scrollable form area */}
      <div className="flex-1 overflow-x-hidden overflow-y-auto">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={currentView}
            variants={viewVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="px-6 py-6 pb-8"
          >
            {currentView === 'sign-in' && (
              <SignInForm
                onSuccess={handleSuccess}
                onSwitchToSignUp={() => setView('sign-up')}
                onForgotPassword={() => setView('forgot-password')}
              />
            )}
            {currentView === 'sign-up' && (
              <SignUpForm onSuccess={handleSuccess} onSwitchToSignIn={() => setView('sign-in')} />
            )}
            {currentView === 'forgot-password' && (
              <ForgotPasswordForm onBack={() => setView('sign-in')} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
