'use client';

import { X } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  /** Desktop max-width override. Defaults to `sm:max-w-[480px]`. */
  widthClassName?: string;
  /**
   * Accessible title for the dialog. Rendered visually-hidden when a custom
   * `DrawerHeader` is used, satisfying Radix's `aria-labelledby` requirement.
   */
  title: string;
  /** Optional accessible description (visually hidden). */
  description?: string;
}

/**
 * Reusable, portal-rendered drawer shell shared by the booking / project /
 * quick-start flows (BAL-252/253/255). Built on the audited shadcn `Sheet`
 * (Radix Dialog) so it gets a portal (escapes any `overflow-hidden` /
 * `transform` ancestor — e.g. the profile hero), focus trap, `Esc`-to-close,
 * scroll-lock, overlay-click-to-close, and return-focus for free.
 *
 * Desktop: slides in from the right. Mobile (<820px): a bottom sheet with
 * rounded top corners.
 *
 * Compose with `DrawerHeader` / `DrawerBody` / `DrawerFooter`.
 */
export function Drawer({
  open,
  onOpenChange,
  children,
  widthClassName = 'sm:max-w-[480px]',
  title,
  description,
}: Readonly<DrawerProps>): React.JSX.Element {
  const isMobile = useIsMobile(820);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? 'bottom' : 'right'}
        showCloseButton={false}
        className={cn(
          'gap-0 p-0',
          isMobile ? 'h-auto max-h-[92vh] rounded-t-[20px]' : cn('h-full w-full', widthClassName)
        )}
      >
        <SheetTitle className="sr-only">{title}</SheetTitle>
        {/* Always render a description so Radix's `aria-describedby` is satisfied;
            falls back to the title when the caller doesn't supply one. */}
        <SheetDescription className="sr-only">{description ?? title}</SheetDescription>
        {children}
      </SheetContent>
    </Sheet>
  );
}

interface DrawerHeaderProps {
  children?: React.ReactNode;
  /** Wired to the drawer's `onOpenChange(false)` by the consuming flow. */
  onClose: () => void;
  className?: string;
}

/**
 * Header row: a content slot (title / stepper) on the left and a close button
 * on the right, with a bottom border. `shrink-0` so it never collapses.
 */
export function DrawerHeader({
  children,
  onClose,
  className,
}: Readonly<DrawerHeaderProps>): React.JSX.Element {
  return (
    <div
      className={cn(
        'border-border/60 flex shrink-0 items-center justify-between gap-3 border-b px-6 py-4',
        className
      )}
    >
      <div className="min-w-0">{children}</div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="border-border bg-card text-muted-foreground hover:bg-muted focus-visible:ring-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/** Scrollable body region. */
export function DrawerBody({
  children,
  className,
}: Readonly<{ children: React.ReactNode; className?: string }>): React.JSX.Element {
  return <div className={cn('flex-1 overflow-y-auto', className)}>{children}</div>;
}

/** Footer action row, pinned to the bottom with a top border. */
export function DrawerFooter({
  children,
  className,
}: Readonly<{ children: React.ReactNode; className?: string }>): React.JSX.Element {
  return (
    <div
      className={cn(
        'border-border/60 flex shrink-0 items-center justify-between gap-4 border-t px-6 py-4',
        className
      )}
    >
      {children}
    </div>
  );
}
