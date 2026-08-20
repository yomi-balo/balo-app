'use client';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button';
import { PROVIDER_META } from '../_lib/calendar-providers';
import type { CalendarProvider } from '../_types/calendar';

interface CalendarDisconnectConfirmProps {
  readonly provider: CalendarProvider;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}

/**
 * BAL-397 §9.5 — rewritten as a real `AlertDialog` with PER-PROVIDER copy. Replaces the
 * shipped inline banner, whose "Disconnect all calendars" copy described a whole-account
 * action that no longer exists.
 */
export function CalendarDisconnectConfirm({
  provider,
  open,
  onOpenChange,
  onConfirm,
}: Readonly<CalendarDisconnectConfirmProps>): React.JSX.Element {
  const { label } = PROVIDER_META[provider];

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {label}?</AlertDialogTitle>
          <AlertDialogDescription>
            We&apos;ll stop reading this account, so any time you&apos;re busy there won&apos;t be
            hidden from clients any more. Your weekly hours and time off stay exactly as they are —
            and you can connect it again whenever you like.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it connected</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className={buttonVariants({ variant: 'destructive' })}
          >
            Disconnect
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
