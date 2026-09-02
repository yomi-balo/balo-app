/**
 * BAL-441 — the `GET /sessions/:id/statement` wire types. TYPES ONLY, no runtime code, so this
 * module contributes no uncovered lines to the SonarCloud new-code coverage gate.
 *
 * `packages/shared/src/credit/money-block.ts` is NOT modified by this ticket — not one line
 * (owner decision 3). This is a SEPARATE, allow-listed read that carries the receipt-only
 * CONTEXT (date, subject, counterparty, back-link, payout reference) alongside the existing,
 * unmodified `ClientMoneyBlock` / `ExpertMoneyBlock` money figures. It never touches
 * `money-block.ts` and carries no figure, rate, fee or margin of its own.
 */
import type { ClientMoneyBlock, ExpertMoneyBlock } from './money-block';

/** Who the other side of this session was, already formatted for display. */
export interface SessionStatementCounterparty {
  /**
   * CLIENT lens → the delivering expert PERSON (`Priya Sharma`).
   * EXPERT lens → the client COMPANY (`Northwind Industrial`) — see plan §C3: client-side
   * rights sit on COMPANY membership (CLAUDE.md attribution rule), so there is no single
   * client PERSON to name on the expert's payout page.
   * Never empty; falls back to a humane label, never to an id and NEVER to an email (ADR-1044).
   */
  name: string;
  /**
   * `@ {org}` on first mention. The expert's AGENCY on the client lens (`null` for an
   * independent expert); ALWAYS `null` on the expert lens, where `name` is already the org.
   */
  orgLabel: string | null;
}

/** Fields both lenses carry. `Iso` suffixes are load-bearing: dates cross the wire as strings. */
interface SessionStatementContextBase {
  /** `connectedAt ?? endedAt`, ISO-8601 UTC. `null` when the session never connected. */
  occurredAtIso: string | null;
  /** `case_engagements.title`. `null` ⇒ the page's generic subject line. */
  title: string | null;
  counterparty: SessionStatementCounterparty;
  /** `credit_sessions.meeting_id` — the recap back-link target. `null` ⇒ omit the link. */
  meetingId: string | null;
  /**
   * `credit_sessions.status === 'cancelled'`. A cancelled session NEVER finalizes, so a
   * `pending` block on a cancelled session must render the terminal zero-money statement
   * rather than a "finalizing…" spinner that polls forever.
   */
  cancelled: boolean;
}

export type ClientSessionStatementContext = SessionStatementContextBase;

/** The payout obligation's citable reference. Present only once the obligation is booked. */
export interface ExpertPayoutReference {
  /** `expert_payout_records.id` — verbatim UUID (owner ruling Q2 — no prefix, no truncation). */
  reference: string;
  /** `expert_payout_records.recorded_at`, ISO-8601 UTC. */
  recordedAtIso: string;
}

export interface ExpertSessionStatementContext extends SessionStatementContextBase {
  /** `null` in the real gap between billing finalization and the payout-record write. */
  payout: ExpertPayoutReference | null;
}

/**
 * `GET /sessions/:id/statement`. The lens discriminant is at the TOP level so a route can
 * assert it without reaching into `block`, and the two context shapes are structurally
 * distinct so the expert-only `payout` field is UNREPRESENTABLE on the client arm.
 */
export type SessionStatement =
  | { lens: 'client'; block: ClientMoneyBlock; context: ClientSessionStatementContext }
  | { lens: 'expert'; block: ExpertMoneyBlock; context: ExpertSessionStatementContext };
