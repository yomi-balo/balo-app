'use client';

import { motion, AnimatePresence } from 'motion/react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { ShineBorder } from '@/components/magicui/shine-border';
import { useIsMobile } from '@/hooks/use-mobile';
import { useAuthModal } from '@/hooks/use-auth-modal';
import { SignInForm } from './sign-in-form';
import { SignUpForm } from './sign-up-form';
import { ForgotPasswordForm } from './forgot-password-form';

const viewTransition = {
  initial: { opacity: 0, y: 6, filter: 'blur(6px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
  exit: { opacity: 0, y: -6, filter: 'blur(4px)' },
};

function AuthModalContent(): React.JSX.Element {
  const { view, setView, handleAuthSuccess } = useAuthModal();

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={view} {...viewTransition} transition={{ duration: 0.3, ease: 'easeOut' }}>
        {view === 'sign-in' && (
          <SignInForm
            onSuccess={handleAuthSuccess}
            onSwitchToSignUp={() => setView('sign-up')}
            onForgotPassword={() => setView('forgot-password')}
          />
        )}
        {view === 'sign-up' && (
          <SignUpForm onSuccess={handleAuthSuccess} onSwitchToSignIn={() => setView('sign-in')} />
        )}
        {view === 'forgot-password' && (
          <ForgotPasswordForm
            onSuccess={() => {
              /* Stay on success state within the form */
            }}
            onBackToSignIn={() => setView('sign-in')}
          />
        )}
      </motion.div>
    </AnimatePresence>
  );
}

export function AuthModal(): React.JSX.Element {
  const { isOpen, close } = useAuthModal();
  const isMobile = useIsMobile(768);

  if (isMobile) {
    return (
      <Sheet open={isOpen} onOpenChange={(open) => !open && close()}>
        <SheetContent
          side="bottom"
          className="h-[90dvh] overflow-y-auto rounded-t-2xl px-6 pt-6 pb-8"
          showCloseButton={true}
        >
          <SheetTitle className="sr-only">Authentication</SheetTitle>
          <AuthModalContent />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent
        className="relative overflow-hidden border-0 p-0 sm:max-w-[440px]"
        showCloseButton={true}
      >
        <DialogTitle className="sr-only">Authentication</DialogTitle>
        <ShineBorder
          shineColor={[
            'oklch(0.552 0.228 260.9)',
            'oklch(0.55 0.2 290)',
            'oklch(0.626 0.186 259.6)',
          ]}
          borderWidth={1.5}
          duration={10}
        />
        <div className="p-6">
          <AuthModalContent />
        </div>
      </DialogContent>
    </Dialog>
  );
}
