'use client';

import { Loader2 } from 'lucide-react';
import type { PlatformRole } from '@balo/shared/parties';
import type { PlatformCapability } from '@balo/shared/authz';
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
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { AccessChangeSummary } from './access-change-summary';

export interface ConfirmAccessChangeError {
  readonly message: string;
  readonly needsReload: boolean;
}

/**
 * BAL-561 — the save confirmation, following `approve-application-confirm.tsx`'s idiom:
 * `preventDefault` on the confirm action so the dialog closes on the CALLER's terms, and a
 * pending overlay label that keeps the button's footprint stable. Fully controlled: the PARENT
 * (the detail form or the add-staff dialog) owns the action call and hands this component only
 * the data to render and the outcome to react to.
 */
interface ConfirmAccessChangeDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly firstName: string;
  readonly pending: boolean;
  readonly onConfirm: () => void;
  readonly roleBefore: PlatformRole;
  readonly roleAfter: PlatformRole;
  readonly before: ReadonlySet<PlatformCapability>;
  readonly after: ReadonlySet<PlatformCapability>;
  readonly customListBefore: boolean;
  readonly customListAfter: boolean;
  readonly error: ConfirmAccessChangeError | null;
  readonly onReload: () => void;
}

export function ConfirmAccessChangeDialog({
  open,
  onOpenChange,
  firstName,
  pending,
  onConfirm,
  roleBefore,
  roleAfter,
  before,
  after,
  customListBefore,
  customListAfter,
  error,
  onReload,
}: Readonly<ConfirmAccessChangeDialogProps>): React.JSX.Element {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          {/* pending-MJ */}
          <AlertDialogTitle>Change {firstName}&rsquo;s access?</AlertDialogTitle>
          {/* pending-MJ */}
          <AlertDialogDescription>Review what changes before you save.</AlertDialogDescription>
        </AlertDialogHeader>

        <AccessChangeSummary
          firstName={firstName}
          roleBefore={roleBefore}
          roleAfter={roleAfter}
          before={before}
          after={after}
          customListBefore={customListBefore}
          customListAfter={customListAfter}
        />

        {error !== null && (
          <div
            role="alert"
            aria-live="polite"
            className="bg-destructive/10 border-destructive/30 text-destructive flex items-center justify-between gap-3 rounded-lg border p-3 text-sm"
          >
            <span>{error.message}</span>
            {error.needsReload && (
              <Button type="button" variant="outline" size="sm" onClick={onReload}>
                {/* pending-MJ */}
                Reload
              </Button>
            )}
          </div>
        )}

        <AlertDialogFooter>
          {/* pending-MJ */}
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              // The dialog closes on the caller's terms (after the action settles) — same reason
              // `ApproveApplicationConfirm` preventDefaults here.
              event.preventDefault();
              onConfirm();
            }}
            disabled={pending}
            className="relative"
          >
            <span className={cn('inline-flex items-center gap-2', pending && 'invisible')}>
              {/* pending-MJ */}
              Save changes
            </span>
            {pending && (
              <span className="absolute inset-0 flex items-center justify-center gap-2">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                {/* pending-MJ */}
                Saving…
              </span>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
