'use client';

import { useEffect } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { ShineBorder } from '@/components/magicui/shine-border';
import { useIsMobile } from '@/hooks/use-mobile';
import { useAuthModal } from '@/hooks/use-auth-modal';
import { UnifiedAuthForm, type AuthStep } from './unified-auth-form';
import { track, AUTH_EVENTS } from '@/lib/analytics';

interface AuthModalProps {
  defaultStep?: AuthStep;
  initialError?: string | null;
}

export function AuthModal({
  defaultStep = 'email',
  initialError = null,
}: Readonly<AuthModalProps>): React.JSX.Element {
  const { isOpen, close, handleAuthSuccess } = useAuthModal();
  const isMobile = useIsMobile(768);

  useEffect(() => {
    if (isOpen) {
      track(AUTH_EVENTS.MODAL_OPENED, {
        view: defaultStep,
        page: typeof window !== 'undefined' ? window.location.pathname : '',
      });
    }
  }, [isOpen, defaultStep]);

  const content = (
    <UnifiedAuthForm
      defaultStep={defaultStep}
      initialError={initialError}
      onSuccess={handleAuthSuccess}
    />
  );

  if (isMobile) {
    return (
      <Sheet open={isOpen} onOpenChange={(open) => !open && close()}>
        <SheetContent
          side="bottom"
          className="max-h-[90dvh] overflow-hidden rounded-t-2xl"
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
          <div className="overflow-y-auto px-6 pt-6 pb-8">{content}</div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent
        className="overflow-hidden rounded-xl border-0 p-0 sm:max-w-[440px]"
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
        <div className="p-6">{content}</div>
      </DialogContent>
    </Dialog>
  );
}
