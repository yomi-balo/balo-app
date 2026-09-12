'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2, Lock, XCircle } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { track, ADMIN_APPLICATIONS_EVENTS } from '@/lib/analytics';
import type { ExpertDeclineReason } from '@balo/shared/experts';
import {
  DECLINE_NOTE_MIN_LENGTH,
  DECLINE_REASONS,
  declineNotePlaceholderFor,
} from '../_lib/decline-copy';
import { decisionOutcomeIsStale } from '../_lib/decision-staleness';
import { declineExpertApplicationAction } from '../_actions/decline-expert-application';

/**
 * BAL-549 — the decline confirm sheet. The `close-request-sheet.tsx` shape, VERBATIM: `Sheet` /
 * `SheetContent` / `SheetHeader` / `SheetTitle` / `SheetDescription` / `SheetFooter` + `Button` +
 * `Textarea`; a hand-rolled grid of `aria-pressed` reason cards (NOT a shadcn `RadioGroup`);
 * `useState(false)` pending + an inline `async run()` in a `useCallback` (NOT `useTransition`,
 * NOT `useActionState`); `toast.error` / `toast.success` from `sonner`; `router.refresh()` on
 * success; a real `SheetDescription` (so no `aria-describedby={undefined}`).
 */

interface DeclineApplicationSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly expertProfileId: string;
  readonly firstName: string;
}

export function DeclineApplicationSheet({
  open,
  onOpenChange,
  expertProfileId,
  firstName,
}: Readonly<DeclineApplicationSheetProps>): React.JSX.Element {
  const router = useRouter();
  const [reason, setReason] = useState<ExpertDeclineReason | null>(null);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);

  const canConfirm = reason !== null && note.trim().length >= DECLINE_NOTE_MIN_LENGTH;

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if (pending && !next) return; // no closing away mid-submit
      if (!next) {
        setReason(null);
        setNote('');
      }
      onOpenChange(next);
    },
    [pending, onOpenChange]
  );

  const handleConfirm = useCallback((): void => {
    if (pending || !canConfirm || reason === null) return;
    setPending(true);

    const run = async (): Promise<void> => {
      try {
        const result = await declineExpertApplicationAction({
          expertProfileId,
          reason,
          note: note.trim(),
        });

        if (!result.success) {
          toast.error(result.error);
          // W3 — a lost race means this page is stale; re-render it into its decided state.
          if (decisionOutcomeIsStale(result.code)) router.refresh();
          return;
        }

        track(ADMIN_APPLICATIONS_EVENTS.REVIEWED, result.analytics);

        /*
          pending-MJ — W6. This used to say "{firstName} has been told why", which was not true
          at the instant it appeared: the email goes out through `after()` + BullMQ, so at toast
          time it is in flight at best. The copy now claims only what has actually happened —
          the decision is recorded — and describes the email as on its way.
        */
        toast.success(`Declined — recorded, and ${firstName}'s email is on its way`);
        handleOpenChange(false);
        router.refresh();
      } catch {
        toast.error('Could not record the decision. Please try again.'); // pending-MJ
      } finally {
        setPending(false);
      }
    };
    run();
  }, [pending, canConfirm, reason, expertProfileId, note, firstName, handleOpenChange, router]);

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          {/* pending-MJ */}
          <SheetTitle>Decline {firstName}&apos;s application?</SheetTitle>
          {/* pending-MJ */}
          {/*
            ⚠ NO RE-APPLICATION PROMISE HERE EITHER (web-review fix round, W1). This said "They
            can apply again later; nothing here is permanent" — the same false promise the
            applicant email carried, told to the staffer who would repeat it. Re-submitting is
            refused (`submitApplication` accepts `'draft'` only) and a follow-up ticket owns the
            transition, so the sheet now says what declining actually does.
          */}
          <SheetDescription>
            {firstName} is emailed with the reason category below — never this note. This is the
            final call on this application: nothing re-opens it from here, and {firstName}{' '}
            can&apos;t submit it again.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4">
          <div>
            {/* pending-MJ */}
            <p className="text-foreground mb-2 text-xs font-bold">Why is Balo declining it?</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {DECLINE_REASONS.map((r) => {
                const on = reason === r.key;
                return (
                  <button
                    key={r.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setReason(r.key)}
                    disabled={pending}
                    className={cn(
                      'focus-visible:ring-ring rounded-xl border p-2.5 text-left focus-visible:ring-2 focus-visible:outline-none',
                      on ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'
                    )}
                  >
                    <p
                      className={cn(
                        'text-sm font-semibold',
                        on ? 'text-primary' : 'text-foreground'
                      )}
                    >
                      {r.label}
                    </p>
                    <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{r.hint}</p>
                  </button>
                );
              })}
            </div>

            <label
              htmlFor="decline-application-note"
              className="text-foreground mt-4 mb-1.5 flex items-center gap-1.5 text-xs font-bold"
            >
              <Lock className="text-muted-foreground h-3 w-3" aria-hidden="true" />
              {/* pending-MJ */}
              Balo-only note
            </label>
            <Textarea
              id="decline-application-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              disabled={pending}
              placeholder={declineNotePlaceholderFor(firstName)}
            />
          </div>
        </div>

        <SheetFooter className="flex-row items-center justify-end gap-2 border-t">
          {!canConfirm && (
            <span className="text-muted-foreground mr-auto text-[11.5px]">
              {/* pending-MJ */}
              Pick a reason and leave a note to decline.
            </span>
          )}
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={pending}>
            {/* pending-MJ */}
            Keep pending
          </Button>
          <Button onClick={handleConfirm} disabled={!canConfirm || pending} variant="destructive">
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <XCircle className="h-4 w-4" aria-hidden="true" />
            )}
            {/* pending-MJ */}
            Decline application
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
