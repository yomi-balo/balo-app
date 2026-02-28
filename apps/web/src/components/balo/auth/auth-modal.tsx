'use client';

import { useIsMobile } from '@/hooks/use-mobile';
import { useAuthModalContext } from '@/components/providers/auth-modal-provider';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { AuthModalContent } from './auth-modal-content';

export function AuthModal(): React.JSX.Element | null {
  const isMobile = useIsMobile();
  const { state, close } = useAuthModalContext();

  if (!state.isOpen) return null;

  if (isMobile) {
    return (
      <Sheet
        open={state.isOpen}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="h-[95dvh] gap-0 rounded-t-2xl p-0"
        >
          {/* Visually hidden title for a11y */}
          <SheetTitle className="sr-only">Authentication</SheetTitle>
          <AuthModalContent onClose={close} />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog
      open={state.isOpen}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="border-border/50 gap-0 overflow-hidden p-0 shadow-xl sm:max-w-[460px]"
      >
        {/* Visually hidden title for a11y */}
        <DialogTitle className="sr-only">Authentication</DialogTitle>
        <AuthModalContent onClose={close} />
      </DialogContent>
    </Dialog>
  );
}
