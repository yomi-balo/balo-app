'use client';

import { AlertTriangle, Check, Info, Loader2 } from 'lucide-react';
import { LocalDateTime } from '@/components/balo/date/local-date-time';
import { cn } from '@/lib/utils';
import type { TimezoneImpactReportDto } from '@/app/(dashboard)/expert/settings/_types/timezone-impact';
import {
  CHECK_CHECKING_COPY,
  CHECK_FAILED_COPY,
  CHECK_NONE_COPY,
  CHECK_RESCHEDULE_COPY,
  checkSomeHeadline,
  checkSomeStays,
} from './mismatch-lib';

/** What the dialog knows about the switch's effect on booked consultations. */
export type ConsultationCheckState = 'checking' | 'failed' | TimezoneImpactReportDto;

const MAX_ROWS = 3;
const MINUTE_MS = 60_000;

interface NoticeProps {
  icon: React.ReactNode;
  className: string;
  children: React.ReactNode;
}

function Notice({ icon, className, children }: Readonly<NoticeProps>): React.JSX.Element {
  return (
    <div className={cn('flex items-start gap-2 rounded-[10px] border px-3.5 py-2.5', className)}>
      <span className="mt-0.5 inline-flex shrink-0">{icon}</span>
      <p className="text-foreground text-[13px] leading-normal">{children}</p>
    </div>
  );
}

function minutesBetween(startIso: string, endIso: string): number {
  return Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / MINUTE_MS);
}

interface ConsultationCheckProps {
  state: ConsultationCheckState;
  /** The zone the rows are read in — the zone the hours would move to. */
  toTimezone: string;
}

/**
 * The switch's effect on consultations that are already booked, as a warning that never
 * blocks. Four states: checking, nothing affected, couldn't check, and some affected.
 */
export function ConsultationCheck({
  state,
  toTimezone,
}: Readonly<ConsultationCheckProps>): React.JSX.Element {
  if (state === 'checking') {
    return (
      <Notice
        className="bg-card border-border"
        icon={
          <Loader2
            className="text-muted-foreground size-[15px] animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        }
      >
        {CHECK_CHECKING_COPY}
      </Notice>
    );
  }

  if (state === 'failed') {
    return (
      <Notice
        className="bg-card border-border"
        icon={<Info className="text-muted-foreground size-[15px]" aria-hidden="true" />}
      >
        {CHECK_FAILED_COPY}
      </Notice>
    );
  }

  if (state.affectedCount === 0) {
    return (
      <Notice
        className="border-success/30 bg-success/10"
        icon={<Check className="text-success size-[15px]" aria-hidden="true" />}
      >
        {CHECK_NONE_COPY}
      </Notice>
    );
  }

  const shown = state.affected.slice(0, MAX_ROWS);
  const more = state.affectedCount - shown.length;

  return (
    <div className="border-warning/40 bg-warning/10 rounded-[10px] border px-3.5 py-2.5">
      <div className="flex gap-2">
        <AlertTriangle className="text-warning mt-0.5 size-[15px] shrink-0" aria-hidden="true" />
        <p className="text-foreground text-[13px] leading-normal">
          <span className="font-semibold">{checkSomeHeadline(state.affectedCount)}</span>{' '}
          {checkSomeStays(state.affectedCount)}
        </p>
      </div>
      <ul className="mt-2.5 flex list-none flex-col gap-1.5 pl-[23px]">
        {shown.map((consultation) => (
          <li
            key={consultation.consultationId}
            className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-[13px]"
          >
            <span className="text-foreground tabular-nums">
              <LocalDateTime
                iso={consultation.startAt}
                variant="day-month-time-range"
                durationMinutes={minutesBetween(consultation.startAt, consultation.endAt)}
                timeZone={toTimezone}
                showLength={false}
              />
            </span>
            {consultation.clientCompanyName !== null && (
              <span className="text-muted-foreground">{consultation.clientCompanyName}</span>
            )}
          </li>
        ))}
        {more > 0 && <li className="text-muted-foreground text-[13px]">and {more} more</li>}
      </ul>
      <p className="text-muted-foreground mt-2.5 pl-[23px] text-[12.5px]">
        {CHECK_RESCHEDULE_COPY}
      </p>
    </div>
  );
}
