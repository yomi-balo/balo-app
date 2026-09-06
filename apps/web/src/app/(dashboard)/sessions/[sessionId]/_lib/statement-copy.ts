/**
 * BAL-441 — every user-facing string for the session receipt/payout pages, in one place, so a
 * copy pass never has to hunt across nine component files. Every string here joins the
 * `pending-MJ` sign-off queue (flagged in the PR body). Gender-neutral throughout; "extra time"
 * is used for a client-side card-settlement hiccup, never "overdraft" (CLAUDE.md).
 *
 * Strings already owned by `@balo/shared/credit`'s `durationLine()` (the settlement-shape /
 * floor / no-show duration line, and the `missed_call` / `abandoned_wait` statement line) are
 * REUSED, not reproduced here — see `Shared vs Diverging` in the design.
 */
import type { MoneyBlockPayoutStatus } from '@balo/shared/credit';
import type { SessionStatementLens } from '@/lib/analytics/server';

export type StatementLens = SessionStatementLens;

interface LensCopy {
  eyebrow: string;
  fallbackTitle: string;
  footerNote: string;
  downloadAriaLabel: string;
  loadingAriaLabel: string;
  errorLabel: string;
  errorBody: string;
  notFoundHeading: string;
  durationRowLabel: string;
  totalRowLabel: string;
  pendingBody: string;
  cancelledLine: string;
  /** The spinning pill label while billing is not yet finalized. */
  pendingLabel: string;
}

/** Two lenses, one small table — never a nested ternary in a component. */
export const STATEMENT_COPY: Readonly<Record<StatementLens, LensCopy>> = {
  client: {
    pendingLabel: 'Charge pending', // pending-MJ
    eyebrow: 'Session receipt', // pending-MJ
    fallbackTitle: 'Consultation session', // pending-MJ
    footerNote: 'A record of the amount charged for this session.', // pending-MJ
    downloadAriaLabel: 'Download this receipt as a PDF', // pending-MJ
    loadingAriaLabel: 'Loading receipt', // pending-MJ
    errorLabel: 'this receipt',
    errorBody:
      "We couldn't load this receipt right now. Nothing about the charge has changed — this is on our side.", // pending-MJ
    notFoundHeading: "We couldn't find that receipt", // pending-MJ
    durationRowLabel: 'Duration billed', // pending-MJ
    totalRowLabel: 'Total charged', // pending-MJ
    pendingBody:
      "We're finalizing the charge for this session — this usually takes under a minute.", // pending-MJ
    cancelledLine: 'Not charged — this consultation was cancelled.', // pending-MJ
  },
  expert: {
    pendingLabel: 'Payout pending', // pending-MJ
    eyebrow: 'Payout statement', // pending-MJ
    fallbackTitle: 'Consultation session', // pending-MJ
    footerNote: 'A record of what was earned for this session.', // pending-MJ
    downloadAriaLabel: 'Download this payout statement as a PDF', // pending-MJ
    loadingAriaLabel: 'Loading payout statement', // pending-MJ
    errorLabel: 'this payout statement',
    errorBody:
      "We couldn't load this payout statement right now. Nothing about your earnings has changed — this is on our side.", // pending-MJ
    notFoundHeading: "We couldn't find that payout", // pending-MJ
    durationRowLabel: 'Duration', // pending-MJ
    totalRowLabel: 'Total earned', // pending-MJ
    pendingBody:
      "We're finalizing your earnings for this session — this usually takes under a minute.", // pending-MJ
    cancelledLine: 'No earnings recorded — this consultation was cancelled.', // pending-MJ
  },
};

/** Shared across both lenses. */
export const STATEMENT_SHARED_COPY = {
  backLink: 'Back to recap', // pending-MJ
  notFoundBody: 'It may have been moved, or you may not have access to it.', // pending-MJ
  notFoundAction: 'Back to dashboard', // pending-MJ
  errorBackAction: 'Back to your dashboard', // pending-MJ
  refreshButton: 'Refresh', // pending-MJ
  rateRowLabel: 'Rate per minute', // pending-MJ
  payoutStatusRowLabel: 'Status', // pending-MJ
  payoutRecordedRowLabel: 'Recorded', // pending-MJ
  payoutReferenceRowLabel: 'Reference', // pending-MJ
  // UX review — these four used to live inline in their components, which meant a copy pass
  // reading THIS file (as its docblock invites) would have missed them entirely.
  manageBillingLink: 'Manage billing', // pending-MJ
  downloadPdf: 'Download PDF', // pending-MJ
  loadingSrOnly: 'Loading…', // pending-MJ
  // Review F6 — these three were inline in components (and `Date pending` / `with` each had TWO
  // copies, page + PDF, free to drift). The page and the document it produces must not word the
  // same fact differently.
  datePending: 'Date pending', // pending-MJ
  counterpartyPrefix: 'with', // pending-MJ
  // BAL-519 — the rate-limited inline state. SHARED by both lenses (D4). Calm, not scolding, and
  // deliberately NO countdown: the api's cooldown is carried on the error for the PDF route's
  // `Retry-After` header, never rendered.
  rateLimitedHeading: 'Hold tight', // pending-MJ
  rateLimitedBody: "You're loading this a little quickly — try again in a minute.", // pending-MJ
  rateLimitedAction: 'Try again', // pending-MJ
} as const;

/** PDF footer pagination. A function, not a fragment, so the sentence stays reviewable whole. */
export function pdfPageLine(pageNumber: number, totalPages: number): string {
  return `Page ${pageNumber} of ${totalPages}`; // pending-MJ
}

/**
 * Payout-obligation badge labels. Keyed by `expert_payout_record_status`.
 *
 * ⚠ Only `recorded` is ever written today — `disbursing` / `paid` / `failed` are reserved for
 * the BAL-202/203 Airwallex payout run (`enums.ts` docblock). The labels ship so the badge is
 * total over the enum rather than crashing on a value the DB can already hold, NOT because those
 * states are reachable yet.
 */
export const PAYOUT_STATUS_LABELS: Readonly<Record<MoneyBlockPayoutStatus, string>> = {
  recorded: 'Booked', // pending-MJ
  disbursing: 'Disbursing', // pending-MJ
  paid: 'Paid', // pending-MJ
  failed: 'Needs a look', // pending-MJ
};

/**
 * Settlement-status sub-states — client receipt only. Never `not_required` / `settled`. The
 * `failed` / `requires_action` bodies deliberately stop short of the call-to-action clause — the
 * component appends a real `<Link href="/billing">Manage billing</Link>`, so "Manage billing"
 * is never duplicated as plain text next to the link that already says it.
 */
export const SETTLEMENT_STATUS_COPY: Readonly<Record<string, string>> = {
  processing: 'A small amount of extra time on this session is still settling.', // pending-MJ
  failed: "A little extra time couldn't settle to the card on file.", // pending-MJ
  requires_action: 'A little extra time needs a quick card confirmation.', // pending-MJ
};

/** Payout-status sub-states — expert payout only. */
export const PAYOUT_STATUS_COPY: Readonly<Record<string, string>> = {
  recorded: 'Booked — not yet sent.', // pending-MJ
  disbursing: 'On its way to your account.', // pending-MJ
  paid: 'Paid.', // pending-MJ
  failed:
    "We're on it — no action needed. If this doesn't clear in a few days, check your payout details.", // pending-MJ
};
