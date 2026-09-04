'use client';

import { Loader2 } from 'lucide-react';
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
import { describeSavedCard } from '@/components/billing/top-up/SavedCardRow';
import { CARD_BACKED_MODE_TITLE } from '@/components/billing/top-up/LowBalanceModePicker';
import type { SavedCard } from '@/components/billing/top-up/types';
import type { LowBalanceMode } from '@/lib/credit/actions';
import { isCardBackedLowBalanceMode } from '@balo/shared/credit';
import { cn } from '@/lib/utils';

interface RemoveCardConfirmProps {
  readonly card: SavedCard;
  readonly mode: LowBalanceMode;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly pending: boolean;
  readonly onConfirm: () => void;
  /**
   * FIX ROUND (security MEDIUM) — set when the server refused removal because the wallet has
   * unsettled consultation time on this card. Replaces the normal description with blocking
   * copy and hides the destructive action entirely — "Keep card" is the only way out.
   */
  readonly blockedReason?: string | null;
}

/**
 * The removal-confirmation dialog — the centre of the BAL-516 design (see
 * "Removal-reconciliation flow"). Structurally identical to `CalendarDisconnectConfirm`, but the
 * copy branches on the CURRENT low-balance mode: a card-backed mode states the mode-reconcile
 * consequence in BOTH the description AND the confirm button's own label, so a client who skims
 * straight to the button still cannot miss what pressing it does — deliberately, per the design
 * doc's "state consequences in the button, not just the paragraph" principle.
 *
 * Fully controlled (`open`/`onOpenChange`/`pending`) — `PaymentMethodManager` owns the phase
 * state; this component owns no state of its own beyond rendering it.
 */
export function RemoveCardConfirm({
  card,
  mode,
  open,
  onOpenChange,
  pending,
  onConfirm,
  blockedReason = null,
}: Readonly<RemoveCardConfirmProps>): React.JSX.Element {
  const cardBacked = isCardBackedLowBalanceMode(mode);
  const cardLabel = describeSavedCard(card);
  const fullConfirmLabel = cardBacked ? 'Remove card & switch to Just notify me' : 'Remove card';

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {cardLabel}?</AlertDialogTitle>
          <AlertDialogDescription>
            {(() => {
              if (blockedReason !== null) return blockedReason;
              if (cardBacked) {
                return (
                  <>
                    You&apos;re on {CARD_BACKED_MODE_TITLE[mode]} today, which needs a card on file.
                    Removing this card switches you to Just notify me — we&apos;ll tell you when
                    your balance runs low instead of charging automatically. You can turn a
                    card-backed mode back on anytime by adding a new card.
                  </>
                );
              }
              return (
                <>
                  We&apos;ll stop keeping this card on file. Add a new one anytime you want to
                  enable Auto top-up, Keep me going, or check out faster.
                </>
              );
            })()}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep card</AlertDialogCancel>
          {blockedReason === null && (
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                onConfirm();
              }}
              disabled={pending}
              className={cn(buttonVariants({ variant: 'destructive' }), 'relative')}
            >
              {/*
                FIX ROUND (design gap) — the design says the button "stays the fixed width so
                nothing jumps" on confirm. The full label is kept in normal flow (just visually
                hidden via `invisible`, which the accessible-name computation also excludes) so
                the button's width never shrinks to fit "Removing…"; the pending copy renders on
                an absolutely-positioned overlay on top of that reserved space.
              */}
              <span className={cn('inline-flex items-center gap-2', pending && 'invisible')}>
                {fullConfirmLabel}
              </span>
              {pending && (
                <span className="absolute inset-0 flex items-center justify-center gap-2">
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Removing…
                </span>
              )}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
