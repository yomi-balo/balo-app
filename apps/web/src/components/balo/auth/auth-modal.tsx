'use client';

import { AnimatePresence } from 'motion/react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { BlurFade } from '@/components/magicui/blur-fade';
import { ShineBorder } from '@/components/magicui/shine-border';
import { useIsMobile } from '@/hooks/use-mobile';
import { useAuthModal } from '@/hooks/use-auth-modal';
import { SignInForm } from './sign-in-form';
import { SignUpForm } from './sign-up-form';
import { ForgotPasswordForm } from './forgot-password-form';

function AuthModalContent(): React.JSX.Element {
  const { view, setView, handleAuthSuccess } = useAuthModal();

  return (
    <AnimatePresence mode="wait" initial={false}>
      <BlurFade key={view} managed duration={0.3} direction="up" blur="6px">
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
      </BlurFade>
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
          className="h-[90dvh] overflow-hidden rounded-t-2xl"
          showCloseButton={true}
        >
          <SheetTitle className="sr-only">Authentication</SheetTitle>
          <ShineBorder
            shineColor={[
              'oklch(0.552 0.228 260.9)',
              'oklch(0.55 0.2 290)',
              'oklch(0.626 0.186 259.6)',
            ]}
            borderWidth={1.5}
            duration={10}
          />
          <div className="overflow-y-auto px-6 pt-6 pb-8" style={{ height: '100%' }}>
            <AuthModalContent />
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent
        className="overflow-hidden border-0 p-0 sm:max-w-[440px]"
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
