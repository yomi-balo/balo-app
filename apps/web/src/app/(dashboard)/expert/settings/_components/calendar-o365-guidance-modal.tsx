'use client';

import { ArrowRight, ExternalLink, Info } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { MicrosoftIcon } from './calendar-provider-icons';

interface CalendarO365GuidanceModalProps {
  onContinue: () => void;
  onCancel: () => void;
}

const STEPS = [
  'A Microsoft sign-in window opens',
  'Sign in with your work account',
  'If prompted for admin approval, click "Request approval" and ask your IT admin',
  'Once approved, click "Connect" again to complete the setup',
] as const;

export function CalendarO365GuidanceModal({
  onContinue,
  onCancel,
}: Readonly<CalendarO365GuidanceModalProps>): React.JSX.Element {
  return (
    <Card className="overflow-hidden">
      {/* Header */}
      <div className="from-primary/5 to-accent/10 dark:from-primary/10 dark:to-accent/15 border-accent/10 border-b bg-gradient-to-r px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="bg-card border-border flex h-10 w-10 items-center justify-center rounded-[11px] border shadow-sm">
            <MicrosoftIcon size={22} />
          </div>
          <div>
            <p className="text-foreground text-sm font-semibold">Connect Microsoft 365</p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              Outlook or Microsoft 365 work account
            </p>
          </div>
        </div>
      </div>

      <div className="px-5 py-5">
        {/* Admin approval callout */}
        <div className="bg-primary/5 border-primary/20 mb-4.5 rounded-[10px] border p-3.5">
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
        <div className="mb-1 space-y-2">
          {STEPS.map((text, step) => (
            <div key={text} className="flex items-start gap-2.5">
              <div className="bg-muted border-border text-muted-foreground flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold">
                {step + 1}
              </div>
              <span className="text-muted-foreground pt-0.5 text-[13px] leading-snug">{text}</span>
            </div>
          ))}
        </div>

        <a
          href="https://docs.cronofy.com/calendar-admins/faqs/need-admin-approval-error/"
          target="_blank"
          rel="noreferrer"
          className="text-primary mt-1 mb-5 inline-flex items-center gap-1 text-xs hover:underline"
        >
          Admin approval guide
          <ExternalLink className="h-[11px] w-[11px]" aria-hidden="true" />
        </a>

        {/* CTAs */}
        <div className="flex gap-2.5">
          <Button className="flex-1 gap-2" onClick={onContinue}>
            Continue to Microsoft 365
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}
