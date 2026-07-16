'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Clock, Loader2, Send } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatUtcLongDate } from '@/lib/format/local-date';
import { shareProposalWithColleague } from '@/app/(dashboard)/projects/[requestId]/proposal/[relationshipId]/_actions/share';

type ModalState = 'default' | 'submitting' | 'success' | 'error';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A linear, ReDoS-free plausibility check for an email address (mirrors the server's
 * Zod `.email()` intent without shipping a heavy validator). Deliberately hand-rolled
 * with index scans — no backtracking regex — so an adversarial input can't stall the
 * UI: exactly one `@` with text before it, and a dotted, non-terminal domain after.
 */
function isPlausibleEmail(value: string): boolean {
  const email = value.trim();
  if (email.length === 0 || email.length > 254) return false;
  if (/\s/.test(email)) return false; // constant regex — no super-linear surface
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) return false;
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

interface ShareModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestId: string;
  relationshipId: string;
}

/**
 * Share-with-a-colleague modal (BAL-386, Surface 1b). States: default / submitting
 * / success / error. Sends the current client PDF + a private view link to an
 * external email via {@link shareProposalWithColleague}; the raw magic-link token
 * never touches the client. The error state is retryable and PRESERVES the email +
 * note; Escape / backdrop close is disabled while submitting so an in-flight send
 * can't be orphaned.
 */
export function ShareModal({
  open,
  onOpenChange,
  requestId,
  relationshipId,
}: Readonly<ShareModalProps>): React.JSX.Element {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [state, setState] = useState<ModalState>('default');
  const [sentTo, setSentTo] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);

  // Fresh slate each time the modal opens — never carry a stale state/inputs across
  // opens (a prior success or error must not bleed into the next share).
  useEffect(() => {
    if (open) {
      setState('default');
      setEmail('');
      setNote('');
      setSentTo('');
      setEmailTouched(false);
    }
  }, [open]);

  // Display-only "+30 days" preview; the authoritative expiry is set server-side
  // and stated in the email. UTC-formatted to match the server label.
  const expiresPreview = useMemo(
    () => formatUtcLongDate(new Date(Date.now() + THIRTY_DAYS_MS)),
    []
  );

  const submitting = state === 'submitting';

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if (submitting) return; // block Esc / backdrop dismissal mid-send
      onOpenChange(next);
    },
    [submitting, onOpenChange]
  );

  const emailValid = isPlausibleEmail(email);
  // Surface the inline error once the field has been engaged (blurred) and holds a
  // non-empty but invalid address — never nag an untouched or empty field.
  const showEmailError = emailTouched && email.trim().length > 0 && !emailValid;
  const canSubmit = emailValid && !submitting;

  const handleSubmit = useCallback((): void => {
    if (!isPlausibleEmail(email) || submitting) return;
    setState('submitting');
    const trimmedEmail = email.trim();

    const run = async (): Promise<void> => {
      try {
        const result = await shareProposalWithColleague({
          requestId,
          relationshipId,
          recipientEmail: trimmedEmail,
          note: note.trim().length > 0 ? note.trim() : undefined,
        });
        if (!result.ok) {
          setState('error');
          return;
        }
        setSentTo(trimmedEmail);
        setState('success');
        toast.success(`Proposal shared with ${trimmedEmail}`);
        router.refresh();
      } catch {
        setState('error');
      }
    };
    void run();
  }, [email, note, submitting, requestId, relationshipId, router]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={!submitting} className="gap-0 p-0 sm:max-w-[440px]">
        {state === 'success' ? (
          <div className="flex flex-col items-center px-6 py-8 text-center">
            <span className="bg-success/15 text-success mb-4 flex h-12 w-12 items-center justify-center rounded-full">
              <CheckCircle2 className="h-6 w-6" aria-hidden="true" />
            </span>
            <DialogTitle className="text-base font-semibold">Sent to {sentTo}</DialogTitle>
            <DialogDescription className="mt-1.5 max-w-[320px] text-[13px] leading-relaxed">
              They&apos;ll receive an email from Balo with the proposal attached and a private link
              to view it online.
            </DialogDescription>
            <Button className="mt-5 min-w-24" onClick={() => onOpenChange(false)} type="button">
              Done
            </Button>
          </div>
        ) : (
          <>
            <DialogHeader className="border-border space-y-0 border-b p-6 text-left">
              <DialogTitle className="text-base font-semibold">Share this proposal</DialogTitle>
              <DialogDescription className="mt-1 text-[13px] leading-relaxed">
                Your colleague gets the proposal as a PDF and a private link to view it online — no
                Balo account needed.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-4 p-6">
              {state === 'error' && (
                <div className="border-destructive/30 bg-destructive/10 flex items-start gap-2.5 rounded-lg border p-3">
                  <AlertCircle
                    className="text-destructive mt-px h-4 w-4 shrink-0"
                    aria-hidden="true"
                  />
                  <p className="text-foreground text-[13px] leading-relaxed">
                    We couldn&apos;t send that just now. Your note is safe — try again.
                  </p>
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="share-email">
                  Colleague&apos;s email{' '}
                  <span className="text-destructive" aria-hidden="true">
                    *
                  </span>
                </Label>
                <Input
                  id="share-email"
                  type="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  onBlur={() => setEmailTouched(true)}
                  disabled={submitting}
                  placeholder="name@company.com"
                  autoComplete="email"
                  aria-invalid={showEmailError}
                  aria-describedby={showEmailError ? 'share-email-error' : undefined}
                  className={cn(
                    showEmailError && 'border-destructive focus-visible:ring-destructive/30'
                  )}
                />
                {showEmailError && (
                  <p id="share-email-error" className="text-destructive text-xs">
                    Enter a valid email address, like name@company.com.
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="share-note">
                  Add a note <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Textarea
                  id="share-note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  disabled={submitting}
                  rows={3}
                  placeholder="Here's the proposal we discussed…"
                  className="min-h-20 resize-none"
                />
              </div>

              <div className="text-muted-foreground flex items-start gap-2">
                <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <p className="text-xs leading-relaxed">
                  The link works until {expiresPreview} and only opens for this email address. You
                  can withdraw access anytime.
                </p>
              </div>
            </div>

            <DialogFooter className="border-border border-t p-6 pt-4">
              <Button
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
                type="button"
              >
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={!canSubmit}
                type="button"
                className="min-w-24"
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Send className="h-4 w-4" aria-hidden="true" />
                )}
                Send
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
