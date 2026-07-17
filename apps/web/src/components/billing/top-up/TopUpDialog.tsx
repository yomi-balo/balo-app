'use client';

import { useCallback, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { TopUpComposer } from './TopUpComposer';
import type { WalletSnapshot, DisplayFxSnapshot } from './types';

interface ResponsiveModalProps {
  readonly trigger: React.ReactNode;
  /** Screen-reader title/description (the visual title lives in the composer's dark hero). */
  readonly title: string;
  readonly description: string;
  /** Rendered with a `close` callback so the body (composer receipt "Done") can dismiss it. */
  readonly children: (close: () => void) => React.ReactNode;
}

/**
 * BAL-377 responsive modal — a Dialog on desktop, a bottom Sheet on mobile (design LOCKED §7).
 * Both are Radix-backed: focus trap, Escape/overlay dismissal, and a screen-reader title/
 * description (`sr-only`) so the always-dark composer hero doesn't leave the dialog unlabelled.
 * The content chrome (padding/border) is stripped so the composer's own card shell is the
 * surface. Dark mode + reduced motion come from the base Dialog/Sheet primitives.
 */
export function ResponsiveModal({
  trigger,
  title,
  description,
  children,
}: Readonly<ResponsiveModalProps>) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const close = useCallback(() => setOpen(false), []);

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <SheetContent
          side="bottom"
          className="max-h-[92vh] overflow-y-auto border-0 bg-transparent p-0 shadow-none"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription>{description}</SheetDescription>
          </SheetHeader>
          {children(close)}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-[560px] border-0 bg-transparent p-0 shadow-none">
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children(close)}
      </DialogContent>
    </Dialog>
  );
}

interface TopUpDialogProps {
  readonly trigger: React.ReactNode;
  readonly wallet: WalletSnapshot;
  readonly fx: DisplayFxSnapshot | null;
}

/**
 * BAL-377 — the top-up composer as a launchable Dialog/Sheet over any launcher context, backed
 * by the real `/billing/top-up` route for email + in-session deep-links. On a successful
 * purchase the composer swaps to its receipt; its "Done" action calls `close` to dismiss.
 */
export function TopUpDialog({ trigger, wallet, fx }: Readonly<TopUpDialogProps>) {
  return (
    <ResponsiveModal
      trigger={trigger}
      title="Top up your balance"
      description="Add prepaid credit to your team balance."
    >
      {(close) => <TopUpComposer wallet={wallet} fx={fx} onClose={close} />}
    </ResponsiveModal>
  );
}
