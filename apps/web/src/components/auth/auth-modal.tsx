'use client';

import { useCallback } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useIsMobile } from '@/hooks/use-mobile';
import { useAuthModal } from './auth-modal-provider';
import { SignInForm } from './sign-in-form';
import { SignUpForm } from './sign-up-form';
import { ForgotPasswordForm } from './forgot-password-form';

import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';

const viewVariants = {
  enter: (direction: number) => ({
    x: direction * 24,
    opacity: 0,
  }),
  center: {
    x: 0,
    opacity: 1,
  },
  exit: (direction: number) => ({
    x: direction * -24,
    opacity: 0,
  }),
};

function AuthFormContent(): React.JSX.Element {
  const { view, setView, close } = useAuthModal();

  const handleSuccess = useCallback(() => {
    close();
  }, [close]);

  return (
    <AnimatePresence mode="wait" custom={1}>
      <motion.div
        key={view}
        custom={1}
        variants={viewVariants}
        initial="enter"
        animate="center"
        exit="exit"
        transition={{ duration: 0.2, ease: 'easeOut' }}
      >
        {view === 'sign-in' && (
          <SignInForm
            onSuccess={handleSuccess}
            onSwitchToSignUp={() => setView('sign-up')}
            onForgotPassword={() => setView('forgot-password')}
          />
        )}
        {view === 'sign-up' && (
          <SignUpForm onSuccess={handleSuccess} onSwitchToSignIn={() => setView('sign-in')} />
        )}
        {view === 'forgot-password' && <ForgotPasswordForm onBack={() => setView('sign-in')} />}
      </motion.div>
    </AnimatePresence>
  );
}

export function AuthModal(): React.JSX.Element | null {
  const { isOpen, close } = useAuthModal();
  const isMobile = useIsMobile(768);

  if (isMobile) {
    return (
      <Sheet open={isOpen} onOpenChange={(open) => !open && close()}>
        <SheetContent
          side="bottom"
          className="max-h-[92vh] overflow-y-auto rounded-t-2xl px-6 pt-6 pb-8"
        >
          {/* Drag handle */}
          <div className="bg-muted mx-auto mb-4 h-1 w-10 rounded-full" />
          {/* Visually hidden accessible title/description */}
          <SheetTitle className="sr-only">Authentication</SheetTitle>
          <SheetDescription className="sr-only">Sign in or create an account</SheetDescription>
          <AuthFormContent />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent className="gap-0 p-8 sm:max-w-[440px]" showCloseButton>
        {/* Visually hidden accessible title/description */}
        <DialogTitle className="sr-only">Authentication</DialogTitle>
        <DialogDescription className="sr-only">Sign in or create an account</DialogDescription>
        <AuthFormContent />
      </DialogContent>
    </Dialog>
  );
}
