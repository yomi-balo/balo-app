/**
 * BAL-441 — the session statement's VIEW MODEL. `apps/web`'s loader
 * (`load-session-statement.ts`) maps the wire `SessionStatement` (§4 of the plan) into this
 * shape; the page components and the PDF document consume ONLY this — never the raw wire
 * payload — so both surfaces resolve the same rendering decision off the same data.
 *
 * Dependency-free (no `server-only`, no React) — safe for the RSC page tree AND the
 * `@react-pdf/renderer` document rendered in the Node PDF route.
 */
import type {
  ClientMoneyBlock,
  ExpertMoneyBlock,
  SessionStatement,
  SessionStatementCounterparty,
  ExpertPayoutReference,
} from '@balo/shared/credit';

/**
 * The ONE discriminant every component switches on, so no component re-derives the state.
 *  - `money`     — finalized, `held` | `no_show_client` (incl. floor applied).
 *  - `zero`      — finalized, `missed_call` | `abandoned_wait`.
 *  - `cancelled` — pending + `context.cancelled` — will NEVER finalize (BAL-441 owner Q1).
 *  - `pending`   — pending, still expected to finalize.
 */
export type StatementMode =
  | { kind: 'money' }
  | { kind: 'zero' }
  | { kind: 'cancelled' }
  | { kind: 'pending' };

interface SessionStatementViewBase {
  sessionId: string;
  mode: StatementMode;
  occurredAtIso: string | null;
  title: string | null;
  counterparty: SessionStatementCounterparty;
  meetingId: string | null;
}

export interface ClientSessionStatementView extends SessionStatementViewBase {
  lens: 'client';
  block: ClientMoneyBlock;
}

export interface ExpertSessionStatementView extends SessionStatementViewBase {
  lens: 'expert';
  block: ExpertMoneyBlock;
  payout: ExpertPayoutReference | null;
}

/**
 * The discriminant is at the TOP level (`lens`), so the expert-only `payout` field is
 * UNREPRESENTABLE on the client arm — the same structural-concealment discipline as the wire
 * type it is built from.
 */
export type SessionStatementView = ClientSessionStatementView | ExpertSessionStatementView;

/** Derive the ONE mode discriminant from the block state + settlement shape + cancellation. */
function deriveStatementMode(
  block: ClientMoneyBlock | ExpertMoneyBlock,
  cancelled: boolean
): StatementMode {
  if (block.state === 'pending') {
    // A cancelled session's billing NEVER finalizes — a `pending` block on a cancelled session
    // must render the terminal zero-money statement rather than a "finalizing…" spinner that
    // polls forever (BAL-441 owner Q1).
    return cancelled ? { kind: 'cancelled' } : { kind: 'pending' };
  }
  if (block.settlementShape === 'missed_call' || block.settlementShape === 'abandoned_wait') {
    return { kind: 'zero' };
  }
  return { kind: 'money' };
}

/** Map the wire `SessionStatement` to the view model, arm-by-arm (never a spread + conditional). */
export function toSessionStatementView(statement: SessionStatement): SessionStatementView {
  const mode = deriveStatementMode(statement.block, statement.context.cancelled);
  const base = {
    sessionId: statement.block.sessionId,
    mode,
    occurredAtIso: statement.context.occurredAtIso,
    title: statement.context.title,
    counterparty: statement.context.counterparty,
    meetingId: statement.context.meetingId,
  };
  if (statement.lens === 'client') {
    return { ...base, lens: 'client', block: statement.block };
  }
  return { ...base, lens: 'expert', block: statement.block, payout: statement.context.payout };
}

/**
 * `true` only for the `money` mode. ONE definition, consumed by the page (render the download
 * link) AND the PDF route (gate the render) — D-C forbids a PDF on zero-money and while
 * pending/cancelled, and a second predicate would let the two drift into a
 * downloadable-but-404 link.
 */
export function isStatementDownloadable(view: SessionStatementView): boolean {
  return view.mode.kind === 'money';
}
