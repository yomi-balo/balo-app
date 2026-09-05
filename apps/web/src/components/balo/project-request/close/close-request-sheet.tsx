'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { FileText, Loader2, Lock, Mail, User, XCircle } from 'lucide-react';
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
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import {
  CLOSE_NOTE_MIN_LENGTH,
  CLOSE_REASONS,
  closeNotePlaceholderFor,
  consequenceFor,
  type CloseReasonOption,
  type TrackStage,
} from '@/lib/project-request/close-copy';
import {
  closeRequestAction,
  type CloseRequestActionResult,
} from '@/app/(dashboard)/projects/[requestId]/_actions/close-request';
import {
  closeRequestAsAdminAction,
  type CloseRequestAsAdminActionResult,
} from '@/app/(dashboard)/projects/[requestId]/_actions/close-request-as-admin';

/**
 * CloseRequestSheet — BAL-540 Phase 6.2 (design ref `CloseSheet`, `:686-878`). ONE component,
 * two variants: the client's own withdrawal (no reason picker — their only reason is
 * "withdrawn", so it is STATED) and Balo's proxy close (a required 3-way reason + a required
 * Balo-only note, never shown to the client or the experts).
 *
 * Self-contained: owns its own pending/reason/note state and calls the right Server Action for
 * its `variant` directly (the codebase's established island shape — `accept-confirm-modal.tsx`),
 * rather than routing through a caller-supplied callback.
 */

export interface CloseSheetTrack {
  expertName: string;
  partyLabel: string;
  stage: TrackStage;
}

type AdminReasonKey = CloseReasonOption['key'];

interface CloseRequestSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestId: string;
  requestTitle: string;
  companyName: string;
  variant: 'client' | 'admin';
  liveTracks: readonly CloseSheetTrack[];
}

function pluralizeExperts(count: number): string {
  return `${count} ${count === 1 ? 'expert' : 'experts'}`;
}

export function CloseRequestSheet({
  open,
  onOpenChange,
  requestId,
  requestTitle,
  companyName,
  variant,
  liveTracks,
}: Readonly<CloseRequestSheetProps>): React.JSX.Element {
  const router = useRouter();
  const isAdmin = variant === 'admin';
  const [reason, setReason] = useState<AdminReasonKey | null>(null);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);

  const canConfirm = !isAdmin || (reason !== null && note.trim().length >= CLOSE_NOTE_MIN_LENGTH);

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
    if (pending || !canConfirm) return;
    setPending(true);

    // Picking the action in a helper narrows `reason` to non-null inside the admin branch, so
    // there is no `as AdminReasonKey` cast anywhere. `null` ⇒ nothing to submit.
    const submit = (): Promise<
      CloseRequestActionResult | CloseRequestAsAdminActionResult
    > | null => {
      if (!isAdmin) return closeRequestAction({ requestId });
      if (reason === null) return null;
      return closeRequestAsAdminAction({ requestId, reason, note: note.trim() });
    };

    const run = async (): Promise<void> => {
      try {
        const submitted = submit();
        if (submitted === null) return;
        const result = await submitted;

        if (!result.success) {
          toast.error(result.error);
          return;
        }

        track(PROJECT_EVENTS.PROJECT_REQUEST_CLOSED, {
          request_id: requestId,
          reason: result.analytics.reason,
          actor_kind: result.analytics.actorKind,
          stage_at_close: result.analytics.stageAtClose,
          open_tracks: result.analytics.openTracks,
          open_proposals: result.analytics.openProposals,
        });

        // pending-MJ
        toast.success(`Request closed — ${pluralizeExperts(result.analytics.expertsTold)} told`);
        handleOpenChange(false);
        router.refresh();
      } catch {
        toast.error('Could not close the request. Please try again.'); // pending-MJ
      } finally {
        setPending(false);
      }
    };
    run();
  }, [pending, canConfirm, isAdmin, requestId, reason, note, handleOpenChange, router]);

  // ⚠ EXPLICIT `key`s, NOT `key={text}`: two experts sharing a display name produce the same
  // consequence sentence, and React would then see duplicate keys.
  const items: Array<{ key: string; Icon: typeof User; text: string }> = [
    ...liveTracks.map((t, index) => ({
      key: `track-${index}`,
      Icon: User,
      text: consequenceFor(t),
    })),
    {
      key: 'files',
      Icon: FileText,
      // pending-MJ
      text: 'Files stay exactly as they are. Nothing is shared further, and nothing already shared is taken back.',
    },
    ...(isAdmin
      ? [
          {
            key: 'told',
            Icon: Mail,
            // pending-MJ
            text: `${companyName} is told the request was closed and why — the reason, never this note.`,
          },
        ]
      : []),
  ];

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      {/* ⚠ NO `aria-describedby={undefined}` HERE. The sibling sheets in this codebase
          (`mobile-request-sheet`, `proposal-composer`, `mobile-overflow-sheet`) set it only
          because they render NO `SheetDescription` and need to silence Radix's dev warning.
          This sheet HAS a real, load-bearing description (the consequence-list intro) — copying
          the override would break Radix's automatic wiring and stop a screen reader announcing
          it on open, on a confirmation flow where that copy is the whole point. */}
      <SheetContent className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          {/* pending-MJ */}
          <SheetTitle>Close this request?</SheetTitle>
          {/* pending-MJ */}
          <SheetDescription>
            {isAdmin
              ? `${companyName} stops looking for an expert for`
              : 'You stop looking for an expert for'}{' '}
            <span className="text-foreground font-semibold">{requestTitle}</span>. Here is what
            happens:
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4">
          <ul className="flex flex-col gap-3">
            {items.map((item) => (
              <li key={item.key} className="flex items-start gap-2.5">
                <span className="bg-muted mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md">
                  <item.Icon className="text-muted-foreground h-3 w-3" aria-hidden="true" />
                </span>
                <span className="text-foreground text-sm leading-relaxed">{item.text}</span>
              </li>
            ))}
          </ul>

          {isAdmin ? (
            <div className="mt-5">
              {/* pending-MJ */}
              <p className="text-foreground mb-2 text-xs font-bold">Why is Balo closing it?</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {CLOSE_REASONS.map((r) => {
                  const on = reason === r.key;
                  return (
                    <button
                      key={r.key}
                      type="button"
                      // Single-select group: the selection state must be PROGRAMMATIC, not
                      // colour-only (CLAUDE.md's accessibility bar).
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
                      <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                        {r.hint}
                      </p>
                    </button>
                  );
                })}
              </div>

              <label
                htmlFor="close-request-note"
                className="text-foreground mt-4 mb-1.5 flex items-center gap-1.5 text-xs font-bold"
              >
                <Lock className="text-muted-foreground h-3 w-3" aria-hidden="true" />
                {/* pending-MJ */}
                Balo-only note
              </label>
              <Textarea
                id="close-request-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                disabled={pending}
                placeholder={closeNotePlaceholderFor(companyName)}
              />
            </div>
          ) : (
            <p className="text-muted-foreground mt-4 text-xs leading-relaxed">
              {/* pending-MJ */}
              This is recorded as withdrawn by {companyName}. It can’t be undone — if you change
              your mind, you raise a new request.
            </p>
          )}
        </div>

        <SheetFooter className="flex-row items-center justify-end gap-2 border-t">
          {isAdmin && !canConfirm && (
            <span className="text-muted-foreground mr-auto text-[11.5px]">
              {/* pending-MJ */}
              Pick a reason and leave a note to close.
            </span>
          )}
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={pending}>
            {/* pending-MJ */}
            Keep open
          </Button>
          <Button onClick={handleConfirm} disabled={!canConfirm || pending}>
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <XCircle className="h-4 w-4" aria-hidden="true" />
            )}
            {/* pending-MJ */}
            Close request
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
