import Link from 'next/link';
import { ArrowLeft, CalendarDays } from 'lucide-react';
import { personWithOrgLabel } from '@balo/shared/parties';
import type { SessionStatementCounterparty } from '@balo/shared/credit';
import { LocalDateTime } from '@/components/balo/date/local-date-time';
import { STATEMENT_SHARED_COPY } from '../_lib/statement-copy';

/**
 * BAL-441 — the statement header: back link (omitted when there is nothing to link to), eyebrow,
 * subject line, and the date/counterparty meta row. Matches `RecapHeader`'s `caseHref !== null`
 * discipline: never a guessed href.
 */
export function StatementBackLink({
  meetingId,
}: Readonly<{ meetingId: string | null }>): React.JSX.Element | null {
  if (meetingId === null) {
    return null;
  }
  return (
    <Link
      href={`/meetings/${meetingId}`}
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring -mx-1 mb-4 inline-flex w-fit items-center gap-1.5 rounded-md px-1 py-0.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
    >
      <ArrowLeft size={14} aria-hidden="true" />
      {STATEMENT_SHARED_COPY.backLink}
    </Link>
  );
}

export function StatementHeader({
  eyebrow,
  title,
  occurredAtIso,
  counterparty,
}: Readonly<{
  eyebrow: string;
  title: string;
  occurredAtIso: string | null;
  counterparty: SessionStatementCounterparty;
}>): React.JSX.Element {
  const counterpartyLine = personWithOrgLabel(counterparty.name, counterparty.orgLabel);
  return (
    <div>
      <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        {eyebrow}
      </p>
      <h1 className="text-foreground mt-1.5 line-clamp-2 text-xl font-semibold">{title}</h1>
      <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
        <CalendarDays size={14} aria-hidden="true" />
        {occurredAtIso === null ? (
          <span>{STATEMENT_SHARED_COPY.datePending}</span>
        ) : (
          <LocalDateTime iso={occurredAtIso} variant="full" />
        )}
        <span aria-hidden="true">·</span>
        <span>
          {STATEMENT_SHARED_COPY.counterpartyPrefix} {counterpartyLine}
        </span>
      </div>
    </div>
  );
}
