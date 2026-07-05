'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Users, Loader2, Check } from 'lucide-react';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { track, EXPERT_EVENTS } from '@/lib/analytics';
import { EmailChipsInput, type EmailChipsInputHandle } from '../../_components/email-chips-input';
import {
  sendReferralInvitesAction,
  type SendReferralInvitesResult,
} from '../_actions/send-referral-invites';

type SendState = 'idle' | 'sending' | 'sent' | 'error';

interface SentSummary {
  sentCount: number;
  alreadyCount: number;
}

const EMAILS_LABEL_ID = 'referral-emails';

/** Human error copy for the action's failure codes (no nested ternaries). */
function errorMessage(error: Extract<SendReferralInvitesResult, { ok: false }>['error']): string {
  if (error === 'no_application') {
    return "We couldn't find your expert application. Please refresh and try again.";
  }
  if (error === 'invalid_input') {
    return 'Please double-check the email addresses and try again.';
  }
  return "Couldn't send invitations. Please try again.";
}

/** Confirmation copy from the per-address results (sent vs already-invited). */
function buildConfirmation({ sentCount, alreadyCount }: SentSummary): {
  title: string;
  description: string;
} {
  if (sentCount > 0 && alreadyCount > 0) {
    return {
      title: `${sentCount} invitation${sentCount === 1 ? '' : 's'} sent`,
      description: `${alreadyCount} address${alreadyCount === 1 ? ' was' : 'es were'} already invited.`,
    };
  }
  if (sentCount > 0) {
    return {
      title: `${sentCount} invitation${sentCount === 1 ? '' : 's'} sent`,
      description: "We've emailed your colleagues. Thanks for growing the network!",
    };
  }
  return {
    title: 'Already invited',
    description: 'Those colleagues have already been invited to Balo.',
  };
}

export function ReferralInviteSection(): React.JSX.Element {
  const [emails, setEmails] = useState<string[]>([]);
  const [sendState, setSendState] = useState<SendState>('idle');
  const [summary, setSummary] = useState<SentSummary | null>(null);
  const chipsRef = useRef<EmailChipsInputHandle>(null);

  // Fire the prompt-viewed event exactly once on mount (denominator metric).
  const hasTrackedViewRef = useRef(false);
  useEffect(() => {
    if (hasTrackedViewRef.current) return;
    hasTrackedViewRef.current = true;
    track(EXPERT_EVENTS.REFERRAL_PROMPT_VIEWED, {});
  }, []);

  const handleSend = useCallback(async (): Promise<void> => {
    // Commit any pending (typed-but-not-Enter'd) text first so the last address is
    // deterministically included — independent of blur→rerender→click ordering.
    const finalEmails = chipsRef.current?.flush() ?? emails;
    if (finalEmails.length === 0) return;
    setSendState('sending');
    try {
      const result = await sendReferralInvitesAction({ emails: finalEmails });

      if (result.ok) {
        setSummary({ sentCount: result.sentCount, alreadyCount: result.alreadyCount });
        setSendState('sent');
        track(EXPERT_EVENTS.REFERRAL_INVITES_SENT, {
          invites_sent: result.sentCount,
          invites_attempted: finalEmails.length,
          already_invited: result.alreadyCount,
        });
        if (result.sentCount > 0) {
          toast.success(`${result.sentCount} invitation${result.sentCount === 1 ? '' : 's'} sent!`);
        } else {
          toast.success('Those colleagues were already invited.');
        }
        return;
      }

      setSendState('error');
      toast.error(errorMessage(result.error));
    } catch {
      setSendState('error');
      toast.error("Couldn't send invitations. Please try again.");
    }
  }, [emails]);

  const handleRetry = useCallback((): void => {
    setSendState('idle');
  }, []);

  return (
    <motion.section
      initial={{ y: 16, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.3, delay: 1.6 }}
      aria-labelledby="referral-heading"
      className="border-border bg-card mx-auto mt-10 w-full max-w-2xl rounded-xl border p-6 sm:p-8"
    >
      <div className="flex items-center gap-3">
        <div className="rounded-lg bg-violet-100 p-2 dark:bg-violet-950/30">
          <Users className="h-5 w-5 text-violet-600" aria-hidden="true" />
        </div>
        <div>
          <h2 id="referral-heading" className="text-foreground text-base font-semibold">
            Know other Salesforce experts?
          </h2>
          <p className="text-muted-foreground text-sm">
            Invite colleagues to join Balo. We&apos;ll send each one a friendly invitation.
          </p>
        </div>
      </div>

      {sendState === 'sent' && summary ? (
        <SentConfirmation summary={summary} />
      ) : (
        <div className="mt-6 space-y-4">
          <label htmlFor={EMAILS_LABEL_ID} className="text-foreground text-sm font-medium">
            Email addresses
          </label>

          <EmailChipsInput
            ref={chipsRef}
            id={EMAILS_LABEL_ID}
            value={emails}
            onChange={setEmails}
            disabled={sendState === 'sending'}
          />

          {sendState === 'error' && (
            <p className="text-destructive text-sm" role="alert">
              Something went wrong sending your invitations.{' '}
              <button type="button" onClick={handleRetry} className="underline underline-offset-2">
                Try again
              </button>
              .
            </p>
          )}

          <div className="flex justify-end">
            <Button
              type="button"
              onClick={() => void handleSend()}
              disabled={emails.length === 0 || sendState === 'sending'}
            >
              {sendState === 'sending' ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Sending…
                </span>
              ) : (
                'Send invitations'
              )}
            </Button>
          </div>
        </div>
      )}
    </motion.section>
  );
}

function SentConfirmation({ summary }: Readonly<{ summary: SentSummary }>): React.JSX.Element {
  const { title, description } = buildConfirmation(summary);
  return (
    <motion.div
      initial={{ scale: 0.98, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: 0.25 }}
      className="border-success/20 bg-success/10 mt-6 flex items-start gap-3 rounded-lg border p-4"
    >
      <div className="bg-success/15 rounded-full p-1.5">
        <Check className="text-success h-4 w-4" aria-hidden="true" />
      </div>
      <div>
        <p className="text-foreground text-sm font-semibold">{title}</p>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
    </motion.div>
  );
}
