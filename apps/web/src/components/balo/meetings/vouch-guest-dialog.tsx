'use client';

import { useCallback, useId, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { MEETING_PANEL_EVENTS, track } from '@/lib/analytics';
import { GUEST_ACTION_COPY, VOUCH_COPY } from '@/lib/meetings/guests-copy';
import type { VouchActionResult } from '@/lib/meetings/meeting-panels';
import { MeetingDialog } from './meeting-overlay';

/**
 * BAL-579 — the client's vouch for a lobby guest: one work-email field, one confirm.
 *
 * ⚠⚠ THE VOUCHER TYPES THE EMAIL. The lobby row's own address is self-declared and never shown to
 * any viewer, so adopting it would let a typed string pose as a verified identity.
 *
 * ⚠⚠ ONLY THE CONFIRM BUTTON FOLLOWS `isSubmitting`. Cancel (and Esc, and the close control) stay
 * live while the request runs: gating dismissal on a pending flag strands the dialog in CI-only
 * flows where the flag never clears.
 *
 * ⚠ NO ADDRESS, NAME OR GUEST ID REACHES ANALYTICS — an outcome and the meeting context only.
 */

function noop(): void {
  // A failed roster refresh is recovered by the poll; it must neither surface nor go unhandled.
}

export interface VouchGuestDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly guestName: string;
  /** Closes over the meeting and the guest; resolves to the Server Action's answer. */
  readonly onVouch: (email: string) => Promise<VouchActionResult>;
  /** Toast plus live-region announcement, owned by the panel. */
  readonly report: (kind: 'success' | 'error', message: string) => void;
  /** Refreshes the roster poll after a successful vouch. */
  readonly onVouched: () => Promise<void>;
  readonly meetingProps: Readonly<{ meeting_id?: string }>;
}

export function VouchGuestDialog({
  open,
  onOpenChange,
  guestName,
  onVouch,
  report,
  onVouched,
  meetingProps,
}: Readonly<VouchGuestDialogProps>): React.JSX.Element {
  const fieldId = useId();
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const focusField = useCallback((event: Event): void => {
    event.preventDefault();
    inputRef.current?.focus();
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if (!next) {
        setEmail('');
        setErrorMessage(null);
      }
      onOpenChange(next);
    },
    [onOpenChange]
  );

  const submit = useCallback(
    (event: React.SyntheticEvent): void => {
      event.preventDefault();
      const trimmed = email.trim();
      if (trimmed.length === 0 || isSubmitting) return;
      setIsSubmitting(true);
      setErrorMessage(null);
      onVouch(trimmed)
        .then(
          (result) => {
            track(MEETING_PANEL_EVENTS.GUEST_VOUCHED, {
              ...meetingProps,
              outcome: result.success ? 'ok' : 'failed',
              ...(result.success ? {} : { status: result.status, code: result.code }),
            });
            if (result.success) {
              report('success', VOUCH_COPY.success(guestName));
              handleOpenChange(false);
            } else {
              setErrorMessage(result.error);
              report('error', result.error);
            }
          },
          () => {
            track(MEETING_PANEL_EVENTS.GUEST_VOUCHED, { ...meetingProps, outcome: 'failed' });
            setErrorMessage(GUEST_ACTION_COPY.request_failed);
            report('error', GUEST_ACTION_COPY.request_failed);
          }
        )
        .finally(() => {
          setIsSubmitting(false);
          // The roster refresh runs after either outcome and never reports: a failed refresh
          // must not read as a failed vouch, and the poll recovers it.
          onVouched().catch(noop);
        });
    },
    [email, isSubmitting, onVouch, meetingProps, report, guestName, handleOpenChange, onVouched]
  );

  const onChange = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    setEmail(event.target.value);
    setErrorMessage(null);
  }, []);

  const cancel = useCallback((): void => handleOpenChange(false), [handleOpenChange]);

  return (
    <MeetingDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={VOUCH_COPY.title(guestName)}
      description={VOUCH_COPY.body}
      onOpenAutoFocus={focusField}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={fieldId} className="text-foreground text-sm font-medium">
            {VOUCH_COPY.field}
          </label>
          <input
            id={fieldId}
            type="email"
            ref={inputRef}
            required
            autoComplete="off"
            placeholder="name@company.com"
            aria-invalid={errorMessage === null ? undefined : true}
            aria-describedby={errorMessage === null ? undefined : errorId}
            value={email}
            onChange={onChange}
            className="border-border bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring min-h-11 rounded-lg border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
          />
          {errorMessage === null ? null : (
            <p id={errorId} role="alert" className="text-destructive text-xs leading-relaxed">
              {errorMessage}
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={cancel}
            className="border-border text-foreground hover:bg-muted/60 focus-visible:ring-ring inline-flex min-h-11 items-center justify-center rounded-lg border px-4 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            {VOUCH_COPY.cancel}
          </button>
          <button
            type="submit"
            disabled={isSubmitting || email.trim().length === 0}
            className="bg-primary text-primary-foreground focus-visible:ring-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none disabled:opacity-70"
          >
            {isSubmitting ? (
              <Loader2
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : null}
            {VOUCH_COPY.confirm}
          </button>
        </div>
      </form>
    </MeetingDialog>
  );
}
