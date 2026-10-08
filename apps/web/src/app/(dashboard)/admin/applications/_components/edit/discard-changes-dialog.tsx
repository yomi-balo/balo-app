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

/**
 * BAL-593 §[F] — confirms discarding unsaved changes. Design ref 2184-2242.
 *
 * "Keep editing" is the Radix `Cancel` action (the safe default, autofocused) and "Discard
 * changes" is the `Action` (the destructive confirm) — the reverse of their usual styling, so
 * both get an explicit className override.
 *
 * ⚠ `Action` AND `Cancel` are BOTH `DialogPrimitive.Close` under the hood — clicking either one
 * fires `onOpenChange(false)` in addition to its own `onClick`. Wiring `onOpenChange` to `onKeep`
 * would therefore call `onKeep` on a DISCARD click too. So `onOpenChange` is a no-op here, and
 * Escape — the one close path with no button click of its own — is handled explicitly via
 * `onEscapeKeyDown`, which calls `onKeep` and prevents Radix's default dismissal. Matches the
 * design's "Escape keeps editing" without double-firing either callback.
 */

export interface DiscardChangesDialogProps {
  readonly open: boolean;
  readonly count: number;
  readonly firstName: string;
  readonly onKeep: () => void;
  readonly onDiscard: () => void;
}

export function DiscardChangesDialog({
  open,
  count,
  firstName,
  onKeep,
  onDiscard,
}: Readonly<DiscardChangesDialogProps>): React.JSX.Element {
  return (
    <AlertDialog open={open} onOpenChange={() => {}}>
      <AlertDialogContent
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          onKeep();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            Discard {count} {count === 1 ? 'change' : 'changes'}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Your edits to {firstName}’s application won’t be saved.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction
            onClick={onDiscard}
            className="text-destructive hover:bg-destructive/10 border-0 bg-transparent shadow-none"
          >
            Discard changes
          </AlertDialogAction>
          <AlertDialogCancel
            autoFocus
            onClick={onKeep}
            className="bg-primary text-primary-foreground hover:bg-primary/90 border-0"
          >
            Keep editing
          </AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
