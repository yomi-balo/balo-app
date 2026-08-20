'use client';

import { ArrowRight, ExternalLink, Info } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CALENDAR_HELP_URL } from '../_lib/calendar-help';
import { MicrosoftIcon } from './calendar-provider-icons';

interface CalendarO365GuidanceModalProps {
  readonly open: boolean;
  readonly onContinue: () => void;
  /** Fires on the Cancel button AND on Esc / overlay dismiss — `Dialog`'s `onOpenChange(false)`
   *  covers all three, unlike the shipped Card which only tracked the Cancel button. */
  readonly onCancel: () => void;
}

const STEPS = [
  'A Microsoft sign-in window opens',
  'Sign in with your work account',
  'If prompted for admin approval, click "Request approval" and ask your IT admin',
  'Once approved, click "Connect" again to complete the setup',
] as const;

/**
 * BAL-397 §4.3/§9.6 — a pre-flight explainer shown BEFORE any connection exists, so it renders
 * as a real `Dialog` over the whole section rather than inventing a Microsoft card with nothing
 * behind it. `AlertDialog` would be wrong here — this is not a destructive confirmation.
 */
export function CalendarO365GuidanceModal({
  open,
  onContinue,
  onCancel,
}: Readonly<CalendarO365GuidanceModalProps>): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="bg-card border-border flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] border shadow-sm">
              <MicrosoftIcon size={22} />
            </div>
            <div>
              <DialogTitle>Connect Microsoft 365</DialogTitle>
              <DialogDescription>Outlook or Microsoft 365 work account</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Admin approval callout */}
        <div className="bg-primary/5 border-primary/20 rounded-[10px] border p-3.5">
          <div className="flex gap-2.5">
            <Info className="text-primary mt-0.5 h-[15px] w-[15px] shrink-0" aria-hidden="true" />
            <div>
              <p className="text-primary text-[13px] font-semibold">
                Your IT admin may need to approve this once
              </p>
              <p className="text-muted-foreground mt-1 text-[13px] leading-relaxed">
                If your organization uses a managed Microsoft 365 account, you may see an
                &quot;Admin approval required&quot; screen. This only needs to happen{' '}
                <strong className="text-foreground">once for your entire company</strong> — after
                your IT admin approves, all colleagues can connect without this step.
              </p>
            </div>
          </div>
        </div>

        {/* What to expect */}
        <p className="text-muted-foreground mb-2.5 text-[11px] font-bold tracking-wider uppercase">
          What to expect
        </p>
        <ol className="mb-1 space-y-2">
          {STEPS.map((text, step) => (
            <li key={text} className="flex items-start gap-2.5">
              <span
                aria-hidden="true"
                className="bg-muted border-border text-muted-foreground flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold"
              >
                {step + 1}
              </span>
              <span className="text-muted-foreground pt-0.5 text-[13px] leading-snug">{text}</span>
            </li>
          ))}
        </ol>

        <a
          href={CALENDAR_HELP_URL}
          target="_blank"
          rel="noreferrer"
          className="text-primary mt-1 mb-1 inline-flex items-center gap-1 text-xs hover:underline"
        >
          Admin approval guide
          <ExternalLink className="h-[11px] w-[11px]" aria-hidden="true" />
        </a>

        {/* CTAs */}
        <div className="mt-4 flex gap-2.5">
          <Button className="flex-1 gap-2" onClick={onContinue}>
            Continue to Microsoft 365
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
