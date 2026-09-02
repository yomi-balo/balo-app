import type { SessionStatementView } from '../_lib/session-statement-view';
import { isStatementDownloadable } from '../_lib/session-statement-view';
import { STATEMENT_COPY } from '../_lib/statement-copy';
import { StatementPageShell, StatementCard } from './statement-page-shell';
import { StatementBackLink, StatementHeader } from './statement-header';
import { StatementLineItems } from './statement-line-items';
import { StatementZeroMoney } from './statement-zero-money';
import { StatementPending } from './statement-pending';
import { StatementReveal } from './statement-reveal';
import { SettlementStatusNote } from './settlement-status-note';
import { PayoutStatusBlock } from './payout-status-block';
import { StatementDownloadLink } from './statement-download-link';

/**
 * The whole authorised page body — the page wrapper, back link, card, header, divider, the
 * mode-branched money region, the lens-specific status block, the footer note and the download
 * link slot (§7.4 of the plan). ONE component both `receipt/page.tsx` and `payout/page.tsx`
 * render; the lens branch lives in the DATA (`view.lens`), never a prop flag.
 */
export function StatementShell({
  view,
}: Readonly<{ view: SessionStatementView }>): React.JSX.Element {
  const copy = STATEMENT_COPY[view.lens];
  const title = view.title ?? copy.fallbackTitle;
  const downloadable = isStatementDownloadable(view);
  // The footer note and the download slot are dropped for the non-monetary compositions — the
  // statement line already says everything, and there is nothing yet worth forwarding.
  //
  // ⚠ 'pending' is EXCLUDED deliberately (UX review). The footer note is past-tense — "a record
  // of the amount charged/earned for this session" — so rendering it while the charge has not
  // finalized puts a completed-fact sentence directly above a spinner that says the opposite.
  // The download slot was already correctly suppressed here via `isStatementDownloadable`; this
  // closes the copy half of the same state.
  const showFooterAndFooterChrome = view.mode.kind === 'money';

  return (
    <StatementPageShell>
      <StatementBackLink meetingId={view.meetingId} />
      <StatementReveal>
        <StatementCard>
          <StatementHeader
            eyebrow={copy.eyebrow}
            title={title}
            occurredAtIso={view.occurredAtIso}
            counterparty={view.counterparty}
          />
          <div className="border-border my-6 border-t" />

          {view.mode.kind === 'pending' && <StatementPending lens={view.lens} />}
          {(view.mode.kind === 'zero' || view.mode.kind === 'cancelled') && (
            <StatementZeroMoney view={view} />
          )}
          {view.mode.kind === 'money' && (
            <>
              <StatementLineItems view={view} />
              {view.lens === 'client' && (
                <SettlementStatusNote settlementStatus={view.block.settlementStatus} />
              )}
              {view.lens === 'expert' && (
                <PayoutStatusBlock payoutStatus={view.block.payoutStatus} payout={view.payout} />
              )}
            </>
          )}

          {showFooterAndFooterChrome && (
            <div className="border-border/60 mt-8 border-t pt-4">
              <p className="text-muted-foreground text-xs">{copy.footerNote}</p>
              {downloadable && (
                <StatementDownloadLink sessionId={view.sessionId} lens={view.lens} />
              )}
            </div>
          )}
        </StatementCard>
      </StatementReveal>
    </StatementPageShell>
  );
}
