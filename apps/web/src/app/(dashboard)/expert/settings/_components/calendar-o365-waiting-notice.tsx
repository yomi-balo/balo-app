'use client';

import { ExternalLink, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CALENDAR_HELP_URL } from '../_lib/calendar-help';
import { SettingsEyebrow } from './settings-card';

interface CalendarO365WaitingNoticeProps {
  readonly onTryAgain: () => void;
  readonly onCancel: () => void;
}

const INSTRUCTIONS = [
  'Ask your IT admin to approve "Balo" in the Microsoft Entra admin center',
  'This approval only needs to happen once — all colleagues at your company can connect after',
  'Once approved, click "Try connecting again" below',
] as const;

/** In-row action buttons: the 44px touch floor on mobile, compact from `sm` up. */
const ACTION_CLASS = 'h-11 sm:h-8';

/**
 * BAL-397 §9.6 — the `o365_waiting` body, rendered inside the Microsoft row (whose header
 * already shows the brand tile and the "Waiting on IT" pill), so the root is a plain `<div>`.
 * No provider prop — it is Microsoft-branded by construction (it is unreachable for Google,
 * per the slot-state machine's Microsoft-only enforcement).
 */
export function CalendarO365WaitingNotice({
  onTryAgain,
  onCancel,
}: Readonly<CalendarO365WaitingNoticeProps>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h4 className="text-foreground text-[13px] font-semibold">
          Your IT admin needs to take action
        </h4>
        <p className="text-muted-foreground mt-0.5 text-[12.5px] leading-relaxed">
          You&apos;ve requested access, but your company&apos;s Microsoft administrator needs to
          approve the Balo calendar integration in their admin portal.
        </p>
      </div>

      <div className="bg-muted rounded-lg p-3">
        <SettingsEyebrow as="p" className="mb-1.5">
          What to do next
        </SettingsEyebrow>
        <ol className="text-muted-foreground list-decimal space-y-1 pl-4 text-[12.5px] leading-snug">
          {INSTRUCTIONS.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ol>
      </div>

      <a
        href={CALENDAR_HELP_URL}
        target="_blank"
        rel="noreferrer"
        className="text-primary inline-flex w-fit items-center gap-1 text-[12.5px] hover:underline"
      >
        View admin approval guide
        <ExternalLink className="h-3 w-3" aria-hidden="true" />
      </a>

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" className={`${ACTION_CLASS} gap-1.5`} onClick={onTryAgain}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Try connecting again
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={ACTION_CLASS}
          onClick={onCancel}
        >
          Not now
        </Button>
      </div>
    </div>
  );
}
