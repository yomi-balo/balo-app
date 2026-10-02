import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notExists,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
// BAL-525 — the two pin helpers return partial column assignments containing raw `sql` fragments
// (`now()`, `COALESCE(...)`), which `Partial<NewCreditSession>` cannot express: `$inferInsert`
// types the columns as `Date`/`string`, and only Drizzle's own insert/update value types admit an
// `SQL` in a column position. Write-once must be enforced in SQL, so these are the correct types.
import type { PgInsertValue, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import {
  DEFAULT_OVERDRAFT_CEILING_MINOR,
  LOW_BALANCE_WARNING_MINUTES,
  MAX_SESSION_MINUTES,
  NEAR_WRAP_MINUTES,
  OVERDRAFT_GRACE_MINUTES,
} from '@balo/shared/pricing';
import {
  deriveSessionEstimate,
  isWalletMandateActive,
  minutesOfRunway,
  resolveSessionOverdraftShare,
  walletAllowsOverdraftGrace,
  type CreditSessionOpenedByLabel,
  type SessionOverdraftBasis,
  type SessionOverdraftShare,
} from '@balo/shared/credit';
import { MEETING_CONTEXT_PRECEDENCE, type MeetingContextTypeLabel } from '@balo/shared/meetings';
import { db, type Database } from '../client';
import {
  agencies,
  auditEvents,
  caseEngagements,
  companies,
  creditHolds,
  creditLedger,
  creditReceivables,
  creditSessions,
  creditWallets,
  expertPayoutRecords,
  expertProfiles,
  meetingContexts,
  meetings,
  users,
  type CreditDurationSource,
  type CreditSession,
  type CreditSessionStatus,
  type CreditSettlementShape,
  type CreditSettlementStatus,
  type CreditFinalizationPath,
  type CreditWallet,
  type ExpertProfile,
  type MeetingOutcome,
  type NewCreditSession,
} from '../schema';
import { acquireWalletLock } from './_shared/wallet-lock';
import { deriveIdempotencyKey } from './_shared/credit-idempotency';
import {
  CLIENT_SESSION_MONEY_COLUMNS,
  EXPERT_SESSION_MONEY_COLUMNS,
  type ClientSessionMoneyView,
  type ExpertSessionMoneyView,
} from './_shared/credit-views';
import type { DbExecutor } from './_shared/db-executor';
import { applyLedgerEntry, WalletNotFoundError } from './credit-ledger';
import { creditHoldsRepository } from './credit-holds';
import { creditReceivablesRepository } from './credit-receivables';
import { auditEventsRepository } from './audit-events';
import { meetingsRepository } from './meetings';

/** The audit action + entity type for the expert-always-paid accrual record (ADR-1030). */
export const SESSION_EXPERT_ACCRUED_ACTION = 'credit_session.expert_accrued' as const;
export const SESSION_AUDIT_ENTITY_TYPE = 'credit_session' as const;

/**
 * BAL-412 (ADR-1044 §7) — the presence-settlement audit action. `audit_events.action` and
 * `entity_type` are open `text` (`schema/audit-events.ts`), so this costs NO migration.
 *
 * Written BESIDE `credit_session.expert_accrued` rather than instead of it: the accrual row is
 * the expert-always-paid record BAL-399's durability story reads and must exist on every
 * terminal path, whereas THIS row carries the settlement's own reasoning — the shape, the
 * outcome, the actual-vs-billed split and the floor in force — which is the only durable
 * record of WHY a 6-minute call was charged for 15.
 */
export const SESSION_PRESENCE_SETTLED_ACTION = 'credit_session.presence_settled' as const;

/**
 * BAL-474 (ADR-1040 Amendment 7 §C.3) — the provenance row for a session opened ON BEHALF of the
 * booker (`opened_by` `guest` or `system`). Written by `open()` in the SAME transaction as the
 * session INSERT, `actor_user_id` NULL (a system act — the ADR-1030 exemption), with the booker as
 * `metadata.onBehalfOfUserId`. It is what the ledger ticks' `member_id = booker` attribution rests
 * on: `applyLedgerEntry`'s guard requires a member, and this row records that the member did not act.
 */
export const SESSION_OPENED_ON_BEHALF_ACTION = 'credit_session.opened_on_behalf' as const;

/**
 * BAL-474 (ADR-1040 Amendment 7 §D.3) — the terminal marker that takes an ended, sessionless Case
 * meeting out of the durability backstop's finder FOREVER: `entity_type 'meeting'`,
 * `actor_user_id` NULL, `metadata { disposition, reason, shape?, trigger }`. Written by
 * {@link creditSessionsRepository.markSessionlessCaseMeeting} only.
 */
export const SESSIONLESS_CASE_MEETING_MARKED_ACTION =
  'credit_session.sessionless_meeting_marked' as const;

/**
 * The terminal marker that takes a presence session whose settlement was PERMANENTLY refused (a
 * {@link SettlementRefusedError}) out of the durability backstop's candidate read:
 * `entity_type 'credit_session'`, `entity_id` the session, `actor_user_id` NULL,
 * `metadata { guard, error, meetingId, trigger }`. Append-only; written by
 * {@link creditSessionsRepository.markPresenceSettlementExhausted} only.
 */
export const PRESENCE_SETTLEMENT_EXHAUSTED_ACTION =
  'credit_session.presence_settlement_exhausted' as const;

/**
 * BAL-474 (ADR-1040 Amendment 7 §B) — how `open()` treats the funding gates.
 *
 *   `gated`              — the shipped behaviour, byte-identical: an open receivable, an in-flight
 *                          settlement, a negative balance or an unfunded estimate with no mandate
 *                          each REFUSE. `POST /sessions` (`live_capture`) and every caller that
 *                          passes no policy get this.
 *   `overdraft_tolerant` — every PRESENCE-SEAM open (member admission, guest admission, the
 *                          sessionless terminal-path open): those four gates are recorded as
 *                          {@link OpenToleratedGate}s and the session OPENS, because settlement is
 *                          session-scoped (a session only ever settles its own share) and a refused
 *                          open there means an unbilled consultation. `session_in_progress` and
 *                          `expert_rate_missing` still refuse under both policies.
 */
export type OpenFundingPolicy = 'gated' | 'overdraft_tolerant';

/** A funding gate the overdraft-tolerant open passed THROUGH (logged; audited on on-behalf opens). */
export type OpenToleratedGate =
  | 'account_hold'
  | 'settlement_processing'
  | 'negative_balance'
  | 'insufficient_no_mandate';

/** Thrown when a session lookup targets a missing (or soft-deleted) row. */
export class SessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Credit session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

/** Thrown when a lifecycle transition is not legal from the current status. */
export class InvalidSessionTransitionError extends Error {
  constructor(
    public readonly from: CreditSessionStatus,
    public readonly to: CreditSessionStatus
  ) {
    super(`Invalid credit session transition: ${from} → ${to}`);
    this.name = 'InvalidSessionTransitionError';
  }
}

/**
 * BAL-412 (F2) — thrown by `settleFromPresence` when the row's LIVE `last_tick_seq` no longer
 * matches the `minutesAlreadyDrawn` the caller's arithmetic was computed from.
 *
 * ⚠⚠ THIS IS A TOCTOU GUARD ON A MONEY FIGURE, NOT A DEFENSIVE ASSERTION. The service pre-reads
 * `last_tick_seq` OUTSIDE any transaction to feed `resolveMeetingSettlement`'s
 * `minutesAlreadyDrawn`, and `findMeterable` DELIBERATELY includes `'presence'` (D11) — so the
 * meter sweep is a DESIGNED concurrent writer on exactly that column. If it commits ticks 19-20
 * between the pre-read (18) and this transaction, every figure the caller computed is stale:
 * `connected_minutes` would be written as 18 while the LEDGER holds 20 `session_consume` entries.
 * The ledger is the source of truth (ADR-1040), so the row would CONTRADICT it — the expert would
 * be accrued 18 of a 20-minute draw (breaking "expert always gets paid, no asterisk"), the
 * client's receipt would understate the draw, and Balo would silently keep the delta. Worse, the
 * caller's Q1 `log.error` would fire with the STALE figure and misread as the benign
 * known-limitation case.
 *
 * Throwing (rather than re-deriving here) keeps `settleFromPresence`'s stated property intact —
 * **it does no minute maths of its own** — and is SAFE because it leaves `billing_finalized_at`
 * NULL and the status non-terminal, which is precisely the shape `findPresenceUnsettled` picks
 * up: the durability backstop (§4.3) simply retries against fresh state, and the retry's pre-read
 * sees 20. It converges because F3 stops the meter once the meeting is terminal, so the divergence
 * window is a single bounded hand-off, never a livelock.
 *
 * Same class of divergence — and the same treatment — as the `meetingId` assertion below.
 */
export class SettlementDrawDivergedError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly expectedMinutesAlreadyDrawn: number,
    public readonly actualLastTickSeq: number
  ) {
    super(
      `settleFromPresence: session ${sessionId} was metered concurrently — settlement was computed ` +
        `from minutesAlreadyDrawn=${String(expectedMinutesAlreadyDrawn)} but last_tick_seq is now ` +
        `${String(actualLastTickSeq)}. Nothing was written; retry against fresh state.`
    );
    this.name = 'SettlementDrawDivergedError';
  }
}

/** Which settlement guard refused a figure or an invariant; carried on {@link SettlementRefusedError}. */
export type SettlementRefusalGuard =
  | 'figure_not_integer'
  | 'figure_exceeds_bound'
  | 'meeting_mismatch'
  | 'open_not_from_zero';

/**
 * A PERMANENT settlement refusal: a figure or invariant guard on the presence-settle path tripped,
 * so retrying the same inputs can never succeed. The durability backstop tells it apart from a
 * temporary failure (`SettlementDrawDivergedError`, `SessionNotFoundError`,
 * `InvalidSessionTransitionError`, a DB error) by `instanceof` and writes the exhaustion marker
 * ({@link PRESENCE_SETTLEMENT_EXHAUSTED_ACTION}) instead of retrying forever.
 */
export class SettlementRefusedError extends Error {
  constructor(
    public readonly guard: SettlementRefusalGuard,
    message: string
  ) {
    super(message);
    this.name = 'SettlementRefusedError';
  }
}

/**
 * BAL-399 — thrown by `applyExternalDuration` when a SECOND finalize arrives with a DIFFERENT
 * confirmed `minutes` after duration was already applied (a genuine conflict — two disagreeing
 * confirmations). The in-lock guard has already flipped the session out of the parked state, so
 * this NEVER double-draws; the internal route maps it to 409. A same-value replay is idempotent
 * (no throw).
 */
export class ExternalDurationConflictError extends Error {
  constructor(public readonly sessionId: string) {
    super(`External duration already applied for session ${sessionId} with different minutes`);
    this.name = 'ExternalDurationConflictError';
  }
}

/** Thrown when `open` references an expert profile that does not exist. */
export class ExpertProfileNotFoundError extends Error {
  constructor(public readonly expertProfileId: string) {
    super(`Expert profile not found: ${expertProfileId}`);
    this.name = 'ExpertProfileNotFoundError';
  }
}

// ── Client-lens projection (fee/PII boundary — no RLS, ADR-1040 Decision 4) ──

/**
 * Allow-list of `credit_sessions` columns a CLIENT-bound surface may read. STRUCTURALLY
 * excludes `expertRateMinorPerHour` / `expertRateMinorPerMinute` / `baloFeeBps` /
 * `expertAccruedMinor` (raw expert economics + fee) and `stripePaymentIntentId`
 * (reconciliation). The projection IS the fee boundary since these tables carry no RLS;
 * an invariant test asserts these keys are absent from this set.
 *
 * ⚠ BAL-412 ADDED `actualMinutes` / `billingFloorMinutes` / `settlementShape`, AND THE FEE
 * BOUNDARY IS UNCHANGED BY THAT. All three are DURATIONS AND LABELS, never figures: they
 * appear byte-identically on the client, expert and admin lenses, because "6 minutes
 * delivered, billed at the 15-minute minimum" is a fact both parties are entitled to and
 * neither can difference into a rate, a margin or the fee. The excluded set above is
 * untouched, and the invariant test that asserts those keys are ABSENT still passes.
 */
export const CLIENT_SESSION_VIEW_COLUMNS = {
  id: true,
  walletId: true,
  companyId: true,
  expertProfileId: true,
  initiatingMemberId: true,
  holdId: true,
  status: true,
  settlementStatus: true,
  durationSource: true,
  estimatedMinutes: true,
  clientRateMinorPerMinute: true,
  effectiveCeilingMinor: true,
  graceBoundMinutes: true,
  connectedAt: true,
  lastTickSeq: true,
  connectedMinutes: true,
  lowWarnedAt: true,
  graceEnteredAt: true,
  nearWrapWarnedAt: true,
  wrappedAt: true,
  endedAt: true,
  settledAt: true,
  overdraftSettledMinor: true,
  // BAL-412 — durations + label, fee-safe (see the docblock). NULL on every legacy row.
  actualMinutes: true,
  billingFloorMinutes: true,
  settlementShape: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** The PII/fee-safe session shape a client surface may render (drives `deriveDrawdownState`). */
export type ClientSessionView = Pick<CreditSession, keyof typeof CLIENT_SESSION_VIEW_COLUMNS>;

// ── Method IO types ──────────────────────────────────────────────────────

export interface OpenSessionInput {
  walletId: string;
  companyId: string;
  expertProfileId: string;
  initiatingMemberId: string;
  estimatedMinutes: number;
  /** Fee snapshot; defaults to `DEFAULT_BALO_FEE_BPS` (BAL-378 Decision Q4). */
  baloFeeBps?: number;
  /**
   * BAL-418 seam (ADR-1045 §3) — the meeting this session bills, and the DENORMALISED
   * engagement. Written HERE, at `open` (inside the wallet advisory lock) and NOWHERE
   * ELSE: no UPDATE path touches either column, so this call site is the ONLY place their
   * coherence can be established. Leaving them to a later `UPDATE` would additionally be a
   * SECOND write on the money path, OUTSIDE that lock.
   *
   * BOTH OPTIONAL, and their NULLABILITY is independent — a `duration_source='external'`
   * session is a real consultation on an outside tool with an engagement and NO Balo
   * meeting, and every session written today passes neither.
   *
   * ⚠ THEIR VALUES ARE NOT INDEPENDENT. When BOTH are supplied they MUST come from ONE
   * resolution: `engagementId` must be the engagement reachable from `meetingId` via
   * `meeting_contexts`, and `companyId`/`expertProfileId` must be that engagement's
   * parties. Nothing here can check it — the predicate is cross-table and cannot be a CHECK,
   * an FK, or (by house style) a repository gate; the full ruling is on
   * `schema/credit-sessions.ts`. A divergent pair bills one engagement while BAL-425's
   * sweep, which resolves through the seam, ages out another.
   *
   * ⚠ SUPERSEDED. BAL-400 (booking) was the recorded intent and is NOT the seam. **BAL-466**
   * opens the session at ADMISSION — `joinMeetingAsMember`, first CLIENT-side member, `case`
   * contexts only — and passes `meetingId` + `engagementId` + `durationSource: 'presence'`
   * from there. **BAL-474** adds two more presence-seam openers that pass the same three: a
   * client-side email-invited GUEST's admission, and the SESSIONLESS terminal-path open
   * (`openAndSettleFromPresence`), both on behalf of the booker. `book-consultation.ts`'s "THE
   * MONEY IS OUT OF SCOPE" stays true. **BAL-412** and reporting consume `engagement_id` as given.
   *
   * ⚠ BAL-474 (AD-4) — `meetingId` IS ALSO THE KEY OF THE IN-LOCK "never two sessions per
   * meeting" check (`open()` step 1b): a second open for a meeting that already has a live
   * (non-cancelled, ENDED OR NOT) session is refused `meeting_session_exists`.
   */
  meetingId?: string | null;
  engagementId?: string | null;
  /**
   * BAL-412 seam (D11) — how this session's billable duration will be established. Defaults
   * to `'live_capture'`, which is exactly what every shipped caller gets today.
   *
   * ⚠ SUPERSEDED. BAL-400 (booking) was the recorded intent and is NOT the seam. **BAL-466**
   * opens the session at ADMISSION — `joinMeetingAsMember`, first CLIENT-side member, `case`
   * contexts only — and passes `meetingId` + `engagementId` + `durationSource: 'presence'`
   * from there. `book-consultation.ts`'s "THE MONEY IS OUT OF SCOPE" stays true. `'presence'`
   * is the enabling condition for the entire settlement engine below — `settleFromPresence`,
   * `findPresenceUnsettled` and the widened `findMeterable`.
   *
   * ⚠ WRITE-ONCE, at `open`, inside the wallet advisory lock — like `meetingId` /
   * `engagementId` and for the same reason. NO UPDATE path anywhere sets it, so a session
   * cannot change provenance mid-life and have its terminal figure fixed by the wrong rule.
   *
   * ⚠ A `'presence'` SESSION SHOULD ALWAYS CARRY A `meetingId` — its settlement reads
   * `meeting_presence`, which is meeting-grained. That coherence is NOT enforced here, for
   * exactly the reason the meeting/engagement coherence is not (see the ruling on
   * `schema/credit-sessions.ts`): the predicate is cross-column policy, not a constraint the
   * database can state, and this repository does not gate. `findPresenceUnsettled` requires
   * `meeting_id IS NOT NULL` by construction, so a meeting-less `presence` session is simply
   * never settled by the backstop — it would sit unsettled and visible, rather than settle
   * wrongly. The obligation was BAL-466's, and BAL-466 discharges it: `joinMeetingAsMember`
   * passes `durationSource: 'presence'` alongside `meetingId`/`engagementId`. BAL-474's two new
   * openers (guest admission, the sessionless terminal-path open) pass it too — and for an
   * `overdraft_tolerant` open the coherence IS asserted, in-process (`assertOpenPolicyCoherent`),
   * because tolerance is only safe on the presence-settled, session-scoped path.
   */
  durationSource?: CreditDurationSource;
  /**
   * BAL-474 (ADR-1040 Amendment 7 §B) — how the funding gates are treated. Omitted ⇒ `'gated'`,
   * byte-identical to every shipped caller. See {@link OpenFundingPolicy}.
   */
  fundingPolicy?: OpenFundingPolicy;
  /**
   * BAL-474 (AD-5) — who opened the session; write-once into `credit_sessions.opened_by`.
   * Omitted ⇒ `'client'`. `'guest'` / `'system'` mean ON BEHALF of the booker: then
   * `initiatingMemberId` IS the booker (attribution only — D4), and `open()` writes a
   * `credit_session.opened_on_behalf` audit row in the same transaction.
   */
  openedBy?: CreditSessionOpenedByLabel;
  /** BAL-474 — the admitted client-side guest whose admission opened the session (`openedBy: 'guest'` only). */
  meetingGuestId?: string | null;
  /** BAL-474 — AUDIT ONLY: which path opened an on-behalf session (e.g. the terminal path's trigger). */
  trigger?: string;
}

/**
 * `open` outcome. Money-gate rejections (`account_hold` / `settlement_pending` /
 * `insufficient_no_mandate`), the one-live-session-per-wallet stop (`session_in_progress`), the
 * rate-less-expert stop (`expert_rate_missing`, Decision Q9) and the one-session-per-meeting stop
 * (`meeting_session_exists`, BAL-474 AD-4) are EXPECTED control flow returned as a discriminated
 * union — the service maps them, never catches them.
 *
 * ⚠ BAL-474 — THE THREE MONEY-GATE CODES ARE THE GATED OPEN'S ONLY. The overdraft-tolerant open
 * (every presence-seam open) passes through them and reports them in `toleratedGates` instead.
 *
 * `settlement_pending` (gated) blocks a NEW session while a PRIOR session's overdraft settlement
 * has not yet landed (`settlementStatus='processing'`) or while the wallet balance is negative. The
 * original reason — a prior overdraft folded into the next session's terminal figure and charged a
 * SECOND time (the sequential co-charge) — is now closed by the arithmetic itself: every terminal
 * settles only its OWN share (`resolveSessionOverdraftShare`, ADR-1040 Amendment 7 §A), which is
 * what makes tolerating it safe. The gated open keeps it for `POST /sessions`, unchanged.
 *
 * `insufficient_no_mandate` means exactly what it says — the estimate is unfunded and the wallet
 * carries no active mandate. BAL-523 deliberately did NOT widen it to cover `low_balance_mode`
 * (see the ⚠ note on `open` itself).
 *
 * `meeting_session_exists` names the meeting's existing live session (non-cancelled, ENDED OR
 * NOT), so a terminal path that lost the race settles THAT session instead of opening a second.
 */
export type OpenSessionResult =
  | { ok: true; session: CreditSession; toleratedGates: readonly OpenToleratedGate[] }
  | { ok: false; code: 'meeting_session_exists'; existingSessionId: string }
  | {
      ok: false;
      code:
        | 'account_hold'
        | 'session_in_progress'
        | 'settlement_pending'
        | 'insufficient_no_mandate'
        | 'expert_rate_missing';
    };

/** The NEWLY-crossed transitions a meter tick pass produced (the caller publishes on these). */
export interface MeterTransitions {
  /** Pre-zero low-balance warning fired for the first time. */
  low?: boolean;
  /** Session moved active → grace (card-backed overdraft opened). */
  graceEntered?: boolean;
  /** Approaching-wrap warning fired for the first time. */
  nearWrap?: boolean;
  /** Session moved to `wrapped` (the one warm pause). */
  wrapped?: boolean;
  /** The wrap was caused by hitting the overdraft ceiling (vs the 30-min / no-mandate bound). */
  ceilingHit?: boolean;
  /**
   * The meter just reached `MAX_SESSION_MINUTES` and will draw no further tick: a backfill past
   * the ceiling (any provenance) or a `presence` session reaching it (its meeting outlives the
   * meter). Set by exactly ONE committed run; every later run hits the early return.
   */
  maxSessionMinutesReached?: {
    /** `elapsed − MAX_SESSION_MINUTES` (≥ 0): the ticks the clamp declined to post. */
    withheldTicks: number;
    /**
     * `presence`: whether the meeting's `scheduled_end` had passed (`false` = a long booking that
     * legitimately reached the billable cap). `live_capture`, or a presence session with no
     * readable meeting: `null`.
     */
    pastScheduledEnd: boolean | null;
  };
}

export interface MeterSessionResult {
  session: CreditSession;
  transitions: MeterTransitions;
  /** How many `session_consume` ticks were newly posted this pass. */
  ticksPosted: number;
}

export interface EndSessionResult {
  session: CreditSession;
  /**
   * THIS session's share of the wallet's negative balance at its terminal — the settlement basis;
   * 0 when in credit. NEVER debt older than the session (ADR-1040 Amendment 7 §A:
   * `min(ownConsumed, max(0, −balance))`); identical to the whole negative balance on every state
   * the gated open can reach.
   */
  overdraftMinor: number;
  /**
   * BAL-474 (D7.3) — how {@link overdraftMinor} was reached, plus the ownerless-debt reading taken
   * INSIDE the terminal transaction. `null` on the idempotent re-end — nothing was computed.
   */
  overdraftBasis: SessionOverdraftBasis | null;
  /** Finalized expert accrual (recorded independent of settlement). */
  expertAccruedMinor: number;
  /** Whether an active mandate exists (the service decides charge vs immediate receivable). */
  mandateActive: boolean;
  /** `true` when the session was already `ended` (idempotent re-end — no side effects). */
  alreadyEnded: boolean;
}

/**
 * BAL-421 — the ENGAGEMENT-GRAIN expert-earnings aggregate for ONE case, as a
 * DISCRIMINATED UNION rather than a flat `{count, count, number}` triple.
 *
 * ⚠⚠ THE UNION IS THE POINT: "NO DATA" AND "A$0.00" MUST NOT BE THE SAME VALUE.
 *
 * ⚠⚠ BAL-466 (F9, review fix round) — CORRECTING A NOW-FALSE CLAIM. This used to say "nothing
 * writes `credit_sessions.engagement_id` today… so EVERY case aggregates to `not_yet`" — true
 * on `main` before this PR, false as of it: `openSession` (`open-session.ts:192-194`) spreads
 * `{ meetingId, engagementId }` on every session the admission seam opens
 * (`joinMeetingAsMember`, D1), so a `pending` block is reachable the moment a client is admitted
 * to a Case call, and `finalized` the moment settlement runs. This IS a fourth money surface
 * going live with BAL-466 — named in the PR body — not a hypothetical future state. `not_yet`
 * remains correct for every case with NO admitted client, which is still the common case today.
 * If a `pending`/`finalized` result carried `earningsAudMinor: 0`, the case surface would render
 * "A$0.00" — a MONEY CLAIM — for every expert on the platform, and no amount of downstream care
 * could tell it apart from a genuinely-zero finalized session. Here the figure is STRUCTURALLY
 * UNREPRESENTABLE until something has actually finalized: `not_yet` and `pending` cannot HOLD a
 * number, so the surface is forced to render its designed empty/pending copy instead of a
 * fabricated zero.
 *
 * A `finalized` block CAN legitimately be `0` (a finalized session with zero connected
 * minutes). That is a REAL zero, and it is the reason the three states must stay distinct.
 *
 * ⚠ FEE CONCEALMENT (hard invariant, ADR-1040 Decision 4 / BAL-399). This is the
 * EXPERT-side aggregate and carries own-earnings only. There is deliberately NO key here
 * for the client rate, the all-in client charge, `baloFeeBps`, the margin, or
 * `overdraftSettledMinor` — and none is DERIVABLE from what is returned, because the sum
 * is over `expert_accrued_minor` (the RAW, un-marked-up accrual) with no companion figure
 * to difference it against. Mirrors `EXPERT_SESSION_MONEY_COLUMNS` /
 * `buildExpertMoneyBlock`. Do not add a client or admin figure to this shape; the ADMIN
 * lens is `findForAdminView`, per session, and stays that way.
 */
export type CaseExpertEarningsAggregate =
  | {
      /** No session on this engagement at all — render the "not yet" copy, NEVER a figure. */
      readonly state: 'not_yet';
      readonly finalizedSessionCount: 0;
      readonly pendingSessionCount: 0;
      readonly earningsAudMinor: null;
    }
  | {
      /** Sessions exist but none has finalized — "{n} still being finalised", NO figure. */
      readonly state: 'pending';
      readonly finalizedSessionCount: 0;
      readonly pendingSessionCount: number;
      readonly earningsAudMinor: null;
    }
  | {
      /** At least one finalized session — the ONLY state carrying a figure. AUD minor units. */
      readonly state: 'finalized';
      readonly finalizedSessionCount: number;
      readonly pendingSessionCount: number;
      readonly earningsAudMinor: number;
    };

export interface MarkSettlementResultInput {
  sessionId: string;
  status: Extract<CreditSettlementStatus, 'processing' | 'settled' | 'failed' | 'requires_action'>;
  /** The settlement PaymentIntent (reconciliation). */
  stripePaymentIntentId?: string | null;
  now?: Date;
}

// ── BAL-412 (ADR-1044 §7) — presence settlement IO ───────────────────────────

/**
 * Everything `settleFromPresence` writes, PRE-COMPUTED.
 *
 * ⚠⚠ **ALL ARITHMETIC ARRIVES FROM THE CALLER. THIS METHOD DOES NO MINUTE MATHS OF ITS OWN.**
 * The floor rule, the four shapes, the D4 clock-start clamp and the no-refund clamp all live
 * in ONE pure function (`resolveMeetingSettlement`, `@balo/shared/credit`), which the
 * invariant suite and the service both reach. Deriving any of it a second time here is how
 * the two definitions drift, and a drifted money rule is only discoverable from an invoice.
 */
export interface SettleFromPresenceRepoInput {
  readonly sessionId: string;
  /** The meeting whose presence rows produced these figures — for the outcome write + audit. */
  readonly meetingId: string;
  /** THE SETTLED FIGURE. The client charge AND the expert accrual both derive from this ONE number. */
  readonly billableMinutes: number;
  /** Minutes ACTUALLY delivered (D4-clamped expert-present clock, ceil'd, PRE-floor). */
  readonly actualMinutes: number;
  /** The floor IN FORCE at settlement, whole minutes — snapshotted, never re-derived later. */
  readonly billingFloorMinutes: number;
  /** First `session_consume` tick seq to post (`minutesAlreadyDrawn + 1`). */
  readonly topUpFromTickSeq: number;
  /** Last tick seq to post. `< topUpFromTickSeq` ⇒ post NOTHING (both zero shapes, and a replay). */
  readonly topUpToTickSeq: number;
  /**
   * BAL-412 (F2) — `credit_sessions.last_tick_seq` AS THE CALLER READ IT, i.e. the exact
   * `minutesAlreadyDrawn` every figure above was computed from.
   *
   * ⚠⚠ IT IS NOT A CONVENIENCE COPY OF `topUpFromTickSeq - 1`. It is the TOCTOU ANCHOR: this
   * method re-reads the row FOR UPDATE and refuses to write if the live `last_tick_seq` has moved
   * (see {@link SettlementDrawDivergedError}). `findMeterable` includes `'presence'` by design,
   * so a concurrent meter tick between the caller's pre-read and this transaction is an EXPECTED
   * event, not a corruption — but settling on the stale figure would put `connected_minutes` in
   * contradiction with the append-only ledger. Passed EXPLICITLY rather than derived so the
   * comparison reads as the deliberate assertion it is.
   */
  readonly minutesAlreadyDrawn: number;
  readonly shape: CreditSettlementShape;
  /**
   * BAL-412 (F14) — `true` when the BILLING FLOOR is what fixed `billableMinutes`.
   *
   * ⚠⚠ IT ARRIVES FROM THE CALLER AND IS **NOT** RE-DERIVED HERE AS
   * `billableMinutes > actualMinutes`. Those two are NOT the same predicate. The pure core
   * (`resolveMeetingSettlement`) defines it as `no_show_client || ruleMinutes > actualMinutes` —
   * deliberately FALSE when it was the Q1 NO-REFUND CLAMP, not the floor, that raised the figure,
   * and deliberately TRUE on a no-show, where the floor is FLATLY the whole charge (R1, owner
   * ruling 2026-08-21) and the billed figure therefore sits BELOW actual. Re-deriving it from
   * `billableMinutes` (which is post-clamp) gets BOTH of those backwards, and
   * `credit_session.presence_settled` is the ONLY durable forensic record of that overcharge.
   * Persisted so `finalizeBilling`'s `floored:` analytics — the "how often does the minimum bind"
   * metric — and (since R2) the recap money block all read the real answer instead of each
   * re-deriving the same wrong one.
   */
  readonly floorApplied: boolean;
  /**
   * The `meetings.outcome` label to resolve, written ONLY if still NULL.
   *
   * ⚠ `abandoned_wait` ARRIVES HERE AS `'completed'`, and that is deliberate (D2/D3): BAL-412
   * mints NO fourth `meeting_outcome` value, so the expert who waited and left below the floor
   * lands as `completed` with a ZERO settlement. `shape` is what keeps the two zero cases
   * distinguishable afterwards — read `settlement_shape`, never `outcome`, to tell them apart.
   */
  readonly outcome: MeetingOutcome;
  /** ADR-1030 attribution. `null` on the sweep/system path (the system-actor exemption). */
  readonly actorUserId: string | null;
  readonly now: Date;
}

export interface SettleFromPresenceRepoResult {
  session: CreditSession;
  /**
   * THIS session's share of the wallet's negative balance at its terminal — the settlement basis;
   * 0 when in credit. NEVER debt older than the session (ADR-1040 Amendment 7 §A).
   */
  overdraftMinor: number;
  /**
   * BAL-474 (D7.3) — the share's figures plus the ownerless-debt reading taken INSIDE the terminal
   * transaction, after the terminal UPDATE. `null` on the idempotent `alreadySettled` arm.
   */
  overdraftBasis: SessionOverdraftBasis | null;
  /** Finalized expert accrual = the SETTLED billable minutes × the raw expert rate. */
  expertAccruedMinor: number;
  /** Whether an active mandate exists (the service decides charge vs immediate receivable). */
  mandateActive: boolean;
  /** `true` ⇒ already settled (or already `ended`): NO side effects were produced. */
  alreadySettled: boolean;
  /** How many `session_consume` ticks this call NEWLY posted (dedups excluded). */
  ticksPosted: number;
  /** `true` ⇒ this call resolved `meetings.outcome`; `false` ⇒ it was already resolved. */
  outcomeWritten: boolean;
}

/**
 * The statuses `settleFromPresence` may transition to `ended` from.
 *
 * ⚠ WIDER THAN `end()`'s (`active | grace | wrapped`) BY `pending`, AND THAT IS THE WHOLE
 * NO-SHOW CASE. Nothing calls `connect` when the client never arrives, so the session is
 * still `pending` when its meeting terminates. Declared here, once, so the widening reads as
 * a decision rather than as a missing guard.
 */
const SETTLE_FROM_PRESENCE_FROM: readonly CreditSessionStatus[] = [
  'pending',
  'active',
  'grace',
  'wrapped',
];

// ── BAL-474 (ADR-1040 Amendment 7 §C/§D) — the sessionless Case meeting IO ───────────────────

/**
 * {@link creditSessionsRepository.openAndSettleFromPresence}'s input: the ON-BEHALF open of a
 * sessionless ended Case meeting and its presence settlement, in ONE transaction (AD-3). The type
 * pins what only a terminal path may pass — the tolerant policy, `openedBy: 'system'`, the presence
 * provenance, and the meeting + engagement the session bills.
 */
export interface OpenAndSettleFromPresenceInput {
  readonly open: OpenSessionInput & {
    readonly meetingId: string;
    readonly engagementId: string;
    readonly durationSource: 'presence';
    readonly fundingPolicy: 'overdraft_tolerant';
    readonly openedBy: 'system';
  };
  /** Every settlement figure, PRE-COMPUTED by the pure core — exactly as `settleFromPresence`. */
  readonly settlement: Omit<SettleFromPresenceRepoInput, 'sessionId' | 'meetingId'>;
}

export type OpenAndSettleFromPresenceResult =
  | {
      ok: true;
      toleratedGates: readonly OpenToleratedGate[];
      settled: SettleFromPresenceRepoResult;
    }
  | Extract<OpenSessionResult, { ok: false }>;

/** One row of {@link creditSessionsRepository.findSessionlessEndedCaseMeetings}. */
export interface SessionlessCaseMeetingCandidate {
  readonly meetingId: string;
  readonly scheduledStart: Date;
  readonly endedAt: Date;
}

/**
 * The terminal marker's disposition and reason (ADR-1040 Amendment 7 §D.3). A discriminated union
 * so a reason can only ever be written under its own disposition.
 *
 *   `not_billable`    — nothing is owed: a zero presence shape, the D5.9 skip (the only
 *                       client-party attendee was a guest the delivering expert invited), or a
 *                       case the client closed BEFORE the meeting's scheduled start (D10.5).
 *   `refused`         — a billable shape the terminal path cannot open: no coherent Case
 *                       engagement, no attributable booker, or no expert rate. Alarmed.
 *   `retry_exhausted` — still sessionless on the first attempt past the retry window. Alarmed.
 */
export type SessionlessCaseMeetingMark =
  | {
      readonly disposition: 'not_billable';
      readonly reason:
        | 'missed_call'
        | 'abandoned_wait'
        | 'expert_invited_guest_only'
        | 'case_closed_before_start';
    }
  | {
      readonly disposition: 'refused';
      readonly reason: 'meeting_not_bookable' | 'booker_unattributable' | 'expert_rate_missing';
    }
  | {
      readonly disposition: 'retry_exhausted';
      readonly reason: 'session_in_progress' | 'error';
    };

export type MarkSessionlessCaseMeetingInput = SessionlessCaseMeetingMark & {
  readonly meetingId: string;
  /** Which terminal path wrote the marker (the service's trigger label). */
  readonly trigger: string;
  /** The presence settlement shape, when it was computed (always, on the service's path). */
  readonly shape?: CreditSettlementShape;
  /**
   * The `meetings.outcome` a settlement would have resolved, written FIRST-WRITE-WINS in the SAME
   * transaction as the marker (D5.4) — never outside it.
   */
  readonly outcome?: MeetingOutcome;
};

export interface MarkSessionlessCaseMeetingResult {
  readonly markerId: string;
  /** `true` ⇒ this call resolved `meetings.outcome`; `false` ⇒ not given, or already resolved. */
  readonly outcomeWritten: boolean;
}

/**
 * The context labels in the TOP precedence tier — DERIVED from `MEETING_CONTEXT_PRECEDENCE`,
 * never restated, so the backstop finder's SQL mirror of `selectPrimaryMeetingContext` moves with
 * the pure rule. `case` is in this tier (engagement grain, score 100).
 */
const TOP_TIER_CONTEXT_TYPES: readonly MeetingContextTypeLabel[] = (() => {
  const labels = Object.keys(MEETING_CONTEXT_PRECEDENCE) as MeetingContextTypeLabel[];
  const topScore = Math.max(...labels.map((label) => MEETING_CONTEXT_PRECEDENCE[label]));
  return labels.filter((label) => MEETING_CONTEXT_PRECEDENCE[label] === topScore);
})();

/**
 * BAL-474 (ADR-1040 Amendment 7 §B) — reject an incoherent open BEFORE any transaction opens. A
 * PROGRAMMING error, never a runtime condition, so it throws:
 *
 *   · tolerant ⇒ `durationSource: 'presence'` with a `meetingId` — tolerance is safe only on the
 *     presence-settled, session-scoped path (`POST /sessions` must stay gated);
 *   · on behalf (`openedBy` ≠ `client`) ⇒ tolerant, with a `meetingId` and an `engagementId` —
 *     an on-behalf open only ever bills a Case meeting's presence;
 *   · a `meetingGuestId` ⇒ `openedBy: 'guest'`.
 */
function assertOpenPolicyCoherent(input: OpenSessionInput): void {
  const tolerant = input.fundingPolicy === 'overdraft_tolerant';
  const hasMeeting = input.meetingId !== undefined && input.meetingId !== null;
  const hasEngagement = input.engagementId !== undefined && input.engagementId !== null;
  if (tolerant && (input.durationSource !== 'presence' || !hasMeeting)) {
    throw new Error(
      'creditSessionsRepository.open: an overdraft_tolerant open must be a presence session bound to a meeting'
    );
  }
  const openedBy = input.openedBy ?? 'client';
  if (openedBy !== 'client' && (!tolerant || !hasMeeting || !hasEngagement)) {
    throw new Error(
      `creditSessionsRepository.open: an on-behalf open (openedBy '${openedBy}') must be overdraft_tolerant with a meetingId and an engagementId`
    );
  }
  if (input.meetingGuestId !== undefined && input.meetingGuestId !== null && openedBy !== 'guest') {
    throw new Error("creditSessionsRepository.open: a meetingGuestId requires openedBy 'guest'");
  }
}

/**
 * Reject a settlement input that is not whole, finite and non-negative BEFORE anything is
 * written. Not arithmetic — a domain guard on the ONE seam where a bad number becomes a
 * charge. A fractional `billableMinutes` would silently truncate into `connected_minutes`
 * (an `integer` column) and disagree with the ledger; a negative `topUpToTickSeq` is
 * harmless (the loop is empty) but is evidence the caller's maths broke, and a money path
 * should fail loudly on evidence rather than post a plausible amount.
 *
 * `ruleMinutes` is capped by the pure core (`resolveMeetingSettlement` takes a required
 * `maxBillableMinutes`). `billableMinutes`, `actualMinutes` and `topUpToTickSeq` are deliberately
 * UNBOUNDED here: they carry what the meter already drew, so anything the meter posted can settle
 * and be billed in full; the `meterSessionToNow` clamp keeps every new session at or below
 * `MAX_SESSION_MINUTES`.
 *
 * ⚠ `billingFloorMinutes` stays bounded (F5): the floor is a MONEY input — an operator who set
 * `MEETING_NO_SHOW_FLOOR_MINUTES=900` thinking seconds would make every no-show settle at 900
 * minutes. `apps/api`'s `resolveBillingFloorMs` discards such an override at the config seam; this
 * refuses it even from a caller that does not.
 *
 * Every refusal is a {@link SettlementRefusedError}: the same inputs can never succeed.
 */
function assertSettlementFigures(
  input: Omit<SettleFromPresenceRepoInput, 'sessionId' | 'meetingId'>
): void {
  const figures: ReadonlyArray<readonly [string, number]> = [
    ['billableMinutes', input.billableMinutes],
    ['actualMinutes', input.actualMinutes],
    ['billingFloorMinutes', input.billingFloorMinutes],
    ['topUpFromTickSeq', input.topUpFromTickSeq],
    // F2 — the TOCTOU anchor is a figure like any other: a fractional or negative
    // `minutesAlreadyDrawn` could never equal an integer `last_tick_seq`, so the divergence
    // check below would throw the WRONG error and read as a race that never happened.
    ['minutesAlreadyDrawn', input.minutesAlreadyDrawn],
  ];
  for (const [name, value] of figures) {
    if (!Number.isInteger(value) || value < 0) {
      throw new SettlementRefusedError(
        'figure_not_integer',
        `settleFromPresence: ${name} must be a non-negative integer (received ${String(value)})`
      );
    }
  }
  if (!Number.isInteger(input.topUpToTickSeq)) {
    throw new SettlementRefusedError(
      'figure_not_integer',
      `settleFromPresence: topUpToTickSeq must be an integer (received ${String(input.topUpToTickSeq)})`
    );
  }
  if (input.billingFloorMinutes > MAX_SESSION_MINUTES) {
    throw new SettlementRefusedError(
      'figure_exceeds_bound',
      `settleFromPresence: billingFloorMinutes must not exceed MAX_SESSION_MINUTES (${String(MAX_SESSION_MINUTES)}) — received ${String(input.billingFloorMinutes)}.`
    );
  }
}

/** The shared `WHERE` terms of the presence-unsettled reads (see `findPresenceUnsettled`). */
function presenceUnsettledTerms(cutoff: Date): SQL | undefined {
  return and(
    // Enum literals at QUERY time are always safe (the ADD-VALUE restriction is index
    // predicates + CHECKs).
    eq(creditSessions.durationSource, 'presence'),
    isNull(creditSessions.billingFinalizedAt),
    ne(creditSessions.status, 'cancelled'),
    isNull(creditSessions.deletedAt),
    eq(meetings.status, 'ended'),
    lte(meetings.endedAt, cutoff),
    isNull(meetings.deletedAt)
  );
}

/** Whether `now` is at or past the meeting's `scheduled_end`; null when the meeting is unreadable. */
async function readPastScheduledEnd(
  exec: DbExecutor,
  meetingId: string | null,
  now: Date
): Promise<boolean | null> {
  if (meetingId === null) {
    return null;
  }
  const [row] = await exec
    .select({ scheduledEnd: meetings.scheduledEnd })
    .from(meetings)
    .where(eq(meetings.id, meetingId));
  return row === undefined ? null : now.getTime() >= row.scheduledEnd.getTime();
}

/** The correlated sub-select matching a session's {@link PRESENCE_SETTLEMENT_EXHAUSTED_ACTION} marker. */
function exhaustionMarkerFor() {
  return db
    .select({ one: sql`1` })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityType, SESSION_AUDIT_ENTITY_TYPE),
        eq(auditEvents.entityId, creditSessions.id),
        eq(auditEvents.action, PRESENCE_SETTLEMENT_EXHAUSTED_ACTION)
      )
    );
}

/** Oldest-ended-first, batch-bounded read over {@link presenceUnsettledTerms} plus any extra term. */
async function selectPresenceUnsettled(
  where: SQL | undefined,
  limit: number
): Promise<CreditSession[]> {
  const rows = await db
    .select({ session: creditSessions })
    .from(creditSessions)
    .innerJoin(meetings, eq(meetings.id, creditSessions.meetingId))
    .where(where)
    .orderBy(asc(meetings.endedAt), asc(creditSessions.id))
    .limit(limit);
  return rows.map((row) => row.session);
}

// ── Internal helpers ──────────────────────────────────────────────────────

/** Read a live session row FOR UPDATE (excludes soft-deleted). */
async function readSessionForUpdate(
  exec: DbExecutor,
  id: string
): Promise<CreditSession | undefined> {
  const [row] = await exec
    .select()
    .from(creditSessions)
    .where(and(eq(creditSessions.id, id), isNull(creditSessions.deletedAt)))
    .for('update');
  return row;
}

/** Read the wallet or throw `WalletNotFoundError` (reuses the ledger primitive's error). */
async function readWalletOrThrow(exec: DbExecutor, walletId: string): Promise<CreditWallet> {
  const [wallet] = await exec
    .select()
    .from(creditWallets)
    .where(eq(creditWallets.id, walletId))
    .limit(1);
  if (wallet === undefined) {
    throw new WalletNotFoundError(walletId);
  }
  return wallet;
}

/** `SUM(amount_minor)` over a wallet's ACTIVE, non-deleted holds, on the given executor. */
async function activeHoldsSum(exec: DbExecutor, walletId: string): Promise<number> {
  const [row] = await exec
    .select({ sum: sql<string>`coalesce(sum(${creditHolds.amountMinor}), 0)` })
    .from(creditHolds)
    .where(
      and(
        eq(creditHolds.walletId, walletId),
        eq(creditHolds.status, 'active'),
        isNull(creditHolds.deletedAt)
      )
    );
  return Number(row?.sum ?? 0);
}

/**
 * BAL-474 (ADR-1040 Amendment 7 §A) — THE ONE READ behind a terminal's settled figure: THIS
 * session's gross `session_consume` on its wallet (rides `credit_ledger_session_idx`), handed with
 * the wallet balance read under the lock to the pure `resolveSessionOverdraftShare`. Exactly two
 * callers — `end()` and `settleFromPresenceInTx` — pinned by
 * `invariants/a-session-never-settles-debt-it-did-not-incur.test.ts`.
 *
 * Only `session_consume` counts: there is no reversal of it (the ledger is append-only, no refund
 * primitive), and the session's own `overdraft_settlement` credit — which also carries its
 * `session_id` — is excluded by the reason filter. Written with `eq(…reason…)`, never the
 * object-key form the BAL-525 drift alarm counts.
 */
async function readSessionOverdraftShare(
  tx: DbExecutor,
  session: CreditSession,
  wallet: CreditWallet
): Promise<SessionOverdraftShare> {
  const [row] = await tx
    .select({ sum: sql<string>`coalesce(sum(${creditLedger.amountMinor}), 0)` })
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.sessionId, session.id),
        eq(creditLedger.walletId, wallet.id),
        eq(creditLedger.reason, 'session_consume')
      )
    );
  const consumedSum = Number(row?.sum ?? 0);
  return resolveSessionOverdraftShare({
    walletBalanceMinor: wallet.balanceMinor,
    ownConsumedMinor: Math.max(0, -consumedSum),
  });
}

/**
 * BAL-474 (D7.3, ADR-1040 Amendment 7 §A property 4) — NO DEBT WITHOUT AN OWNER. The older debt a
 * terminal leaves unsettled (`priorDebtLeftMinor`) must be accounted for by ANOTHER session: an
 * open receivable, or an in-flight (`processing`) settlement whose credit has not yet landed. This
 * returns the part of it nobody owns — `max(0, priorDebtLeft − Σ those owners' amounts)`.
 *
 * ⚠ RUNS INSIDE THE TERMINAL TRANSACTION, UNDER THE WALLET LOCK, AFTER THE SESSION'S OWN TERMINAL
 * UPDATE — so the settling session's own row is already `processing`, and the two `<> S`
 * exclusions below carry real weight (without them S's own charge would "own" the older debt).
 * Plain SELECTs: it row-locks nothing (see `openAndSettleFromPresence`'s lock-order note).
 *
 * ⚠ AMOUNTS, NOT COUNTS: partial top-ups pay debt down without closing receivables, so recorded
 * owners only ever meet or exceed the older debt they own — a shortfall is real. The known limit:
 * an ownerless slice hidden behind a larger, partly-paid open receivable is invisible to an amount
 * comparison; the coverage clears themselves are guarded by their own invariants.
 *
 * Short-circuits to 0 — no query — when there is no older debt at all (the overwhelmingly common
 * case).
 */
async function readOwnerlessPriorDebt(
  tx: DbExecutor,
  input: { walletId: string; sessionId: string; priorDebtLeftMinor: number }
): Promise<number> {
  if (input.priorDebtLeftMinor === 0) {
    return 0;
  }
  const [receivables] = await tx
    .select({ sum: sql<string>`coalesce(sum(${creditReceivables.amountMinor}), 0)` })
    .from(creditReceivables)
    .where(
      and(
        eq(creditReceivables.walletId, input.walletId),
        eq(creditReceivables.status, 'open'),
        isNull(creditReceivables.deletedAt),
        ne(creditReceivables.sessionId, input.sessionId)
      )
    );
  const [inFlight] = await tx
    .select({ sum: sql<string>`coalesce(sum(${creditSessions.overdraftSettledMinor}), 0)` })
    .from(creditSessions)
    .where(
      and(
        eq(creditSessions.walletId, input.walletId),
        eq(creditSessions.settlementStatus, 'processing'),
        isNull(creditSessions.deletedAt),
        ne(creditSessions.id, input.sessionId),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(creditLedger)
            .where(
              and(
                eq(creditLedger.sessionId, creditSessions.id),
                eq(creditLedger.reason, 'overdraft_settlement')
              )
            )
        )
      )
    );
  const ownedMinor = Number(receivables?.sum ?? 0) + Number(inFlight?.sum ?? 0);
  return Math.max(0, input.priorDebtLeftMinor - ownedMinor);
}

// ── Metering state machine (§5) — pure-ish helpers extracted from `meterSessionToNow` ─────
//
// `meterSessionToNow` posts every missing minute tick and advances the grace/ceiling/no-mandate
// state machine. The per-tick transition logic is factored into `applyActiveTick` /
// `applyGraceTick` (each mutating the shared {@link MeterLoopState}) so the primitive itself
// stays a thin, low-complexity loop. Behaviour is IDENTICAL to the inlined version — the
// credit-sessions integration suite is the regression guard.

/** The transaction handle `applyLedgerEntry` requires (also a valid `DbExecutor`). */
type MeterTx = Parameters<typeof applyLedgerEntry>[0];

/** Snapshotted per-session economics + bounds a metering pass reads (never mutated). */
interface MeterParams {
  rate: number;
  expertRate: number;
  ceiling: number;
  graceBoundMs: number;
  nearWrapMs: number;
  /**
   * BAL-523 — an active mandate AND a card-backed `low_balance_mode`. ⚠ RENAMED from
   * `mandateActive`, deliberately, not a second field added beside it — see
   * `credit-sessions.ts`'s BAL-523 history / the plan §2.1. A live mandate ALONE is no longer
   * sufficient to enter grace; a client on "Just notify me" is not carried past zero even with
   * an active mandate on file.
   *
   * ⚠ R9 — SNAPSHOTTED BY THE CALLER, not derived here. `meterSessionToNow` calls
   * `walletAllowsOverdraftGrace` once per metering pass when it builds this object;
   * `applyActiveTick` only reads `params.overdraftGraceAllowed`.
   */
  overdraftGraceAllowed: boolean;
  /**
   * BAL-412 (F13/D6) — ADR-1044 §7's billing floor in WHOLE MINUTES, feeding `minutesOfRunway`
   * for the one-shot `low` marker.
   *
   * ⚠ INJECTED BY THE CALLER, exactly like `graceBoundMs` / `nearWrapMs`, and for a hard
   * reason: this package has NO `process.env` access and the floor is env-overridable
   * (`MEETING_NO_SHOW_FLOOR_MINUTES`), read only at the `apps/api` boundary
   * (`resolveBillingFloorMinutes()`). `credit_sessions.billing_floor_minutes` cannot serve —
   * it is NULL until settlement writes it.
   */
  floorMinutes: number;
}

/** The mutable running state a metering pass advances tick by tick. */
interface MeterLoopState {
  balance: number;
  status: CreditSessionStatus;
  lastTickSeq: number;
  connectedMinutes: number;
  expertAccruedMinor: number;
  graceEnteredAtMs: number | null;
  lowWarnedAtMs: number | null;
  nearWrapWarnedAtMs: number | null;
  wrappedAtMs: number | null;
  stop: boolean;
}

/**
 * Post one `session_consume` tick via the atomic ledger primitive, then advance the running
 * counters. Balance always mirrors DB truth, so a dedup (crash-recovered replay) never
 * double-counts money.
 */
async function postMeterTick(
  tx: MeterTx,
  session: CreditSession,
  state: MeterLoopState,
  params: MeterParams,
  seq: number
): Promise<void> {
  const res = await applyLedgerEntry(tx, {
    walletId: session.walletId,
    entryType: 'consume',
    reason: 'session_consume',
    amountMinor: -params.rate,
    idempotencyKey: deriveIdempotencyKey({
      reason: 'session_consume',
      sessionId: session.id,
      tickSeq: seq,
    }),
    memberId: session.initiatingMemberId,
    sessionId: session.id,
  });
  state.lastTickSeq = seq;
  state.connectedMinutes += 1;
  state.expertAccruedMinor += params.expertRate;
  state.balance = res.wallet.balanceMinor;
}

/** Transition the session to the terminal warm `wrapped` pause (optionally flagging ceiling-hit). */
function wrapSession(
  state: MeterLoopState,
  tickTimeMs: number,
  transitions: MeterTransitions,
  ceilingHit: boolean
): void {
  state.status = 'wrapped';
  state.wrappedAtMs = tickTimeMs;
  state.stop = true;
  transitions.wrapped = true;
  if (ceilingHit) {
    transitions.ceilingHit = true;
  }
}

/** Set the one-shot near-wrap marker when grace-remaining OR ceiling-room drops to the threshold. */
function markNearWrap(
  state: MeterLoopState,
  params: MeterParams,
  tickTimeMs: number,
  graceElapsedMs: number,
  transitions: MeterTransitions
): void {
  if (state.nearWrapWarnedAtMs !== null) {
    return;
  }
  const graceRemainingMs = params.graceBoundMs - graceElapsedMs;
  const ceilingRoomMinutes = (params.ceiling - Math.abs(state.balance)) / params.rate;
  if (graceRemainingMs <= params.nearWrapMs || ceilingRoomMinutes <= NEAR_WRAP_MINUTES) {
    state.nearWrapWarnedAtMs = tickTimeMs;
    transitions.nearWrap = true;
  }
}

/** Advance one tick from the `active` state (funded minute, grace entry, or no-mandate stop). */
async function applyActiveTick(
  tx: MeterTx,
  session: CreditSession,
  state: MeterLoopState,
  params: MeterParams,
  seq: number,
  tickTimeMs: number,
  transitions: MeterTransitions
): Promise<void> {
  const balanceAfter = state.balance - params.rate;

  // Funded active minute (lead with the in-credit path).
  if (balanceAfter >= 0) {
    await postMeterTick(tx, session, state, params, seq);
    // ⚠⚠ F13/D6 — THE ONE RUNWAY FORMULA. This was the THIRD inline copy of
    // `floor(balance / rate)` and it is the one that actually TRIGGERS: it sets `lowWarnedAt`
    // and `transitions.low`, which is what publishes `session.low_balance`. Leaving it
    // uncorrected while `DrawdownState` used `minutesOfRunway` produced a SPLIT BRAIN — the
    // panel flipped to `low` early while the notification still fired on the old, later
    // threshold, and when it fired `publishLowBalance` reported the corrected, SMALLER figure
    // ("About 0 minutes of balance left" at the moment the trigger thought there were 8).
    // Do NOT re-inline this; `minutesOfRunway` (`@balo/shared/credit`) is the single definition.
    //
    // `state.connectedMinutes` — DRAWN, not elapsed — is the correct `minutesAlreadyDrawn`:
    // `postMeterTick` above has already incremented it for this tick, and `state.balance`
    // already mirrors the ledger after it, so the two agree exactly.
    if (
      state.lowWarnedAtMs === null &&
      minutesOfRunway({
        balanceMinor: state.balance,
        ratePerMinuteMinor: params.rate,
        floorMinutes: params.floorMinutes,
        minutesAlreadyDrawn: state.connectedMinutes,
      }) <= LOW_BALANCE_WARNING_MINUTES
    ) {
      state.lowWarnedAtMs = tickTimeMs;
      transitions.low = true;
    }
    return;
  }

  // Would cross zero without card-backed overdraft consent → hard stop, no post (no mandate, or
  // the client is on "Just notify me").
  if (!params.overdraftGraceAllowed) {
    wrapSession(state, tickTimeMs, transitions, false);
    return;
  }

  // Would cross zero WITH card-backed overdraft consent (mandate + card-backed mode) → enter
  // grace and post the crossing minute (balance negative).
  state.graceEnteredAtMs = tickTimeMs;
  state.status = 'grace';
  transitions.graceEntered = true;
  await postMeterTick(tx, session, state, params, seq);
  if (Math.abs(state.balance) >= params.ceiling) {
    wrapSession(state, tickTimeMs, transitions, true);
    return;
  }
  markNearWrap(state, params, tickTimeMs, 0, transitions);
}

/** Advance one tick from the `grace` state (warm minute, then a time-bound / ceiling wrap). */
async function applyGraceTick(
  tx: MeterTx,
  session: CreditSession,
  state: MeterLoopState,
  params: MeterParams,
  seq: number,
  tickTimeMs: number,
  transitions: MeterTransitions
): Promise<void> {
  const balanceAfter = state.balance - params.rate;
  const graceElapsedMs = tickTimeMs - (state.graceEnteredAtMs ?? tickTimeMs);
  const timeBoundHit = graceElapsedMs >= params.graceBoundMs;
  const ceilingHit = Math.abs(balanceAfter) >= params.ceiling;

  // Warm: post the completing minute even when it crosses the bound (≤1-min overshoot, Q6).
  await postMeterTick(tx, session, state, params, seq);
  if (timeBoundHit || ceilingHit) {
    wrapSession(state, tickTimeMs, transitions, ceilingHit);
    return;
  }
  markNearWrap(state, params, tickTimeMs, graceElapsedMs, transitions);
}

/** Persist the advanced counters + status + the newly-set one-shot markers only. */
async function persistMeterState(
  tx: MeterTx,
  session: CreditSession,
  state: MeterLoopState
): Promise<CreditSession> {
  const set: Partial<NewCreditSession> = {
    status: state.status,
    lastTickSeq: state.lastTickSeq,
    connectedMinutes: state.connectedMinutes,
    expertAccruedMinor: state.expertAccruedMinor,
  };
  if (state.graceEnteredAtMs !== null && session.graceEnteredAt === null) {
    set.graceEnteredAt = new Date(state.graceEnteredAtMs);
  }
  if (state.lowWarnedAtMs !== null && session.lowWarnedAt === null) {
    set.lowWarnedAt = new Date(state.lowWarnedAtMs);
  }
  if (state.nearWrapWarnedAtMs !== null && session.nearWrapWarnedAt === null) {
    set.nearWrapWarnedAt = new Date(state.nearWrapWarnedAtMs);
  }
  if (state.wrappedAtMs !== null && session.wrappedAt === null) {
    set.wrappedAt = new Date(state.wrappedAtMs);
  }

  const [updated] = await tx
    .update(creditSessions)
    .set(set)
    .where(eq(creditSessions.id, session.id))
    .returning();
  if (updated === undefined) {
    throw new SessionNotFoundError(session.id);
  }
  return updated;
}

/**
 * BAL-441 — the RAW projected row a session STATEMENT's receipt-only context is built from.
 * Names, not labels — `apps/api`'s `resolveSessionStatement` does the display formatting
 * (`personDisplayName` / `personWithOrgLabel`), matching `resolve-counterparty.ts`'s split of
 * "the fetch is not shared, the formatting is". Every optional relation (`caseTitle`,
 * `agencyName`) is a LEFT join — `engagement_id` and `agency_id` are legitimately NULL.
 *
 * ⚠ NO FIGURE, RATE, FEE OR MARGIN. This is a receipt-only CONTEXT read, structurally separate
 * from `findForClientMoneyView` / `findForExpertView` — it carries a timestamp, a title, two
 * display strings, two ids and a status, and nothing else. `expert_profiles.rate_cents` is not
 * projected (memory `reference_drizzle_with_hydration_leaks_secrets`).
 */
export interface SessionStatementContextRow {
  // ⚠ Review F9 — `sessionId`, `expertProfileId` and `engagementId` were projected here and
  // consumed by NOTHING. On a row whose entire justification is "explicit projection, nothing
  // extra", carrying unused ids is the beginning of the drift this allow-list exists to prevent
  // (the caller already HAS the session id — it passed it in). Re-add one only with a consumer.
  status: CreditSession['status'];
  connectedAt: Date | null;
  endedAt: Date | null;
  meetingId: string | null;
  companyName: string;
  caseTitle: string | null;
  expertProfileType: ExpertProfile['type'];
  expertFirstName: string | null;
  expertLastName: string | null;
  agencyName: string | null;
}

/**
 * BAL-525 — the wallet fields the settlement-instrument pin is taken from. STRUCTURAL on purpose,
 * so any wallet-shaped row is assignable without a `CreditWallet` import (the house posture in
 * `@balo/shared/credit`).
 */
interface PinnableWallet {
  stripeCustomerId: string | null;
  stripePaymentMethodId: string | null;
}

/**
 * BAL-525 (ADR-1040 Amendment 5) — the BASE pin: the Stripe instrument on file BEFORE this
 * session's debt could exist, taken at `open()` from the wallet already read under the advisory
 * lock. The pin is taken before any of THIS session's share can exist — and since BAL-474
 * (ADR-1040 Amendment 7 §A) a session only ever settles its OWN share, that is the baseline that
 * matters, even when the wallet already carries OTHER debt. (Amendment 5 §A's premise that
 * `open()` "refuses to open onto a negative balance" is withdrawn for the overdraft-tolerant open;
 * the gated open still refuses, so its sessions keep the clean baseline as before.)
 *
 * Empty when the wallet holds no card — the pair CHECK requires both-or-neither, so a half-set
 * write is structurally impossible from here, and NULL is a legitimate answer (see the schema
 * docblock).
 *
 * ⚠ `now()` IS THE DB'S TRANSACTION TIME, never a JS `Date`: DB time removes app↔DB clock skew
 * (the `cardUpdatedAt` precedent in `credit-wallets.ts`).
 *
 * EXACTLY ONE CALLER (`open` — the only production INSERT into `credit_sessions`). The count is
 * asserted by `packages/db/src/invariants/session-debt-carries-its-collection-instrument.test.ts`.
 */
function settlementInstrumentBasePin(
  wallet: PinnableWallet
): Partial<PgInsertValue<typeof creditSessions>> {
  const { stripeCustomerId, stripePaymentMethodId } = wallet;
  if (stripeCustomerId === null || stripePaymentMethodId === null) {
    return {};
  }
  return {
    settlementStripeCustomerId: stripeCustomerId,
    settlementStripePaymentMethodId: stripePaymentMethodId,
    settlementInstrumentPinnedAt: sql`now()`,
  };
}

/**
 * BAL-525 (ADR-1040 Amendment 5) — the WRITE-ONCE TOP-UP pin, for the two TERMINAL wallet-locked
 * settlements. Rescues the "opened card-less, then a card was added, then the balance went
 * negative" shape without letting a SWAP through: `COALESCE` means an already-pinned session keeps
 * its original instrument, and the wallet it reads from was read under the same lock that posted
 * the debt.
 *
 * ⚠ WRITE-ONCE IS ENFORCED IN SQL, NOT BY THE CALLER'S GUARD. `COALESCE` over the row's own
 * pre-UPDATE value (Postgres evaluates SET expressions against the old tuple) is the same
 * technique `applySavedCardDisplay` uses (`credit-wallets.ts`) and for the same reason: a guard a
 * later editor can drop is not an invariant. Both callers hold the session's `FOR UPDATE` row lock
 * as well, so this is belt AND braces.
 *
 * ⚠ `now()` IS THE DB'S TRANSACTION TIME, never a JS `Date` — a `Date` inside a raw `sql` template
 * throws at bind time (memory `reference_date_in_raw_sql_template_throws`), and DB time removes
 * app↔DB clock skew.
 *
 * EXACTLY TWO CALLERS (`end`, `settleFromPresence`). A third would mean someone pinned somewhere
 * that is not a terminal settlement, and the invariant suite's drift alarm fails on the count.
 */
function settlementInstrumentTopUpPin(
  wallet: PinnableWallet
): PgUpdateSetSource<typeof creditSessions> {
  const { stripeCustomerId, stripePaymentMethodId } = wallet;
  if (stripeCustomerId === null || stripePaymentMethodId === null) {
    return {};
  }
  return {
    settlementStripeCustomerId: sql`COALESCE(${creditSessions.settlementStripeCustomerId}, ${stripeCustomerId})`,
    settlementStripePaymentMethodId: sql`COALESCE(${creditSessions.settlementStripePaymentMethodId}, ${stripePaymentMethodId})`,
    settlementInstrumentPinnedAt: sql`COALESCE(${creditSessions.settlementInstrumentPinnedAt}, now())`,
  };
}

/**
 * Step 1b (BAL-474 AD-4) — the id of the meeting's live session (non-cancelled, non-deleted,
 * ENDED OR NOT), or `undefined` — always `undefined` for an open that names no meeting.
 */
async function findLiveMeetingSessionId(
  tx: DbExecutor,
  meetingId: string | null | undefined
): Promise<string | undefined> {
  if (meetingId === undefined || meetingId === null) {
    return undefined;
  }
  const [existing] = await tx
    .select({ id: creditSessions.id })
    .from(creditSessions)
    .where(
      and(
        eq(creditSessions.meetingId, meetingId),
        ne(creditSessions.status, 'cancelled'),
        isNull(creditSessions.deletedAt)
      )
    )
    .orderBy(desc(creditSessions.createdAt), desc(creditSessions.id))
    .limit(1);
  return existing?.id;
}

/** Step 2b — does the wallet already carry a NON-TERMINAL session? */
async function hasNonTerminalSessionOnWallet(tx: DbExecutor, walletId: string): Promise<boolean> {
  const [inProgress] = await tx
    .select({ id: creditSessions.id })
    .from(creditSessions)
    .where(
      and(
        eq(creditSessions.walletId, walletId),
        inArray(creditSessions.status, ['pending', 'active', 'grace', 'wrapped']),
        isNull(creditSessions.deletedAt)
      )
    )
    .limit(1);
  return inProgress !== undefined;
}

/**
 * Step 2c — the settlement-pending gate: a PRIOR session's overdraft settlement still IN FLIGHT
 * (`settlementStatus='processing'`; the webhook is the sole crediting authority), or a negative
 * balance. Returns `true` when the open must REFUSE (`settlement_pending`) — only ever under the
 * gated policy. GATED reads the REAL in-flight predicate directly (a balance-only check is defeated
 * by an independent top-up landing during the processing window), with the balance sign retained
 * as defence in depth. TOLERANT (AD-2) records both and passes — `share ≤ ownConsumed` means no
 * ordering of the prior charge can ever collect the same money twice (ADR-1040 Amendment 7 §A.4
 * WE2). The `processing` lookup rides `credit_sessions_settling_idx`.
 */
async function settlementPendingRefuses(
  tx: DbExecutor,
  input: { walletId: string; balanceMinor: number; tolerant: boolean },
  toleratedGates: OpenToleratedGate[]
): Promise<boolean> {
  const [settling] = await tx
    .select({ id: creditSessions.id })
    .from(creditSessions)
    .where(
      and(
        eq(creditSessions.walletId, input.walletId),
        eq(creditSessions.settlementStatus, 'processing'),
        isNull(creditSessions.deletedAt)
      )
    )
    .limit(1);
  const negative = input.balanceMinor < 0;
  if (settling === undefined && !negative) {
    return false;
  }
  if (!input.tolerant) {
    return true;
  }
  if (settling !== undefined) {
    toleratedGates.push('settlement_processing');
  }
  if (negative) {
    toleratedGates.push('negative_balance');
  }
  return false;
}

/** Step 3 — the expert's hourly rate snapshot (`null` ⇒ no rate set); throws on a missing profile. */
async function readExpertHourlyRate(
  tx: DbExecutor,
  expertProfileId: string
): Promise<number | null> {
  const [expert] = await tx
    .select({ rateCents: expertProfiles.rateCents })
    .from(expertProfiles)
    .where(eq(expertProfiles.id, expertProfileId))
    .limit(1);
  if (expert === undefined) {
    throw new ExpertProfileNotFoundError(expertProfileId);
  }
  return expert.rateCents;
}

/** Step 7 — insert the pending session with the full rate/ceiling snapshot. */
async function insertPendingSession(
  tx: DbExecutor,
  input: OpenSessionInput,
  snapshot: {
    wallet: CreditWallet;
    holdId: string;
    expertHourly: number;
    baloFeeBps: number;
    clientRateMinorPerMinute: number;
    expertRateMinorPerMinute: number;
  }
): Promise<CreditSession> {
  const { wallet } = snapshot;
  const [session] = await tx
    .insert(creditSessions)
    .values({
      walletId: input.walletId,
      companyId: input.companyId,
      expertProfileId: input.expertProfileId,
      initiatingMemberId: input.initiatingMemberId,
      holdId: snapshot.holdId,
      estimatedMinutes: input.estimatedMinutes,
      expertRateMinorPerHour: snapshot.expertHourly,
      baloFeeBps: snapshot.baloFeeBps,
      clientRateMinorPerMinute: snapshot.clientRateMinorPerMinute,
      expertRateMinorPerMinute: snapshot.expertRateMinorPerMinute,
      effectiveCeilingMinor: wallet.overdraftCeilingMinor ?? DEFAULT_OVERDRAFT_CEILING_MINOR,
      graceBoundMinutes: OVERDRAFT_GRACE_MINUTES,
      // BAL-418 seam — both nullable, both optional; existing callers are unchanged.
      meetingId: input.meetingId ?? null,
      engagementId: input.engagementId ?? null,
      // BAL-412 seam — write-once provenance. Omitted ⇒ `'live_capture'`, i.e. exactly
      // what every shipped caller gets. ⚠⚠ G4 (second review round) — CORRECTING A
      // NOW-FALSE CLAIM: this used to say "NOTHING on main passes `'presence'` (D10)". As
      // of BAL-466, `openSession` passes it for every session `joinMeetingAsMember` opens
      // at admission — see the coherence guard's docblock (`open-session.ts`, D4/G1).
      durationSource: input.durationSource ?? 'live_capture',
      // BAL-474 (AD-5) — write-once: who opened it. Omitted ⇒ `'client'` (every shipped caller).
      openedBy: input.openedBy ?? 'client',
      // BAL-525 — the base pin, from the wallet read under the SAME advisory lock, so no card
      // write can land between that read and this INSERT. Absent (all three NULL) when the
      // wallet holds no card. See `settlementInstrumentBasePin`.
      ...settlementInstrumentBasePin(wallet),
    })
    .returning();
  if (session === undefined) {
    throw new Error('Failed to insert credit session');
  }
  return session;
}

/**
 * Step 9 (BAL-474 §C.3) — an ON-BEHALF open records its provenance in the SAME transaction: the
 * booker did not act, so the row is a system act (actor NULL) naming them as `onBehalfOfUserId`.
 * It is what the ledger ticks' `member_id = booker` attribution rests on.
 */
async function recordOnBehalfOpen(
  tx: DbExecutor,
  input: OpenSessionInput,
  facts: {
    sessionId: string;
    toleratedGates: readonly OpenToleratedGate[];
    walletBalanceMinorAtOpen: number;
    availableMinorAtOpen: number;
  }
): Promise<void> {
  await auditEventsRepository.record(
    {
      actorUserId: null,
      action: SESSION_OPENED_ON_BEHALF_ACTION,
      entityType: SESSION_AUDIT_ENTITY_TYPE,
      entityId: facts.sessionId,
      metadata: {
        openedBy: input.openedBy,
        onBehalfOfUserId: input.initiatingMemberId,
        meetingId: input.meetingId ?? null,
        engagementId: input.engagementId ?? null,
        meetingGuestId: input.meetingGuestId ?? null,
        fundingPolicy: input.fundingPolicy ?? 'gated',
        toleratedGates: facts.toleratedGates,
        walletBalanceMinorAtOpen: facts.walletBalanceMinorAtOpen,
        availableMinorAtOpen: facts.availableMinorAtOpen,
        trigger: input.trigger ?? null,
      },
    },
    tx
  );
}

/**
 * THE OPEN, on the caller's transaction — `open()`'s body, and the first half of
 * `openAndSettleFromPresence` (BAL-474 AD-3). See {@link creditSessionsRepository.open} for the
 * gates and why each one is kept or tolerated.
 */
async function openInTx(tx: DbExecutor, input: OpenSessionInput): Promise<OpenSessionResult> {
  const tolerant = input.fundingPolicy === 'overdraft_tolerant';
  const toleratedGates: OpenToleratedGate[] = [];

  // 1. Serialise against every other writer on this wallet. Every session of a meeting sits on the
  //    engagement company's ONE wallet, so every open for a meeting serialises HERE too (AD-4).
  await acquireWalletLock(tx, input.walletId);

  // 1b. BAL-474 (AD-4) — NEVER TWO SESSIONS PER MEETING. Any live session for this meeting —
  //     non-cancelled and non-deleted, ENDED OR NOT — refuses a second one, under both policies.
  //     Deliberately NOT "one live session per wallet" (step 2b), which means non-TERMINAL: a
  //     meeting whose session has already ended must still never be billed twice. A meeting whose
  //     only session was `cancelled` reads as sessionless. No unique index (BAL-466's ruling — and
  //     a caught 23505 would abort the caller's transaction); the lock-plus-check is the guarantee.
  const existingSessionId = await findLiveMeetingSessionId(tx, input.meetingId);
  if (existingSessionId !== undefined) {
    return { ok: false, code: 'meeting_session_exists', existingSessionId };
  }

  // 2. Soft-hold gate — an open receivable. GATED: no new sessions while one is open. TOLERANT:
  //    recorded and passed — the hold now brakes new Case BOOKINGS, never a consultation already
  //    booked (ADR-1040 Amendment 7 §H), and the session settles only its own share (§A).
  if (await creditReceivablesRepository.hasOpenReceivable(input.companyId, tx)) {
    if (!tolerant) {
      return { ok: false, code: 'account_hold' };
    }
    toleratedGates.push('account_hold');
  }

  // 2b. One live consultation per wallet — kept under BOTH policies. The double-settle reason it
  //     was written for (a second non-terminal session folding the first one's debt into its own
  //     terminal figure) is now closed by the share cap (`resolveSessionOverdraftShare`). It stays
  //     because the share's "the settling session is the NEWEST debt" premise rests on it: BAL-477
  //     (concurrent sessions per wallet) must keep the `ownConsumed` cap AND decide attribution
  //     between concurrent sessions before lifting it. The wallet advisory lock (step 1) serialises
  //     concurrent opens, so this read-then-reject is race-safe.
  if (await hasNonTerminalSessionOnWallet(tx, input.walletId)) {
    return { ok: false, code: 'session_in_progress' };
  }

  const wallet = await readWalletOrThrow(tx, input.walletId);

  // 2c. Settlement-pending gate (see `settlementPendingRefuses`).
  if (
    await settlementPendingRefuses(
      tx,
      { walletId: input.walletId, balanceMinor: wallet.balanceMinor, tolerant },
      toleratedGates
    )
  ) {
    return { ok: false, code: 'settlement_pending' };
  }

  // 3. Snapshot the expert rate (Q9 hard-stop on a rate-less expert — both policies).
  const expertHourly = await readExpertHourlyRate(tx, input.expertProfileId);
  if (expertHourly === null) {
    return { ok: false, code: 'expert_rate_missing' };
  }

  // BAL-478 — ONE estimator. This block used to inline the arithmetic; it now calls the
  // shared pure helper the booking pre-check also calls, so the advisory gate and this
  // authoritative one can never drift. Figures are byte-identical (see
  // `packages/shared/src/credit/session-estimate.test.ts`).
  const { baloFeeBps, clientRateMinorPerMinute, expertRateMinorPerMinute, estimateMinor } =
    deriveSessionEstimate({
      expertHourlyMinor: expertHourly,
      estimatedMinutes: input.estimatedMinutes,
      baloFeeBps: input.baloFeeBps,
    });

  // 4. Re-derive available UNDER the lock (the money gate must not trust the advisory read).
  const available = wallet.balanceMinor - (await activeHoldsSum(tx, input.walletId));
  const mandateActive = isWalletMandateActive(wallet);

  // 5. Connect gate — fund the estimate OR present a mandate. GATED: the Model C hard-stop.
  //    TOLERANT (D1 — the moved AC): recorded and passed; with no mandate the meter wraps at zero
  //    with NO grace (`walletAllowsOverdraftGrace` is false), the floor still bills at settlement,
  //    and a shortfall goes to a receivable + dunning. The hold below is still the full estimate.
  if (available < estimateMinor && !mandateActive) {
    if (!tolerant) {
      return { ok: false, code: 'insufficient_no_mandate' };
    }
    toleratedGates.push('insufficient_no_mandate');
  }

  // 6. Place the hold (in-txn, under the lock) — reserves available so a concurrent
  //    session cannot over-commit the same balance. Linked to the session after insert.
  const hold = await creditHoldsRepository.place(
    {
      walletId: input.walletId,
      sessionId: null,
      memberId: input.initiatingMemberId,
      amountMinor: estimateMinor,
    },
    tx
  );

  // 7. Insert the pending session (write-once `opened_by`, the base pin).
  const session = await insertPendingSession(tx, input, {
    wallet,
    holdId: hold.id,
    expertHourly,
    baloFeeBps,
    clientRateMinorPerMinute,
    expertRateMinorPerMinute,
  });

  // 8. Link the hold back to the session (full two-way linkage).
  await tx.update(creditHolds).set({ sessionId: session.id }).where(eq(creditHolds.id, hold.id));

  // 9. BAL-474 (§C.3) — an ON-BEHALF open records its provenance in the same transaction.
  if (session.openedBy !== 'client') {
    await recordOnBehalfOpen(tx, input, {
      sessionId: session.id,
      toleratedGates,
      walletBalanceMinorAtOpen: wallet.balanceMinor,
      availableMinorAtOpen: available,
    });
  }

  return { ok: true, session, toleratedGates };
}

/**
 * THE PRESENCE SETTLEMENT, on the caller's transaction — `settleFromPresence`'s body, and the
 * second half of `openAndSettleFromPresence` (BAL-474 AD-3). Every step, comment and ordering of
 * the shipped transaction body is kept; see {@link creditSessionsRepository.settleFromPresence}.
 */
async function settleFromPresenceInTx(
  tx: MeterTx,
  input: SettleFromPresenceRepoInput
): Promise<SettleFromPresenceRepoResult> {
  // 1. Row lock. Two concurrent settlements on this session serialize here.
  const session = await readSessionForUpdate(tx, input.sessionId);
  if (session === undefined) {
    throw new SessionNotFoundError(input.sessionId);
  }

  // 2. In-lock exactly-once guard (TOCTOU). `billing_finalized_at` is the marker, and on
  //    the two ZERO shapes it is the ONLY guard available — they write no ledger row, so
  //    there is no idempotency key to dedup on. A legacy `ended` row with a NULL marker
  //    reads as settled too: it was finalized by `end()` under the old semantics.
  if (session.billingFinalizedAt !== null || session.status === 'ended') {
    const settledWallet = await readWalletOrThrow(tx, session.walletId);
    return {
      session,
      overdraftMinor: session.overdraftSettledMinor ?? 0,
      overdraftBasis: null,
      expertAccruedMinor: session.expertAccruedMinor,
      mandateActive: isWalletMandateActive(settledWallet),
      alreadySettled: true,
      ticksPosted: 0,
      outcomeWritten: false,
    };
  }
  if (!SETTLE_FROM_PRESENCE_FROM.includes(session.status)) {
    throw new InvalidSessionTransitionError(session.status, 'ended');
  }

  // ⚠ THE MEETING IS ASSERTED, NOT RE-DERIVED. The caller computed every figure below
  //   from THIS meeting's presence rows, so a mismatch means the settlement was computed
  //   against one meeting and is about to be written against another — the outcome would
  //   land on the wrong `meetings` row. Re-reading `session.meetingId` here instead of
  //   comparing would make a divergent pair silently AGREE (the BAL-421 rule); comparing
  //   catches it. Loud, before any write.
  if (session.meetingId !== input.meetingId) {
    throw new SettlementRefusedError(
      'meeting_mismatch',
      `settleFromPresence: session ${session.id} belongs to meeting ${String(session.meetingId)}, ` +
        `but settlement was computed for meeting ${input.meetingId}`
    );
  }

  // ⚠⚠ 2b (F2). THE DRAW IS ASSERTED UNDER THE LOCK, NOT RE-READ. Exactly the treatment the
  //   `meetingId` assertion above gets, for exactly the same class of divergence — and here
  //   the concurrent writer is DESIGNED, not hypothetical: `findMeterable` includes
  //   `'presence'` (D11), so the meter sweep advances `last_tick_seq` on this very row while
  //   the caller's pre-read is in flight.
  //
  //   Silently using the fresh value (a "re-read") is what the BAL-421 rule forbids: it would
  //   make a divergent pair AGREE, writing `connected_minutes` from a stale
  //   `billableMinutes`/`expertAccruedMinor` pair while the ledger holds MORE
  //   `session_consume` entries than the row admits. The ledger is the source of truth
  //   (ADR-1040), so that row is simply WRONG — expert under-accrued, client receipt
  //   understated, delta silently retained — and the caller's Q1 `log.error` would fire with
  //   the stale figure and misreport it as the benign known-limitation case.
  //
  //   Re-deriving here is not an option either: this method does no minute maths (see
  //   `SettleFromPresenceRepoInput`). So it REFUSES, before any write, and the durability
  //   backstop (`findPresenceUnsettled`, §4.3) re-runs the whole computation against fresh
  //   state — nothing is committed, `billing_finalized_at` stays NULL, the status stays
  //   non-terminal, and the retry's pre-read sees the meter's figure.
  if (session.lastTickSeq !== input.minutesAlreadyDrawn) {
    throw new SettlementDrawDivergedError(
      session.id,
      input.minutesAlreadyDrawn,
      session.lastTickSeq
    );
  }

  // 2c. THE FIGURES TIE TO THE DRAW, NOW THAT THE DRAW IS KNOWN. `billableMinutes` may exceed
  //   `MAX_SESSION_MINUTES` only by what the meter already drew, and the top-up can never run past
  //   the billed figure — either is a caller defect, refused before any write.
  if (input.billableMinutes > Math.max(MAX_SESSION_MINUTES, session.lastTickSeq)) {
    throw new SettlementRefusedError(
      'figure_exceeds_bound',
      `settleFromPresence: billableMinutes ${String(input.billableMinutes)} exceeds max(MAX_SESSION_MINUTES ${String(MAX_SESSION_MINUTES)}, drawn ${String(session.lastTickSeq)})`
    );
  }
  if (input.topUpToTickSeq > input.billableMinutes) {
    throw new SettlementRefusedError(
      'figure_exceeds_bound',
      `settleFromPresence: topUpToTickSeq ${String(input.topUpToTickSeq)} exceeds billableMinutes ${String(input.billableMinutes)}`
    );
  }

  // 3. Serialise against every other writer on this wallet, to COMMIT.
  await acquireWalletLock(tx, session.walletId);

  // 4. Release the reservation. Only an ACTIVE hold — so a replay that somehow got past
  //    step 2 still cannot re-release, and a `cancelled`/`settled` hold is left alone.
  if (session.holdId !== null) {
    const [hold] = await tx
      .select({ status: creditHolds.status })
      .from(creditHolds)
      .where(eq(creditHolds.id, session.holdId))
      .limit(1);
    if (hold?.status === 'active') {
      await creditHoldsRepository.release(session.holdId, { exec: tx });
    }
  }

  // 5. Top up the ticks over the SAME idempotency scheme the live meter used. Empty on
  //    both zero shapes and on any figure at or below what was already drawn.
  let ticksPosted = 0;
  for (let seq = input.topUpFromTickSeq; seq <= input.topUpToTickSeq; seq++) {
    const posted = await applyLedgerEntry(tx, {
      walletId: session.walletId,
      entryType: 'consume',
      reason: 'session_consume',
      amountMinor: -session.clientRateMinorPerMinute,
      idempotencyKey: deriveIdempotencyKey({
        reason: 'session_consume',
        sessionId: session.id,
        tickSeq: seq,
      }),
      memberId: session.initiatingMemberId,
      sessionId: session.id,
    });
    if (!posted.deduped) {
      ticksPosted += 1;
    }
  }

  // 6. Terminal balance, under the lock — and THIS session's share of it (BAL-474, ADR-1040
  //    Amendment 7 §A): never debt older than the session, even when the overdraft-tolerant open
  //    let it start onto a negative wallet.
  const wallet = await readWalletOrThrow(tx, session.walletId);
  const share = await readSessionOverdraftShare(tx, session, wallet);
  const overdraftMinor = share.overdraftMinor;

  // ONE number, TWO rates — the client charge (the ticks above) and the expert accrual
  // both derive from `billableMinutes`. That is the AC "client charge and expert accrual
  // use the identical floored figure", enforced structurally rather than by convention.
  const expertAccruedMinor = input.billableMinutes * session.expertRateMinorPerMinute;

  // 7a. Expert-always-paid: the accrual record, BEFORE any settlement decision. Written on
  //     the ZERO shapes too, at zero — "the expert accrued nothing here" is a fact worth
  //     recording, and its ABSENCE would read as a missing write.
  await auditEventsRepository.record(
    {
      actorUserId: input.actorUserId,
      action: SESSION_EXPERT_ACCRUED_ACTION,
      entityType: SESSION_AUDIT_ENTITY_TYPE,
      entityId: session.id,
      metadata: {
        expertProfileId: session.expertProfileId,
        connectedMinutes: input.billableMinutes,
        expertAccruedMinor,
      },
    },
    tx
  );

  // 8. `meetings.outcome` — FIRST WRITE WINS. The sweep may already have written
  //    `missed_call`; settlement re-derives the same label and must not overwrite it.
  //    Runs on `tx`, so a rolled-back settlement takes the outcome with it.
  const outcomeWritten = await meetingsRepository.setOutcomeIfUnset(tx, {
    meetingId: input.meetingId,
    outcome: input.outcome,
    actorUserId: input.actorUserId,
  });

  // 7b. The settlement's own reasoning record — the ONLY durable answer to "why was a
  //     6-minute call charged for 15?". ⚠ `shape: 'abandoned_wait'` beside
  //     `outcome: 'completed'` and a zero charge is CORRECT, not a bug on read (D2/D3).
  await auditEventsRepository.record(
    {
      actorUserId: input.actorUserId,
      action: SESSION_PRESENCE_SETTLED_ACTION,
      entityType: SESSION_AUDIT_ENTITY_TYPE,
      entityId: session.id,
      metadata: {
        meetingId: input.meetingId,
        shape: input.shape,
        outcome: input.outcome,
        outcomeWritten,
        actualMinutes: input.actualMinutes,
        billableMinutes: input.billableMinutes,
        // ⚠ F14 — AS GIVEN BY THE CALLER, never re-derived as
        // `billableMinutes > actualMinutes`. That derivation labels a Q1 NO-REFUND CLAMP
        // (rule 6, drawn 10, actual 6) as a floor application, and this row is the ONLY
        // durable forensic record of that overcharge. See `SettleFromPresenceRepoInput`.
        floorApplied: input.floorApplied,
        floorMinutes: input.billingFloorMinutes,
        ticksPosted,
        expertAccruedMinor,
        // F2 — the ASSERTED value (identical to `topUpFromTickSeq - 1`, but sourced from
        // the field the row lock verified rather than back-computed from a derived one).
        minutesAlreadyDrawn: input.minutesAlreadyDrawn,
        // BAL-474 — who opened the session, and how its settled figure was reached: THIS
        // session's share of the wallet's negative balance (ADR-1040 Amendment 7 §A). The
        // ownerless-debt reading is taken AFTER the terminal UPDATE below (it must see this
        // session's own row as `processing`), so it travels in the returned `overdraftBasis`
        // and the service's post-commit log line, not in this row.
        openedBy: session.openedBy,
        overdraftShare: share,
      },
    },
    tx
  );

  // 9. The terminal UPDATE. `connectedAt` stays NULL on a never-connected no-show.
  const [updated] = await tx
    .update(creditSessions)
    .set({
      status: 'ended',
      endedAt: session.endedAt ?? input.now,
      // ⚠ THE FLOORED FIGURE. `actual_minutes` below is what keeps the delivered one.
      connectedMinutes: input.billableMinutes,
      lastTickSeq: Math.max(session.lastTickSeq, input.billableMinutes),
      expertAccruedMinor,
      actualMinutes: input.actualMinutes,
      billingFloorMinutes: input.billingFloorMinutes,
      settlementShape: input.shape,
      // F14 — SNAPSHOTTED, because `floorApplied` is not recoverable from the other three
      // columns once the Q1 clamp has raised `connected_minutes`. `finalizeBilling`'s
      // `floored:` analytics reads THIS, not a re-derivation.
      floorApplied: input.floorApplied,
      overdraftSettledMinor: overdraftMinor,
      settlementStatus: overdraftMinor === 0 ? 'not_required' : 'processing',
      billingFinalizedAt: input.now,
      finalizationPath: 'presence',
      // BAL-525 — write-once top-up, from the terminal wallet read at step 6 (the same read
      // whose `balanceMinor` produced `overdraftMinor`). The ticks at step 5 and this pin are
      // one transaction under one wallet lock, so no card write can interleave between the
      // debt and the pin. NO-OP when already pinned — the COALESCE is in SQL.
      ...settlementInstrumentTopUpPin(wallet),
    })
    .where(eq(creditSessions.id, session.id))
    .returning();
  if (updated === undefined) {
    throw new SessionNotFoundError(input.sessionId);
  }

  // 10. BAL-474 (D7.3) — the older debt this terminal leaves must have an owner. Read AFTER the
  //     terminal UPDATE (this session's own row is now `processing`), still under the wallet lock.
  const ownerlessPriorDebtMinor = await readOwnerlessPriorDebt(tx, {
    walletId: session.walletId,
    sessionId: session.id,
    priorDebtLeftMinor: share.priorDebtLeftMinor,
  });

  return {
    session: updated,
    overdraftMinor,
    overdraftBasis: { ...share, ownerlessPriorDebtMinor },
    expertAccruedMinor,
    mandateActive: isWalletMandateActive(wallet),
    alreadySettled: false,
    ticksPosted,
    outcomeWritten,
  };
}

export const creditSessionsRepository = {
  /**
   * The pre-connect gates + hold + create-pending, in ONE wallet-locked txn (§6). Steps, all on
   * the transaction and under the wallet advisory lock taken FIRST:
   *
   *   1. advisory-lock the wallet;
   *   1b. BAL-474 (AD-4) — refuse `meeting_session_exists` when the meeting already has a live
   *       (non-cancelled, ENDED OR NOT) session, under BOTH policies;
   *   2. the soft-hold gate (an open receivable);
   *   2b. one live session per wallet (`session_in_progress`, BOTH policies);
   *   2c. the settlement-pending gate (a `processing` settlement, or a negative balance);
   *   3. snapshot the expert rate (refuse `expert_rate_missing`, Q9 — BOTH policies) and derive the
   *      marked-up/raw per-minute rates;
   *   4. RE-DERIVE available `= balance − Σ active holds` UNDER the lock (never the advisory
   *      `getAvailableBalance`);
   *   5. the connect gate (`available ≥ estimate OR mandate active`);
   *   6. place the hold in-txn; 7. insert the pending session (write-once `opened_by`, the base
   *      pin); 8. link the hold back to it;
   *   9. BAL-474 — on an ON-BEHALF open (`openedBy` `guest`/`system`), the
   *      `credit_session.opened_on_behalf` audit row, in the same transaction.
   *
   * ⚠⚠ BAL-474 (ADR-1040 Amendment 7 §B) — TWO FUNDING POLICIES. `gated` (the default; `POST
   * /sessions` and every caller that passes none) REFUSES at 2, 2c and 5, byte-identical to before.
   * `overdraft_tolerant` (every presence-seam open: member admission, guest admission, the
   * sessionless terminal-path open) passes THROUGH them and reports each as an
   * {@link OpenToleratedGate}: settlement is session-scoped (a session only ever settles its own
   * share — `resolveSessionOverdraftShare`), so a presence session may open onto an open
   * receivable, an in-flight settlement or a negative wallet without re-billing anyone else's debt,
   * and a refused open there would mean an unbilled consultation. With no mandate the tolerant
   * open meters to zero and warm-wraps with NO grace; the floor still bills at settlement.
   *
   * ⚠ BAL-523 — THE CONNECT GATE IS DELIBERATELY MANDATE-ONLY, and stays that way. An earlier
   * revision of BAL-523 additionally required a card-backed `low_balance_mode` here; that was
   * REVERTED (Yomi, 2026-09-04) after the security audit disproved its premise: on the presence
   * seam a refusal here would not refuse the client at the door — it would create NO session row,
   * the consultation would happen and nothing would meter. BAL-474 goes further on that same seam
   * (the tolerant policy), and the gated open keeps the mandate-only rule. BAL-523's promise lives
   * entirely in GRACE ENTRY (`applyActiveTick` reads the snapshotted grace flag): a `notify_only`
   * client opens and meters normally, and is simply not carried PAST zero.
   *
   * `exec` defaults to the base client. A caller may pass another `Database` — the two-connection
   * concurrency suite does, to race two real backends (`credit-sessions.sessionless-open.
   * concurrency.integration.test.ts`). Rejections are returned, never thrown; an incoherent policy
   * (`assertOpenPolicyCoherent`) is a programming error and throws before any transaction opens.
   */
  async open(input: OpenSessionInput, exec: Database = db): Promise<OpenSessionResult> {
    assertOpenPolicyCoherent(input);
    return exec.transaction((tx) => openInTx(tx, input));
  },

  /**
   * pending → active, stamping `connectedAt` (the metering anchor), reporting WHETHER THIS CALL
   * performed the transition (BAL-474, R6F-6). Idempotent on an already-`active` session (returns
   * it unchanged, `transitioned: false`, never re-anchoring the clock). No money, no wallet lock.
   * Any other current status is an illegal transition. `transitioned` is `true` for the one caller
   * that wrote the transition and `false` for a caller that found the session already `active`. Two
   * callers can race to connect a presence session (the presence writer and the meter sweep's
   * billing-start pass, each level-triggered), and only the winner may emit `session_started`, so
   * the fact is read under the same row lock that decides it.
   */
  async connectWithTransition(
    sessionId: string,
    opts: { now?: Date } = {}
  ): Promise<{ session: CreditSession; transitioned: boolean }> {
    const now = opts.now ?? new Date();
    return db.transaction(async (tx) => {
      const session = await readSessionForUpdate(tx, sessionId);
      if (session === undefined) {
        throw new SessionNotFoundError(sessionId);
      }
      if (session.status === 'active') {
        return { session, transitioned: false }; // idempotent — do not re-anchor connectedAt
      }
      if (session.status !== 'pending') {
        throw new InvalidSessionTransitionError(session.status, 'active');
      }
      const [updated] = await tx
        .update(creditSessions)
        .set({ status: 'active', connectedAt: now })
        .where(eq(creditSessions.id, sessionId))
        .returning();
      if (updated === undefined) {
        throw new SessionNotFoundError(sessionId);
      }
      return { session: updated, transitioned: true };
    });
  },

  /** A live session by id (excludes soft-deleted). */
  async findById(id: string): Promise<CreditSession | undefined> {
    return db.query.creditSessions.findFirst({
      where: and(eq(creditSessions.id, id), isNull(creditSessions.deletedAt)),
    });
  },

  /**
   * THE MEETING-SCOPED READ (BAL-388 recap). The `id` of the live, NON-CANCELLED credit
   * session for one meeting, or `undefined`. Rides the partial index `credit_sessions_meeting_idx` on
   * `(meeting_id, ended_at) WHERE meeting_id IS NOT NULL AND deleted_at IS NULL` (a filter on
   * `status` still costs a heap fetch, so it is NOT a covering read for this query).
   *
   * ⚠ `meeting_id` IS NULLABLE, AND ROWS THAT CARRY NULL CAN NEVER MATCH — `eq()` compiles to
   * `= $1`, which is never true against NULL. That is exactly the wanted behaviour: a session
   * with no meeting is not this meeting's session.
   *
   * ⚠⚠ `cancelled` ROWS ARE EXCLUDED, AND THAT IS A CORRECTNESS CONSTRAINT RATHER THAN
   * TIDINESS. A cancelled session never bills, so its `billing_finalized_at` stays NULL, and
   * `deriveState` maps a NULL to `pending` — a meeting whose session was cancelled would render
   * "Charge pending" FOREVER, which is exactly the unbackable money claim Rule M swears off.
   * Excluding it here also fixes the ordering: a later cancelled retry must not outrank the
   * `ended` row that actually billed.
   *
   * ⚠ ABSENCE IS LOAD-BEARING ON THE RECAP, NOT AN ERROR. Rule M branch M1 is keyed on the
   * ABSENCE of a row ("no consultation charge for this one"), so `undefined` must stay a
   * first-class answer here and must never be coerced into a zero-valued stub. A meeting whose
   * ONLY session was cancelled therefore falls to M1 — no figure, no claim.
   *
   * ⚠⚠ PROJECTED TO `id` ALONE, AND THAT IS THE WHOLE POINT. Its ONE caller is the recap
   * loader, on a CLIENT-BOUND path: it needs the id (to fetch the fee-concealed, lens-resolved
   * money block over the api) and the row's mere existence (Rule M branch M1). A bare
   * `.select()` here would put `baloFeeBps` (the literal Balo margin), `expertRateMinorPerMinute`
   * (the UN-MARKED-UP expert rate), `expertAccruedMinor` and `stripePaymentIntentId` one
   * careless spread away from a client payload — the same posture `findDisplayProfileById`
   * exists to enforce for `expert_profiles.rate_cents`. Concealment is enforced by what the ROW
   * CAN HOLD, not by remembering to omit things downstream. The other projected money reads are
   * `findForClientMoneyView` / `findForExpertView`; the full row is `findForAdminView`.
   */
  async findIdByMeetingId(meetingId: string): Promise<{ id: string } | undefined> {
    const [row] = await db
      .select({ id: creditSessions.id })
      .from(creditSessions)
      .where(
        and(
          eq(creditSessions.meetingId, meetingId),
          ne(creditSessions.status, 'cancelled'),
          isNull(creditSessions.deletedAt)
        )
      )
      .orderBy(desc(creditSessions.createdAt), desc(creditSessions.id))
      .limit(1);
    return row;
  },

  /**
   * BAL-379 — TRUE when the wallet has EITHER a non-terminal session
   * (`status ∈ {pending,active,grace,wrapped}`, not soft-deleted) OR any session whose
   * overdraft settlement is still `processing` (the `payment_intent.succeeded` webhook is
   * the sole crediting authority — a reload must not race an in-flight settlement). This is
   * the single combined boolean the auto-top-up engine's safe-to-charge gate reads so it
   * never fires a between-session reload DURING a live consultation or while a prior
   * settlement is pending.
   *
   * The reusable union of `open()`'s steps 2b and 2c — but DELIBERATELY NOT used by `open()`,
   * which needs the granular `session_in_progress` vs `settlement_pending` rejection codes (and,
   * since BAL-474, tolerates step 2c under the overdraft-tolerant policy). Threads the caller's `exec` so it runs UNDER the
   * engine's advisory lock (the same consistent snapshot as the balance it decides on).
   */
  async hasActiveSessionForWallet(walletId: string, exec: DbExecutor = db): Promise<boolean> {
    const [row] = await exec
      .select({ id: creditSessions.id })
      .from(creditSessions)
      .where(
        and(
          eq(creditSessions.walletId, walletId),
          isNull(creditSessions.deletedAt),
          or(
            inArray(creditSessions.status, ['pending', 'active', 'grace', 'wrapped']),
            eq(creditSessions.settlementStatus, 'processing')
          )
        )
      )
      .limit(1);
    return row !== undefined;
  },

  /**
   * BAL-523 — TRUE when this wallet carries consultation time already used beyond the balance
   * that MAY STILL BE CHARGED to the card on file. THREE arms, any of which is sufficient:
   *
   *  (0) THE BALANCE ITSELF IS NEGATIVE (`credit_wallets.balance_minor < 0`). This is the note's
   *      own claim, read literally — "time you've already used beyond your balance" — and it does
   *      not care HOW the balance got there. It is what catches the paths arm (a) structurally
   *      cannot: `settleFromPresence` posts `session_consume` ticks up to `billableMinutes` with
   *      NO ceiling clamp (Owner Decision 3 — "the live ceiling is a UX pause, never a billing
   *      cap") and `applyExternalDuration` flips a session to `active` with the wallet already
   *      negative — both with `grace_entered_at` never set. A settled overdraft is credited back
   *      to ≥ 0 by the `payment_intent.succeeded` webhook, so a still-negative balance is
   *      exposure, not history. ⚠ Deliberately NOT "any non-terminal presence session": that
   *      would warn every in-flight presence session on a FULLY FUNDED wallet, trading an
   *      under-warn for an over-warn.
   *  (a) LIVE, ALREADY PAST ZERO — `grace_entered_at IS NOT NULL` on a non-terminal session
   *      (`status ∈ {active, grace, wrapped}`). `applyGraceTick` consults NEITHER the mandate NOR
   *      the mode, so a session that entered grace before the client switched to `notify_only`
   *      keeps accruing warm minutes and WILL settle at `end`.
   *      ⚠ R9/R7.2 — WHY IT IS NOT REDUNDANT WITH ARM (0), stated correctly. NOT because the
   *      stamp can lead the balance: `applyActiveTick` stamps `grace_entered_at` and posts the
   *      crossing tick in the SAME transaction, so the balance is already negative by commit.
   *      The real reason is an INDEPENDENT CREDIT: a top-up (or a promo grant) landing mid-grace
   *      lifts `balance_minor` back to ≥ 0 while the session keeps drawing under a grace that is
   *      still open and still settles at `end`. Arm (0) goes quiet there; this arm does not.
   *  (b) ENDED, DEBT OUTSTANDING — `overdraft_settled_minor > 0` with
   *      `settlement_status ∈ {processing, failed, requires_action}`. ⚠ `failed` and
   *      `requires_action` are NOT optional, on the ONE ground that is verified in-repo: BOTH
   *      open a `credit_receivable` (`openReceivableAndDun`) that the daily dunning sweep keeps
   *      chasing until a settlement webhook clears it. Omitting them would hide the warning
   *      precisely while collection is still being pursued.
   *      ⚠ R7.3 — deliberately NOT justified on "the client can still complete the SCA
   *      challenge". There is no in-repo completion path for a SETTLEMENT PaymentIntent: nothing
   *      hands that `client_secret` to a browser. Stripe may still recover such a PI out of band,
   *      but this codebase does not, so the receivable is the half that carries the arm.
   *      ⚠ NOT because `reconcileStuckSettlement` retries them — IT DOES NOT. It early-returns on
   *      `settlementStatus !== 'processing'` (`end-session.ts`), `findStuckSettling` selects
   *      `processing` only, and the dunning sweep moves no money. A comment in `end-session.ts`
   *      exists specifically to correct that mis-attribution; do not re-introduce it here.
   *
   * ⚠ NOT `hasActiveSessionForWallet`. That answers "a session is live or a settlement is in
   * flight" — simultaneously too wide (a funded `pending` session) and too narrow (a `failed`
   * settlement). The two are neighbours, not synonyms; do not collapse them.
   *
   * The session read rides `credit_sessions_wallet_idx`; arm (0) is a PK lookup. Advisory only —
   * the settings surface reads it once per page load and may be one transition stale.
   */
  async hasUnsettledOverdraftForWallet(walletId: string, exec: DbExecutor = db): Promise<boolean> {
    // Arm (0) first: a PK lookup, and the common negative-balance case then skips the scan.
    const [wallet] = await exec
      .select({ balanceMinor: creditWallets.balanceMinor })
      .from(creditWallets)
      .where(eq(creditWallets.id, walletId))
      .limit(1);
    if (wallet !== undefined && wallet.balanceMinor < 0) {
      return true;
    }

    const [row] = await exec
      .select({ id: creditSessions.id })
      .from(creditSessions)
      .where(
        and(
          eq(creditSessions.walletId, walletId),
          isNull(creditSessions.deletedAt),
          or(
            and(
              isNotNull(creditSessions.graceEnteredAt),
              inArray(creditSessions.status, ['active', 'grace', 'wrapped'])
            ),
            and(
              gt(creditSessions.overdraftSettledMinor, 0),
              inArray(creditSessions.settlementStatus, ['processing', 'failed', 'requires_action'])
            )
          )
        )
      )
      .limit(1);
    return row !== undefined;
  },

  /**
   * The CLIENT-lens projected read (fee/PII boundary — no RLS). Returns ONLY the allow-list
   * columns, so `expertRate*` / `baloFeeBps` / `expertAccruedMinor` / `stripePaymentIntentId`
   * are structurally absent. Drives `deriveDrawdownState`.
   */
  async findForClientView(id: string): Promise<ClientSessionView | undefined> {
    return db.query.creditSessions.findFirst({
      columns: CLIENT_SESSION_VIEW_COLUMNS,
      where: and(eq(creditSessions.id, id), isNull(creditSessions.deletedAt)),
    });
  },

  /**
   * The CLIENT-lens MONEY-BLOCK projected read (BAL-399 fee/PII boundary — no RLS). Returns ONLY
   * the allow-list columns, so `expertRate*` / `baloFeeBps` / `expertAccruedMinor` /
   * `stripePaymentIntentId` are STRUCTURALLY absent — the client sees the all-in charge only. This
   * is a DISTINCT projection from `findForClientView` (the drawdown view): it carries the billing-
   * finalization markers the money block needs.
   */
  async findForClientMoneyView(id: string): Promise<ClientSessionMoneyView | undefined> {
    return db.query.creditSessions.findFirst({
      columns: CLIENT_SESSION_MONEY_COLUMNS,
      where: and(eq(creditSessions.id, id), isNull(creditSessions.deletedAt)),
    });
  },

  /**
   * The EXPERT-lens projected read (BAL-399 fee/PII boundary — no RLS). Returns ONLY the
   * allow-list columns, so `clientRate*` / `baloFeeBps` / `overdraftSettledMinor` /
   * `stripePaymentIntentId` are STRUCTURALLY absent — an expert sees own earnings only.
   */
  async findForExpertView(id: string): Promise<ExpertSessionMoneyView | undefined> {
    return db.query.creditSessions.findFirst({
      columns: EXPERT_SESSION_MONEY_COLUMNS,
      where: and(eq(creditSessions.id, id), isNull(creditSessions.deletedAt)),
    });
  },

  /**
   * The ADMIN-lens read — the SOLE relaxed money-block surface (full row incl. margin/fee).
   * Never reachable by a company member or expert (the `hasPlatformCapability` route gates it).
   */
  async findForAdminView(id: string): Promise<CreditSession | undefined> {
    return db.query.creditSessions.findFirst({
      where: and(eq(creditSessions.id, id), isNull(creditSessions.deletedAt)),
    });
  },

  /**
   * BAL-441 — the projected STATEMENT-CONTEXT read (§4 of the plan). An explicit `db.select({…})`
   * column map, never `with:` relational hydration (memory
   * `reference_drizzle_with_hydration_leaks_secrets`) — `rate_cents` (the un-marked-up consultant
   * rate) must not be in the row at all. Every optional relation (`caseEngagements`, `agencies`)
   * is a LEFT join: `engagement_id` and `agency_id` are legitimately NULL (independent experts
   * have no agency; a non-Case session has no case title). `companies` has NO `deleted_at`
   * (memory `reference_companies_table_no_deleted_at`) — no guard for it, by design.
   *
   * Soft-delete predicate matches every sibling money view. Returns `undefined` for a missing or
   * soft-deleted session — the caller (`resolveSessionStatement`) treats that identically to a
   * lens-gate denial (existence hidden).
   */
  async findStatementContext(id: string): Promise<SessionStatementContextRow | undefined> {
    const [row] = await db
      .select({
        status: creditSessions.status,
        connectedAt: creditSessions.connectedAt,
        endedAt: creditSessions.endedAt,
        meetingId: creditSessions.meetingId,
        companyName: companies.name,
        caseTitle: caseEngagements.title,
        expertProfileType: expertProfiles.type,
        expertFirstName: users.firstName,
        expertLastName: users.lastName,
        agencyName: agencies.name,
      })
      .from(creditSessions)
      .innerJoin(companies, eq(companies.id, creditSessions.companyId))
      .innerJoin(expertProfiles, eq(expertProfiles.id, creditSessions.expertProfileId))
      // ⚠ THE SOFT-DELETE PREDICATES BELONG IN THE `ON` CLAUSE, NOT THE `WHERE`. Moving either
      // into `.where()` silently turns its LEFT JOIN into an INNER one and drops the whole
      // statement row (a deleted expert would 404 an otherwise-valid receipt).
      //
      // `users` and `case_engagements` DO carry `deleted_at` (`schema/users.ts`,
      // `schema/case-engagements.ts`); `companies` and `agencies` DO NOT — in those files the
      // `...softDelete` spread belongs to the `*_members` CHILD table, not the parent — which is
      // why the two inner joins above correctly omit it.
      //
      // This matters beyond tidiness: without it, a closed account's name and a soft-deleted
      // case's title keep rendering on the receipt AND inside the downloadable PDF, so personal
      // data survives a deletion signal in a file that can be forwarded outside the company.
      .leftJoin(users, and(eq(users.id, expertProfiles.userId), isNull(users.deletedAt)))
      .leftJoin(agencies, eq(agencies.id, expertProfiles.agencyId))
      .leftJoin(
        caseEngagements,
        and(
          eq(caseEngagements.engagementId, creditSessions.engagementId),
          isNull(caseEngagements.deletedAt)
        )
      )
      .where(and(eq(creditSessions.id, id), isNull(creditSessions.deletedAt)))
      .limit(1);
    return row;
  },

  /**
   * BAL-421 — the EXPERT-lens earnings aggregate for one CASE, keyed on the engagement.
   *
   * ⚠⚠ READS `engagement_id` **AS GIVEN**. IT MUST NEVER RESOLVE THROUGH
   * `meeting_id` → `meeting_contexts.context_id` → engagement. This is not a preference:
   * the two columns' coherence is unenforceable in the database (a CHECK cannot subquery,
   * and the composite-FK trick has no valid target — see the ruling on
   * `schema/credit-sessions.ts`), so it is the SINGLE WRITE PATH's obligation, carried by
   * BAL-400. Money and reporting read `engagement_id` directly; only BAL-425's inactivity
   * sweep resolves through the seam. Re-deriving here would make a divergent pair
   * SILENTLY AGREE — it "would hide a divergence rather than catch it" — and the divergence
   * would then be undiscoverable by any read, because no row anywhere looks wrong. The gap
   * is pinned by the divergence test in `credit-sessions.integration.test.ts`, and this
   * method has its own guard test beside it. If you find yourself joining `meeting_contexts`
   * to make a case's earnings "show up", the bug is in the WRITER, not here.
   *
   * `engagement_id` IS NULLABLE and `eq()` compiles to `= $1`, which is never true against
   * NULL — so a session that carries a meeting but no engagement is invisible here even
   * when its meeting resolves to this very case. That is the wanted behaviour, and it is
   * exactly what the divergence guard asserts.
   *
   * ⚠⚠ BAL-466 (F9, review fix round) — CORRECTING A NOW-FALSE CLAIM. This used to say "RETURNS
   * `not_yet` FOR EVERY CASE ON `main` TODAY… the live `openSession` service passes neither
   * column (BAL-400 will)". `openSession` passes BOTH `meetingId` and `engagementId` as of this
   * PR, for every session the admission seam opens (`joinMeetingAsMember`, D1) — so `pending`
   * and `finalized` are now reachable for a case with an admitted client, INCLUDING mid-call,
   * while the consultation is still live. `not_yet` remains correct only for a case with no
   * admitted client at all. Still do not "fix" an empty result by widening the read — the AS-GIVEN
   * rule three paragraphs up is unchanged; what changed is only how often the read is empty. See
   * {@link CaseExpertEarningsAggregate} for why the empty state is a distinct value rather than a
   * zero.
   *
   * FINALIZED-ONLY SUMMATION, mirroring `buildExpertMoneyBlock` ("pending ⇒ every figure is
   * 0"): a session whose `billing_finalized_at` is NULL contributes to
   * `pendingSessionCount` and to NOTHING else. Summing un-finalized accrual would surface a
   * moving number nobody is owed yet.
   *
   * ⚠ EXCLUDES `cancelled` SESSIONS, AND THAT IS A CORRECTNESS CONSTRAINT RATHER THAN
   * TIDINESS — the same ruling as `findIdByMeetingId`. A cancelled session never bills, so
   * its `billing_finalized_at` stays NULL FOREVER; counting it would pin the block in
   * `pending` ("1 consultation still being finalised") for the life of the case, about a
   * consultation that will never produce a cent. A `pending`/`active` session legitimately
   * counts as pending: the reaper cancels the stale ones (`findStalePending`), which then
   * fall out of this read by the same filter.
   *
   * FEE-SAFE BY PROJECTION: the SELECT touches `expert_accrued_minor` and
   * `billing_finalized_at` and NOTHING else — never `clientRateMinorPerMinute`,
   * `baloFeeBps`, `overdraftSettledMinor` or `stripePaymentIntentId`. Concealment is
   * enforced by what the ROWS can hold, not by remembering to omit things downstream.
   *
   * Rides the partial index `credit_sessions_engagement_idx`
   * (`(engagement_id) WHERE engagement_id IS NOT NULL AND deleted_at IS NULL`). Folded in
   * TypeScript rather than aggregated in SQL: the row set is one case's consultations (a
   * handful, bounded by how many calls two parties hold about one problem), and an explicit
   * two-column projection is both the fee boundary and the thing a reviewer can check at a
   * glance — a `FILTER (WHERE …)` aggregate is not expressible in Drizzle's typed builder
   * and would trade that for raw SQL.
   */
  async sumExpertEarningsForEngagement(engagementId: string): Promise<CaseExpertEarningsAggregate> {
    const rows = await db
      .select({
        expertAccruedMinor: creditSessions.expertAccruedMinor,
        billingFinalizedAt: creditSessions.billingFinalizedAt,
      })
      .from(creditSessions)
      .where(
        and(
          // AS GIVEN — never through `meeting_id` → `meeting_contexts`. See the docblock.
          eq(creditSessions.engagementId, engagementId),
          ne(creditSessions.status, 'cancelled'),
          isNull(creditSessions.deletedAt)
        )
      );

    let finalizedSessionCount = 0;
    let pendingSessionCount = 0;
    let earningsAudMinor = 0;
    for (const row of rows) {
      if (row.billingFinalizedAt === null) {
        pendingSessionCount += 1;
        continue;
      }
      finalizedSessionCount += 1;
      earningsAudMinor += row.expertAccruedMinor;
    }

    if (finalizedSessionCount === 0) {
      // NO FIGURE IN EITHER ARM — the surface renders copy, never `A$0.00`.
      return pendingSessionCount === 0
        ? {
            state: 'not_yet',
            finalizedSessionCount: 0,
            pendingSessionCount: 0,
            earningsAudMinor: null,
          }
        : {
            state: 'pending',
            finalizedSessionCount: 0,
            pendingSessionCount,
            earningsAudMinor: null,
          };
    }

    return { state: 'finalized', finalizedSessionCount, pendingSessionCount, earningsAudMinor };
  },

  /**
   * Sessions the reaper must meter — status ∈ {active, grace}, oldest-connected first.
   *
   * BAL-399: an `external` session is EXCLUDED — it is settled via BAL-133 confirmation
   * (`applyExternalDuration`), never wall-clock metered.
   *
   * ⚠⚠ BAL-412 (D11) WIDENED THIS TO INCLUDE `'presence'`, AND THAT IS LOAD-BEARING, NOT
   * CONVENIENCE. **THE PER-MINUTE TICK LOOP STILL RUNS UNDER A FLOOR.** The floor is a
   * SETTLEMENT concept, not a metering one — during the call nothing changes at all. Exclude
   * `presence` here and three shipped things break, none of them loudly:
   *
   *   · BAL-403's in-call balance panel reads `balanceMinor`, which only moves because the
   *     meter posts ticks — it would freeze at the opening balance for the whole call
   *     (ADR-1050: "the corrected figures flow through this panel automatically");
   *   · the GRACE STATE MACHINE (`applyActiveTick` / `applyGraceTick`) is driven ENTIRELY by
   *     ticks, so the session would never enter grace, never wrap at the ceiling, and
   *     `effectiveCeilingMinor` — the money-side backstop — would never bind;
   *   · the one-shot `low` / `near_wrap` notices fire from tick transitions, so no warnings.
   *
   * Settlement then RECONCILES the ticks already written against the floored figure by
   * TOPPING UP over the same tick-sequence idempotency scheme (`settleFromPresence`), never
   * by issuing a second competing charge.
   *
   * ⚠⚠ **BUT A `presence` SESSION IS METERED ONLY WHILE ITS MEETING IS STILL LIVE (F3).** The
   * `presence` arm carries a JOIN to `meetings` and refuses a TERMINAL one (`ended` /
   * `cancelled`) — the same shape of guard `findWrappedIdle` carries, and it is a MONEY guard,
   * not tidiness. Without it this finder selects on STATUS ALONE, and status alone cannot know
   * the call is over:
   *
   *   · both terminal paths call settlement BEST-EFFORT and NON-FATAL, so a settlement that
   *     FAULTS leaves the session `active` with its meeting already `ended`;
   *   · `meterSessionToNow` draws off the WALL CLOCK (`floor((now − connectedAt)/60s)`, clamped at
   *     `MAX_SESSION_MINUTES`), so it keeps posting `session_consume` ticks for a room nobody is in;
   *   · `enforceMaxDuration` deliberately SKIPS `presence` (Q3), so nothing force-ends it;
   *   · and the Q1 NO-REFUND CLAMP then makes the runaway PERMANENT — the backstop settles
   *     `billableMinutes = max(20, 35) = 35` for a 20-minute call, against an append-only
   *     ledger, and no refund primitive exists to undo it.
   *
   * Closed AT SOURCE rather than absorbed by the clamp. It also converges F2's divergence
   * refusal: once the meeting is terminal the meter stops, so `last_tick_seq` holds still and
   * the backstop's retry sees a stable figure instead of racing a live writer forever.
   *
   * A NULL `meeting_id` on a `presence` session is excluded too (the LEFT JOIN yields no row) —
   * it has no presence to settle from, so metering it could only ever draw money nothing can
   * reconcile. `live_capture` is unaffected: it never joins, exactly as before.
   *
   * ⚠ BAL-474 RULE A — A PRESENCE SESSION IS CONNECTED ONLY WHEN BILLING STARTS, which is never before
   * the meeting's scheduled start (`start-billing.ts`). So a session this finder selects has a
   * `connected_at >= scheduled_start`, every tick it draws lies in `[start, now)`, and the minutes the
   * expert and a client-side participant were together BEFORE the start come only from settlement's
   * `togetherBeforeStartMs` term — the two never overlap, and the Q1 no-refund clamp can never keep a
   * charge for an empty pre-start room.
   */
  async findMeterable(): Promise<CreditSession[]> {
    const rows = await db
      .select({ session: creditSessions })
      .from(creditSessions)
      // LEFT, not INNER: `live_capture` sessions legitimately carry a NULL `meeting_id` and
      // must not be dropped. The `presence` arm below is what requires the row to exist.
      .leftJoin(meetings, eq(meetings.id, creditSessions.meetingId))
      .where(
        and(
          inArray(creditSessions.status, ['active', 'grace']),
          // Enum literals at QUERY time are always safe (the ADD-VALUE restriction is index
          // predicates + CHECKs) — see `credit_sessions_presence_unsettled_idx`.
          inArray(creditSessions.durationSource, ['live_capture', 'presence']),
          isNull(creditSessions.deletedAt),
          // F3 — the provenance-scoped arm. Written as "not presence OR (live meeting)" so a
          // future duration_source is metered exactly as its own `inArray` entry above says,
          // with no second allow-list to keep in step.
          or(
            ne(creditSessions.durationSource, 'presence'),
            and(
              isNotNull(meetings.id),
              notInArray(meetings.status, ['ended', 'cancelled']),
              isNull(meetings.deletedAt)
            )
          )
        )
      )
      .orderBy(asc(creditSessions.connectedAt));
    return rows.map((row) => row.session);
  },

  /**
   * The authoritative metering primitive (§5) — in ONE wallet-locked txn, post every missing
   * `session_consume` tick from `lastTickSeq+1` to `min(floor((now − connectedAt)/60s),
   * MAX_SESSION_MINUTES)`, advance
   * the grace/ceiling/no-mandate state machine, set one-shot markers, and return the set of
   * NEWLY-crossed transitions. Deterministic + idempotent: a replayed tickSeq dedups on the
   * ledger UNIQUE (balance mirrors DB truth), so re-metering crosses nothing new.
   *
   * Transition rules (evaluated per tick):
   *  - active, would cross zero, overdraft grace allowed → enter grace, POST (balance goes negative).
   *  - active, would cross zero, grace NOT allowed        → STOP: do not post, `wrapped` (key `end`).
   *    ⚠ BAL-523: "allowed" is `params.overdraftGraceAllowed` — an active mandate AND a
   *    card-backed `low_balance_mode`. A live mandate alone is NOT enough; a client on "Just
   *    notify me" is not carried past zero. ⚠ R9: `applyActiveTick` READS the flag, it does not
   *    compute it — `walletAllowsOverdraftGrace` is invoked ONCE per metering pass at the
   *    `MeterParams` construction site below, and that is the ONLY site on the predicate.
   *    ⚠ The invariant suite counts `walletAllowsOverdraftGrace` CALLS in this file by regex and
   *    asserts exactly one, so keep prose mentions free of a trailing `(`.
   *    SETTLEMENT and the `open()` CONNECT GATE both stay mandate-only, deliberately (see
   *    `open`'s ⚠ BAL-523 note and `walletAllowsOverdraftGrace`'s docblock).
   *  - grace, 30-min bound OR |balanceAfter| ≥ ceiling → POST the completing minute (warm,
   *    ≤1-min overshoot, Q6), then `wrapped`.
   *  - otherwise POST normally.
   * One-shot markers: `lowWarnedAt` (active, `minutesOfRunway(...)` ≤
   * LOW_BALANCE_WARNING_MINUTES), `nearWrapWarnedAt` (grace, grace-remaining OR ceiling-room ≤
   * NEAR_WRAP_MINUTES).
   *
   * ⚠ THE METER NEVER POSTS A TICK PAST `MAX_SESSION_MINUTES`, whatever the wall clock says: a
   * session whose meeting nobody ended stops drawing at the ceiling. `maxSessionMinutesReached`
   * (`{ withheldTicks, pastScheduledEnd }`) flags the ONE committed run that lands `last_tick_seq` on the ceiling because the clamp bound
   * (elapsed above it, or a `presence` session reaching it); a `live_capture` session arriving at
   * exactly the ceiling on time is the reaper's ordinary force-end and is not flagged.
   *
   * ⚠⚠ BAL-412 (F13/D6) — `params.floorMinutes` is the ADR-1044 §7 billing floor, **REQUIRED**
   * and INJECTED because this package reads no env (`MEETING_NO_SHOW_FLOOR_MINUTES` is resolved
   * only at the `apps/api` boundary, and `credit_sessions.billing_floor_minutes` is NULL until
   * settlement writes it). It feeds the ONE `minutesOfRunway` implementation
   * (`@balo/shared/credit`) that decides `lowWarnedAt` — i.e. what publishes
   * `session.low_balance`. It is NOT optional and NOT defaulted: a default of `0` would
   * silently reduce the formula to the uncorrected `floor(balance / rate)` and reopen the exact
   * split brain F13 exists to close (the panel `low` early, the notification late, and the
   * notification's own figure smaller than the threshold that fired it).
   */
  async meterSessionToNow(
    sessionId: string,
    now: Date,
    params: { floorMinutes: number }
  ): Promise<MeterSessionResult> {
    return db.transaction(async (tx) => {
      const session = await readSessionForUpdate(tx, sessionId);
      if (session === undefined) {
        throw new SessionNotFoundError(sessionId);
      }
      // Only active/grace sessions meter; a null anchor cannot be metered. BAL-399: an
      // `external` session is settled via BAL-133 confirmation, never wall-clock metered —
      // early-return defensively even if the reaper finder's guard were ever bypassed.
      //
      // ⚠ BAL-412: `'presence'` METERS EXACTLY LIKE `'live_capture'` and must stay in this
      // set — see `findMeterable` for what silently breaks otherwise. The guard is written as
      // an EXCLUSION of `'external'` rather than an inclusion so a future provenance label
      // cannot be silently un-metered by an out-of-date allow-list here; whoever adds one
      // states its metering behaviour deliberately, in both places.
      if (
        (session.status !== 'active' && session.status !== 'grace') ||
        session.connectedAt === null ||
        session.durationSource === 'external'
      ) {
        return { session, transitions: {}, ticksPosted: 0 };
      }

      await acquireWalletLock(tx, session.walletId);
      const wallet = await readWalletOrThrow(tx, session.walletId);

      const connectedAtMs = session.connectedAt.getTime();
      const elapsedTickSeq = Math.floor((now.getTime() - connectedAtMs) / 60_000);
      const targetTickSeq = Math.min(elapsedTickSeq, MAX_SESSION_MINUTES);
      if (targetTickSeq <= session.lastTickSeq) {
        return { session, transitions: {}, ticksPosted: 0 };
      }

      const meterParams: MeterParams = {
        rate: session.clientRateMinorPerMinute,
        expertRate: session.expertRateMinorPerMinute,
        ceiling: session.effectiveCeilingMinor,
        graceBoundMs: session.graceBoundMinutes * 60_000,
        nearWrapMs: NEAR_WRAP_MINUTES * 60_000,
        overdraftGraceAllowed: walletAllowsOverdraftGrace(wallet),
        floorMinutes: params.floorMinutes,
      };
      const state: MeterLoopState = {
        balance: wallet.balanceMinor,
        status: session.status,
        lastTickSeq: session.lastTickSeq,
        connectedMinutes: session.connectedMinutes,
        expertAccruedMinor: session.expertAccruedMinor,
        graceEnteredAtMs: session.graceEnteredAt?.getTime() ?? null,
        lowWarnedAtMs: session.lowWarnedAt?.getTime() ?? null,
        nearWrapWarnedAtMs: session.nearWrapWarnedAt?.getTime() ?? null,
        wrappedAtMs: session.wrappedAt?.getTime() ?? null,
        stop: false,
      };
      const transitions: MeterTransitions = {};

      for (let seq = state.lastTickSeq + 1; seq <= targetTickSeq && !state.stop; seq++) {
        const tickTimeMs = connectedAtMs + seq * 60_000;
        if (state.status === 'active') {
          await applyActiveTick(tx, session, state, meterParams, seq, tickTimeMs, transitions);
        } else {
          await applyGraceTick(tx, session, state, meterParams, seq, tickTimeMs, transitions);
        }
      }

      if (
        state.lastTickSeq === MAX_SESSION_MINUTES &&
        session.lastTickSeq < MAX_SESSION_MINUTES &&
        (elapsedTickSeq > MAX_SESSION_MINUTES || session.durationSource === 'presence')
      ) {
        transitions.maxSessionMinutesReached = {
          withheldTicks: elapsedTickSeq - MAX_SESSION_MINUTES,
          pastScheduledEnd:
            session.durationSource === 'presence'
              ? await readPastScheduledEnd(tx, session.meetingId, now)
              : null,
        };
      }

      const updated = await persistMeterState(tx, session, state);
      return {
        session: updated,
        transitions,
        ticksPosted: state.lastTickSeq - session.lastTickSeq,
      };
    });
  },

  /**
   * Terminate a session (§7) in ONE wallet-locked txn: release the hold → read the terminal
   * balance and THIS session's share of it (`overdraftMinor = min(own session_consume,
   * max(0, −balance))` — BAL-474, ADR-1040 Amendment 7 §A: never debt older than the session;
   * identical to the whole negative balance on every state the gated open can reach) → FINALIZE
   * the expert accrual + write
   * the `credit_session.expert_accrued` audit row (the expert-always-paid record, committed
   * BEFORE any charge) → set `status='ended'`, `endedAt`, `overdraftSettledMinor`, and
   * `settlementStatus` (`not_required` when in credit, else `processing`). This method is
   * PURE DB — it never calls Stripe; it returns `overdraftMinor` + `mandateActive`. ⚠ BAL-525
   * (O3): `mandateActive` is OBSERVATION ONLY as of this PR — it drives NOTHING. It is threaded
   * through to `settleOverdraft` purely so a flip between this commit and settlement time is
   * greppable in the logs; the service re-checks `isWalletMandateActive` on its OWN fresh wallet
   * read before ever charging (`end-session.ts`'s `settleOverdraft`). Idempotent on an
   * already-`ended` session.
   *
   * BAL-399: the terminal UPDATE also stamps `billingFinalizedAt = now` + `finalizationPath`
   * (default `'live_capture'`) — the single "money block is finalized" marker the recap reads.
   * The optional `finalizationPath` records which path finalized (`confirmed` / `disputed` /
   * `auto_confirmed` for the external/BAL-133 finalizer); existing callers are unaffected.
   */
  async end(
    sessionId: string,
    opts: { now?: Date; finalizationPath?: CreditFinalizationPath } = {}
  ): Promise<EndSessionResult> {
    const now = opts.now ?? new Date();
    const finalizationPath: CreditFinalizationPath = opts.finalizationPath ?? 'live_capture';
    return db.transaction(async (tx) => {
      const session = await readSessionForUpdate(tx, sessionId);
      if (session === undefined) {
        throw new SessionNotFoundError(sessionId);
      }
      if (session.status === 'ended') {
        // Idempotent re-end — no hold re-release, no duplicate accrual audit.
        const wallet = await readWalletOrThrow(tx, session.walletId);
        return {
          session,
          overdraftMinor: session.overdraftSettledMinor ?? 0,
          overdraftBasis: null,
          expertAccruedMinor: session.expertAccruedMinor,
          mandateActive: isWalletMandateActive(wallet),
          alreadyEnded: true,
        };
      }
      if (
        session.status !== 'active' &&
        session.status !== 'grace' &&
        session.status !== 'wrapped'
      ) {
        throw new InvalidSessionTransitionError(session.status, 'ended');
      }

      await acquireWalletLock(tx, session.walletId);

      // Release the reservation (in-txn). Only release an active hold (idempotency-safe).
      if (session.holdId !== null) {
        const [hold] = await tx
          .select({ status: creditHolds.status })
          .from(creditHolds)
          .where(eq(creditHolds.id, session.holdId))
          .limit(1);
        if (hold?.status === 'active') {
          await creditHoldsRepository.release(session.holdId, { exec: tx });
        }
      }

      const wallet = await readWalletOrThrow(tx, session.walletId);
      // BAL-474 (ADR-1040 Amendment 7 §A) — THIS session's share of the negative balance.
      const share = await readSessionOverdraftShare(tx, session, wallet);
      const overdraftMinor = share.overdraftMinor;
      const expertAccruedMinor = session.connectedMinutes * session.expertRateMinorPerMinute;

      // Expert-always-paid: record the accrual audit row BEFORE any settlement decision.
      await auditEventsRepository.record(
        {
          actorUserId: session.initiatingMemberId,
          action: SESSION_EXPERT_ACCRUED_ACTION,
          entityType: SESSION_AUDIT_ENTITY_TYPE,
          entityId: session.id,
          metadata: {
            expertProfileId: session.expertProfileId,
            connectedMinutes: session.connectedMinutes,
            expertAccruedMinor,
          },
        },
        tx
      );

      const settlementStatus: CreditSettlementStatus =
        overdraftMinor === 0 ? 'not_required' : 'processing';

      const [updated] = await tx
        .update(creditSessions)
        .set({
          status: 'ended',
          endedAt: now,
          overdraftSettledMinor: overdraftMinor,
          expertAccruedMinor,
          settlementStatus,
          // BAL-399: finalize the money block in the same terminal UPDATE.
          billingFinalizedAt: now,
          finalizationPath,
          // BAL-525 — write-once top-up, from the terminal wallet read above (the same read whose
          // `balanceMinor` produced `overdraftMinor`), under the wallet lock. NO-OP when the
          // session is already pinned — the COALESCE is in SQL, not in a caller guard. This is
          // ALSO shape E's (`external` / BAL-133) pin: `applyExternalDuration` posts the debt in
          // an earlier transaction and reads no wallet, so this is the first wallet read after
          // that debt, under the lock, in the transaction that computes the settled figure.
          ...settlementInstrumentTopUpPin(wallet),
        })
        .where(eq(creditSessions.id, session.id))
        .returning();
      if (updated === undefined) {
        throw new SessionNotFoundError(sessionId);
      }

      // BAL-474 (D7.3) — the older debt this terminal leaves must have an owner. Read AFTER the
      // terminal UPDATE (this session's own row is now `processing`), still under the wallet lock.
      const ownerlessPriorDebtMinor = await readOwnerlessPriorDebt(tx, {
        walletId: session.walletId,
        sessionId: session.id,
        priorDebtLeftMinor: share.priorDebtLeftMinor,
      });

      return {
        session: updated,
        overdraftMinor,
        overdraftBasis: { ...share, ownerlessPriorDebtMinor },
        expertAccruedMinor,
        mandateActive: isWalletMandateActive(wallet),
        alreadyEnded: false,
      };
    });
  },

  /**
   * BAL-412 (ADR-1044 §7) — SETTLE ONE `presence` SESSION FROM ITS MEETING'S PRESENCE ROWS, in
   * ONE wallet-locked transaction, EXACTLY ONCE. The sibling of {@link end} for the meeting-
   * derived path, and it lives beside it deliberately: both need the module-private
   * `readSessionForUpdate` / `readWalletOrThrow`, and a SECOND definition of a locked read on
   * the money path is precisely what this codebase forbids.
   *
   * Order, everything on the same `tx` (ADR-1030):
   *
   *   1. `readSessionForUpdate` — the `FOR UPDATE` ROW LOCK. Two concurrent settlements on one
   *      session serialize HERE.
   *   2. THE IDEMPOTENCY GUARD, read UNDER that lock (never from the service's pre-read): a
   *      stamped `billing_finalized_at` — or a legacy `status='ended'` with a NULL marker —
   *      returns `alreadySettled` with NO side effects. This is `applyExternalDuration`'s
   *      shipped TOCTOU pattern.
   *   3. `acquireWalletLock` (`pg_advisory_xact_lock`, held to COMMIT). Re-entrant, so
   *      `applyLedgerEntry`'s own acquisition in step 5 is free.
   *   4. HOLD RELEASE — only an `active` hold, exactly `end()`'s shape, and BEFORE the ticks
   *      (the hold is a reservation; the ticks are the draw).
   *   5. THE LEDGER TOP-UP — one `session_consume` entry per seq in
   *      `[topUpFromTickSeq … topUpToTickSeq]`, on the SAME `session_consume:{id}:{seq}` keys
   *      the live meter already used, so ticks 1..N already posted are never posted twice and
   *      the remainder up to the floored figure is added. `from > to` ⇒ NOTHING is posted,
   *      which is both zero shapes and a no-op replay. **No ceiling clamp** — Owner Decision 3:
   *      the live ceiling is a UX pause, never a billing cap.
   *   6. Terminal balance read UNDER the lock (never `getAvailableBalance`, which is advisory),
   *      and THIS session's share of it (`readSessionOverdraftShare` — BAL-474, ADR-1040
   *      Amendment 7 §A: never debt older than the session).
   *   7. TWO audit rows — `credit_session.expert_accrued` (parity with `end()`, the
   *      expert-always-paid record) and `credit_session.presence_settled` (this ticket's
   *      reasoning record).
   *   8. `meetings.outcome`, via `setOutcomeIfUnset` on the same `tx` — first write wins, so
   *      the sweep's `missed_call` is never overwritten.
   *   9. The terminal session UPDATE.
   *  10. BAL-474 (D7.3) — the ownerless-debt check (`readOwnerlessPriorDebt`), AFTER that UPDATE,
   *      returned as `overdraftBasis` for the service to alarm post-commit.
   *
   * ⚠⚠ **LEGAL FROM `pending | active | grace | wrapped` — A WIDER SET THAN `end()`'s, AND
   * DELIBERATELY SO.** On a client no-show NOTHING ever calls `connect`, so the session is
   * still `pending` with `connected_at` NULL when its meeting ends. Refusing `pending` here
   * would make the no-show — the case this whole ticket exists for — unsettleable. Verified
   * safe: `formatElapsed(null, …)` returns `"00:00:00"`, `graceMinutesUsed` guards on a null
   * `graceEnteredAt`, and the money block reads `connected_minutes`, not `connected_at`.
   *
   * ⚠ **NO REFUND IS EVER WRITTEN.** The ledger is append-only (ADR-1040), so the caller's
   * `billableMinutes` has already been clamped UP to whatever was drawn. This method posts
   * only forward ticks; `topUpToTickSeq < topUpFromTickSeq` posts none. It cannot reduce a
   * balance draw, and it must not learn how to.
   *
   * ⚠ IT DOES **NOT** VERIFY `duration_source = 'presence'`. That refusal
   * (`not_presence_sourced`) belongs to the service, with the other four preconditions
   * (`session_not_found` / `no_meeting` / `meeting_not_terminal` / `already_settled`), so all
   * five are returned as codes from one place rather than half thrown from here. **A caller
   * that skips it will floor-settle a `live_capture` session** — do not add a caller that
   * bypasses `settleSessionFromPresence`.
   *
   * ⚠ IT DOES NOT CALL STRIPE. Pure DB, like `end()`: it returns `overdraftMinor` +
   * `mandateActive`. ⚠ BAL-525 (O3): `mandateActive` is OBSERVATION ONLY as of this PR — it
   * drives NOTHING. It rides through to `settleOverdraft` purely so a flip between this commit
   * and settlement time is greppable in the logs; the service re-checks `isWalletMandateActive`
   * on its OWN fresh wallet read before ever charging (`end-session.ts`'s `settleOverdraft`).
   *
   * ⚠ BAL-466 wires the enabling condition — reachable from a `duration_source='presence'`
   * session, which `joinMeetingAsMember` now opens at admission to a `case` meeting.
   *
   * `exec` defaults to the base client and exists so a test can drive TWO GENUINELY
   * SIMULTANEOUS backends (`credit-sessions.settlement.concurrency.integration.test.ts`) —
   * the standard harness pins one `max: 1` connection inside one open transaction, where
   * concurrency is structurally inexpressible. Production passes nothing.
   */
  async settleFromPresence(
    input: SettleFromPresenceRepoInput,
    exec: Database = db
  ): Promise<SettleFromPresenceRepoResult> {
    // OUTSIDE the transaction — a caller-arithmetic bug must not open one.
    assertSettlementFigures(input);
    // BAL-474 (AD-3) — the transaction body is `settleFromPresenceInTx`, shared verbatim with
    // `openAndSettleFromPresence`, so a sessionless meeting settles through the SAME path.
    return exec.transaction((tx) => settleFromPresenceInTx(tx, input));
  },

  /**
   * BAL-474 (ADR-1040 Amendment 7 §C.4, plan AD-3) — OPEN AND SETTLE A SESSIONLESS ENDED CASE
   * MEETING IN ONE TRANSACTION, on behalf of its booker. Reached from every terminal path (the
   * lifecycle sweep's rules, a human End, the durability backstop) via the service
   * `settleSessionlessCaseMeeting`, whenever the meeting's presence settles as `no_show_client` or
   * `held` and no session exists (a client no-show; an admission-time open that was refused or
   * threw; a guest-only call).
   *
   * THE SAME SETTLEMENT PATH (pinned by `invariants/expert-paid-for-time-made-available.test.ts`):
   * the SAME transaction body as `settleFromPresence` (`settleFromPresenceInTx`), the same pure core
   * upstream, the same post-commit tail downstream. Only the open differs — and it is the SAME open
   * (`openInTx`), overdraft-tolerant and `openedBy: 'system'`, so its gates, its in-lock
   * one-session-per-meeting check (AD-4) and its on-behalf audit row are exactly `open()`'s. A
   * refusal (`meeting_session_exists`, `session_in_progress`, `expert_rate_missing`) returns before
   * anything is written; an open never commits without its settlement, or the reverse.
   *
   * ⚠⚠ THE LOCKS THIS TRANSACTION TAKES, PRECISELY:
   *   (i)   the wallet advisory lock, FIRST (in `openInTx`);
   *   (ii)  row locks only on rows invisible to every other transaction until commit — its OWN
   *         new session (`settleFromPresenceInTx`'s `FOR UPDATE`) and its own new hold;
   *   (iii) the `credit_wallets` row, after the advisory lock, as every ledger writer does;
   *   (iv)  the `meetings` row, only when `outcome IS NULL` (`setOutcomeIfUnset`), again after the
   *         advisory lock — exactly as `settleFromPresence` does.
   * It NEVER row-locks a pre-existing `credit_sessions` row: steps 1b / 2b / 2c and the ownerless
   * check are plain SELECTs under the advisory lock. A future step that row-locked ANOTHER session
   * here would create a cycle with `settleFromPresence`, `meterSessionToNow` and `cancel`, which
   * lock a session row BEFORE the wallet lock.
   *
   * The settlement figures must be a FROM-ZERO settlement (`minutesAlreadyDrawn === 0`,
   * `topUpFromTickSeq === 1`) — a session opened in this transaction has drawn nothing. Asserted
   * outside the transaction with the other figure guards.
   *
   * `exec` defaults to the base client (the concurrency suite races two real backends through it).
   */
  async openAndSettleFromPresence(
    input: OpenAndSettleFromPresenceInput,
    exec: Database = db
  ): Promise<OpenAndSettleFromPresenceResult> {
    // OUTSIDE the transaction — a caller bug must not open one.
    assertOpenPolicyCoherent(input.open);
    assertSettlementFigures(input.settlement);
    if (input.settlement.minutesAlreadyDrawn !== 0 || input.settlement.topUpFromTickSeq !== 1) {
      throw new SettlementRefusedError(
        'open_not_from_zero',
        'openAndSettleFromPresence: a session opened in this transaction has drawn nothing — ' +
          `minutesAlreadyDrawn must be 0 and topUpFromTickSeq 1 (received ` +
          `${String(input.settlement.minutesAlreadyDrawn)} / ${String(input.settlement.topUpFromTickSeq)})`
      );
    }

    return exec.transaction(async (tx) => {
      const opened = await openInTx(tx, input.open);
      if (!opened.ok) {
        return opened;
      }
      const settled = await settleFromPresenceInTx(tx, {
        ...input.settlement,
        sessionId: opened.session.id,
        meetingId: input.open.meetingId,
      });
      return { ok: true, toleratedGates: opened.toleratedGates, settled };
    });
  },

  /**
   * BAL-399 — park an `external` session (bot-fail / outside-tool hang-up) into the `wrapped`
   * pause AWAITING a BAL-133 duration confirmation, in ONE wallet-locked txn: release the
   * pre-connect hold (idempotency-safe — only an `active` hold) and set `status='wrapped'`,
   * leaving `billingFinalizedAt` NULL (the money block stays a PENDING receipt). Legal only from
   * `active` / `grace` / `wrapped` (idempotent on an already-`wrapped` session). The reaper's
   * `findWrappedIdle` excludes `external`, so this park never auto-ends before confirmation.
   */
  async parkAwaitingDuration(sessionId: string): Promise<CreditSession> {
    return db.transaction(async (tx) => {
      const session = await readSessionForUpdate(tx, sessionId);
      if (session === undefined) {
        throw new SessionNotFoundError(sessionId);
      }
      if (session.status === 'wrapped') {
        return session; // idempotent — already parked
      }
      if (session.status !== 'active' && session.status !== 'grace') {
        throw new InvalidSessionTransitionError(session.status, 'wrapped');
      }

      await acquireWalletLock(tx, session.walletId);
      if (session.holdId !== null) {
        const [hold] = await tx
          .select({ status: creditHolds.status })
          .from(creditHolds)
          .where(eq(creditHolds.id, session.holdId))
          .limit(1);
        if (hold?.status === 'active') {
          await creditHoldsRepository.release(session.holdId, { exec: tx });
        }
      }

      const [updated] = await tx
        .update(creditSessions)
        .set({ status: 'wrapped', wrappedAt: session.wrappedAt ?? new Date() })
        .where(eq(creditSessions.id, session.id))
        .returning();
      if (updated === undefined) {
        throw new SessionNotFoundError(sessionId);
      }
      return updated;
    });
  },

  /**
   * BAL-399 — apply a BAL-133-confirmed `external` duration in ONE wallet-locked txn, EXACTLY ONCE.
   * `readSessionForUpdate` takes the session ROW lock (`FOR UPDATE`), so two concurrent finalizers
   * on the same session serialize here and the second observes the first's COMMITTED state — that
   * is the TOCTOU guard, NOT the service's pre-read. The fresh parked state is `status='wrapped'`
   * (set by `parkAwaitingDuration`) with `billingFinalizedAt IS NULL`:
   *  - already finalized (`billingFinalizedAt` set) → idempotent no-op;
   *  - no longer parked (a prior call flipped it out) → SAME confirmed minutes is an idempotent
   *    no-op, a DIFFERENT minutes is a real conflict → `ExternalDurationConflictError` (→ 409),
   *    so a disagreeing second confirmation can NEVER post a second set of ticks (no double-draw);
   *  - fresh parked → post the `session_consume` ticks `1 … minutes` (REUSE `deriveIdempotencyKey`),
   *    drawing the FULL confirmed minutes at the snapshotted client rate with NO ceiling clamp
   *    (Owner Decision 3 — the live ceiling was a UX pause, never a billing cap; overflow goes
   *    negative → the service's `end()` settles it off-session or opens a receivable + dunning),
   *    and ATOMICALLY flip `status` out of `wrapped` (→ `active`, which `end()` accepts and the
   *    reaper ignores for `external`) so a concurrent second call sees the changed state.
   * The service then calls `end()` to finalize the accrual + settle. This bounds TICK POSTING to
   * once (the payout `created` guard bounds payout-booking to once separately).
   */
  async applyExternalDuration(sessionId: string, minutes: number): Promise<CreditSession> {
    return db.transaction(async (tx) => {
      const session = await readSessionForUpdate(tx, sessionId);
      if (session === undefined) {
        throw new SessionNotFoundError(sessionId);
      }

      await acquireWalletLock(tx, session.walletId);

      // In-lock exactly-once guard (TOCTOU). Already finalized ⇒ nothing to do.
      if (session.billingFinalizedAt !== null) {
        return session;
      }
      // No longer the fresh parked state ⇒ duration was already applied by a prior (committed)
      // call: same minutes is an idempotent no-op; a different minutes is a genuine conflict.
      if (session.status !== 'wrapped') {
        if (session.connectedMinutes === minutes) {
          return session;
        }
        throw new ExternalDurationConflictError(sessionId);
      }

      // Fresh parked → draw the full confirmed minutes (no ceiling clamp). `lastTickSeq` is 0 for a
      // parked external session (never live-metered), so this posts `1 … minutes`; the `+1` resume
      // is defensive and each tick dedups on the ledger UNIQUE on any replay.
      for (let seq = session.lastTickSeq + 1; seq <= minutes; seq++) {
        await applyLedgerEntry(tx, {
          walletId: session.walletId,
          entryType: 'consume',
          reason: 'session_consume',
          amountMinor: -session.clientRateMinorPerMinute,
          idempotencyKey: deriveIdempotencyKey({
            reason: 'session_consume',
            sessionId: session.id,
            tickSeq: seq,
          }),
          memberId: session.initiatingMemberId,
          sessionId: session.id,
        });
      }

      const nextTickSeq = Math.max(session.lastTickSeq, minutes);
      const [updated] = await tx
        .update(creditSessions)
        // Flip OUT of the parked `wrapped` state in the SAME locked txn — the mutex that makes a
        // concurrent second call no-op/409 instead of drawing again.
        .set({ status: 'active', connectedMinutes: minutes, lastTickSeq: nextTickSeq })
        .where(eq(creditSessions.id, session.id))
        .returning();
      if (updated === undefined) {
        throw new SessionNotFoundError(sessionId);
      }
      return updated;
    });
  },

  /**
   * Record the settlement outcome on the session (processing / settled / failed /
   * requires_action). TX-COMPOSABLE (`exec` first, like `applyMandate`) so the settlement
   * webhook marks the session in the SAME txn that applies the `overdraft_settlement` credit
   * (§3b dispatch.ts.c / §14 Q2). Stamps `settledAt` on `settled`, and stamps
   * `stripePaymentIntentId` whenever supplied — the `processing` call stamps the in-flight
   * settlement PI so the reaper can retrieve its real status before ever re-charging (FIX 6).
   *
   * ⚠⚠ BAL-474 (D5.2 / D7.4, ADR-1040 Amendment 7 §B.5) — COMPARE-AND-SET ON EVERY NON-TERMINAL
   * STAMP. `processing`, `failed` and `requires_action` are written only WHERE the row is still
   * `processing`:
   *   · the post-charge `processing` stamp can land AFTER the `payment_intent.succeeded` webhook
   *     already wrote `settled` (a synchronously-succeeded PI) — an unconditional write flipped it
   *     back, and the row then claimed an in-flight charge that had already been credited;
   *   · a failure stamp after a client-side error must never overwrite the webhook's `settled` for
   *     a charge Stripe did in fact confirm (R4-F4).
   * `settled` stays UNCONDITIONAL — the webhook is the single source of truth for success.
   *
   * On a compare-and-set that matched nothing, the row is re-read and returned UNCHANGED (never a
   * throw): the caller reads `settlementStatus` to learn whether its write applied. Only a missing
   * row throws {@link SessionNotFoundError}.
   */
  async markSettlementResult(
    exec: DbExecutor,
    input: MarkSettlementResultInput
  ): Promise<CreditSession> {
    const set: Partial<NewCreditSession> = { settlementStatus: input.status };
    if (input.status === 'settled') {
      set.settledAt = input.now ?? new Date();
    }
    if (input.stripePaymentIntentId !== undefined) {
      set.stripePaymentIntentId = input.stripePaymentIntentId;
    }
    const where =
      input.status === 'settled'
        ? eq(creditSessions.id, input.sessionId)
        : and(
            eq(creditSessions.id, input.sessionId),
            eq(creditSessions.settlementStatus, 'processing')
          );
    const [row] = await exec.update(creditSessions).set(set).where(where).returning();
    if (row !== undefined) {
      return row;
    }
    // The compare-and-set matched nothing: the row already moved on (or never existed).
    const [current] = await exec
      .select()
      .from(creditSessions)
      .where(eq(creditSessions.id, input.sessionId))
      .limit(1);
    if (current === undefined) {
      throw new SessionNotFoundError(input.sessionId);
    }
    return current;
  },

  /**
   * Cancel a pending (never-connected) session, releasing its hold. Idempotent on an
   * already-`cancelled` session; any non-`pending` status is an illegal transition. Under
   * the wallet lock so a concurrent `open` re-derives available consistently.
   */
  async cancel(sessionId: string, opts: { memberId?: string | null } = {}): Promise<CreditSession> {
    return db.transaction(async (tx) => {
      const session = await readSessionForUpdate(tx, sessionId);
      if (session === undefined) {
        throw new SessionNotFoundError(sessionId);
      }
      if (session.status === 'cancelled') {
        return session; // idempotent
      }
      if (session.status !== 'pending') {
        throw new InvalidSessionTransitionError(session.status, 'cancelled');
      }

      await acquireWalletLock(tx, session.walletId);
      if (session.holdId !== null) {
        const [hold] = await tx
          .select({ status: creditHolds.status })
          .from(creditHolds)
          .where(eq(creditHolds.id, session.holdId))
          .limit(1);
        if (hold?.status === 'active') {
          await creditHoldsRepository.release(session.holdId, {
            memberId: opts.memberId ?? null,
            exec: tx,
          });
        }
      }

      const [updated] = await tx
        .update(creditSessions)
        .set({ status: 'cancelled' })
        .where(eq(creditSessions.id, sessionId))
        .returning();
      if (updated === undefined) {
        throw new SessionNotFoundError(sessionId);
      }
      return updated;
    });
  },

  /**
   * Reaper finder: `pending` sessions opened at/before `cutoff` (never connected) — auto-
   * cancel candidates. The caller computes `cutoff = now − PENDING_STALE_CANCEL_MINUTES`.
   *
   * ⚠⚠ BAL-412 (F4) EXCLUDES `'presence'`, AND THE EXCLUSION IS THE WHOLE NO-SHOW CASE —
   * the same asymmetry, and the same reasoning, `findWrappedIdle` carries below.
   *
   * A CLIENT NO-SHOW NEVER CALLS `connect`. That is precisely why `SETTLE_FROM_PRESENCE_FROM`
   * was widened to include `pending`: the session is still `pending`, with `connected_at` NULL,
   * when its meeting terminates. But this reaper's cutoff is anchored on `created_at`, and a
   * session opened at booking time is routinely older than `PENDING_STALE_CANCEL_MINUTES`
   * before the meeting even starts. Left in scope it would `cancel()` the row — and `cancelled`
   * is a TRAP DOOR for this provenance:
   *
   *   · `settleFromPresence` then throws `InvalidSessionTransitionError` (`cancelled` is not in
   *     `SETTLE_FROM_PRESENCE_FROM`), and
   *   · `findPresenceUnsettled` excludes `cancelled` outright, so the durability backstop can
   *     never recover it either.
   *
   * PERMANENTLY STRANDED: the expert is never paid for the no-show they waited out, and
   * `meetings.outcome` is never resolved — the exact case this ticket exists to settle,
   * destroyed by the reaper before settlement runs. A `presence` session's terminator is the
   * MEETING lifecycle, never this pass. Do not "fix" the asymmetry by widening it back.
   */
  async findStalePending(cutoff: Date): Promise<CreditSession[]> {
    return db
      .select()
      .from(creditSessions)
      .where(
        and(
          eq(creditSessions.status, 'pending'),
          lte(creditSessions.createdAt, cutoff),
          // Enum literal at QUERY time — always safe (the ADD-VALUE restriction is index
          // predicates + CHECKs).
          ne(creditSessions.durationSource, 'presence'),
          isNull(creditSessions.deletedAt)
        )
      )
      .orderBy(asc(creditSessions.createdAt));
  },

  /**
   * Reaper finder: `wrapped` sessions paused at/before `cutoff` — auto-end candidates. The
   * caller computes `cutoff = now − WRAPPED_IDLE_END_MINUTES`. BAL-399: `duration_source =
   * 'live_capture'` only — an `external` session parked (`parkAwaitingDuration`) awaiting BAL-133
   * confirmation shares the `wrapped` state but must NEVER be auto-ended by the idle reaper
   * (that would finalize it at zero minutes before the duration is confirmed).
   *
   * ⚠⚠ BAL-412 DELIBERATELY DID **NOT** WIDEN THIS TO `'presence'`, THOUGH IT DID WIDEN
   * `findMeterable`. THE ASYMMETRY IS THE POINT. A `presence` session that wraps on the
   * ceiling is still a LIVE MEETING; auto-ending it here routes it through
   * `endSessionAsSystem` → `end()`, which finalizes at WALL-CLOCK minutes with NO floor, NO
   * `meetings.outcome` and `finalization_path='live_capture'` — the session would be stamped
   * `billing_finalized_at`, and `settleFromPresence` would then correctly refuse it as
   * already-settled. The floor would be lost permanently and silently, behind the meeting's
   * back. A `presence` session's terminator is the MEETING lifecycle sweep, and its settler is
   * `settleFromPresence` (with `findPresenceUnsettled` as the backstop). Do not "fix" the
   * asymmetry.
   */
  async findWrappedIdle(cutoff: Date): Promise<CreditSession[]> {
    return db
      .select()
      .from(creditSessions)
      .where(
        and(
          eq(creditSessions.status, 'wrapped'),
          eq(creditSessions.durationSource, 'live_capture'),
          lte(creditSessions.wrappedAt, cutoff),
          isNull(creditSessions.deletedAt)
        )
      )
      .orderBy(asc(creditSessions.wrappedAt));
  },

  /**
   * Reaper finder: sessions stuck in `settlementStatus='processing'` since at/before `cutoff`
   * — a crash between commit(processing) and the charge/webhook. Rides
   * `credit_sessions_settling_idx`. The caller re-invokes the session-keyed charge (Stripe
   * returns the same PI — no double-charge).
   */
  async findStuckSettling(cutoff: Date): Promise<CreditSession[]> {
    return db
      .select()
      .from(creditSessions)
      .where(
        and(
          eq(creditSessions.settlementStatus, 'processing'),
          lte(creditSessions.endedAt, cutoff),
          isNull(creditSessions.deletedAt)
        )
      )
      .orderBy(asc(creditSessions.endedAt));
  },

  /**
   * THE ALARM FINDER — sessions marked `settlement_status='settled'` for which NO
   * `overdraft_settlement` credit exists in the ledger. Money the client was told is settled,
   * with no ledger row to show for it.
   *
   * ⚠⚠ WHY IT IS SOUND TO SELECT ON `settled` ALONE, WITH NO DISCRIMINATOR COLUMN. `settled` has
   * exactly TWO writers: `markSettlementSettled` (`apps/api/.../stripe/dispatch.ts`), which marks
   * IN THE SAME TRANSACTION as the ledger write, and `markSettledFromReconcile`
   * (`apps/api/.../credit-session/end-session.ts`), whose repair arm now routes through that
   * very function. So a `settled` row WITHOUT a credit is not a normal shape with a benign
   * explanation — it is a row written by a path that erased the debt evidence before (or
   * instead of) recording the money. Post-fix this finder returns `[]` forever; it exists to
   * surface rows ALREADY corrupted in production and to fail loudly if anyone reintroduces a
   * settled-without-credit write.
   *
   * The predicate, term by term:
   *   · `settlement_status = 'settled'` — the claim being audited. (A safe literal in an index
   *     predicate too: `'settled'` shipped in the original `CREATE TYPE`, migration 0048, so the
   *     `ADD VALUE` restriction recorded on `enums.ts` does not apply to it.)
   *   · `settled_at <= cutoff` — the caller passes `now − 60min`, generously past the ~10-minute
   *     stuck-settlement cutoff, so an in-flight reconcile is never reported as a corruption.
   *     Anchored on `settled_at` because `markSettlementResult` stamps it on exactly this
   *     transition. A legacy row with `settled_at` NULL is therefore EXCLUDED (`lte` on NULL is
   *     NULL ⇒ not true) — deliberate: it predates the stamp and has no reliable clock.
   *   · `credit_ledger.id IS NULL` over a LEFT JOIN on `(session_id, wallet_id, reason =
   *     'overdraft_settlement')` — the anti-join. `wallet_id` rides the join alongside
   *     `session_id` so a row mis-attributed to another wallet cannot satisfy the audit; the
   *     ledger is APPEND-ONLY with NO `deleted_at`, so unlike `findFinalizedMissingPayout` there
   *     is no soft-delete term to add here.
   *   · `deleted_at IS NULL` — the shipped soft-delete convention.
   *
   * Rides `credit_sessions_settled_missing_credit_idx` (migration 0080) — `(settled_at) WHERE
   * settlement_status = 'settled' AND deleted_at IS NULL`. Nothing served `settled` before it:
   * `credit_sessions_settling_idx` is partial on `'processing'` only.
   *
   * Ordered oldest-settled first and batch-bounded via `limit`. ⚠ The CALLER must `log.warn` when
   * the batch FILLS — a silent cap on a money alarm reads as "nothing is wrong".
   */
  async findSettledMissingLedgerCredit(cutoff: Date, limit = 100): Promise<CreditSession[]> {
    const rows = await db
      .select({ session: creditSessions })
      .from(creditSessions)
      .leftJoin(
        creditLedger,
        and(
          eq(creditLedger.sessionId, creditSessions.id),
          eq(creditLedger.walletId, creditSessions.walletId),
          eq(creditLedger.reason, 'overdraft_settlement')
        )
      )
      .where(
        and(
          eq(creditSessions.settlementStatus, 'settled'),
          lte(creditSessions.settledAt, cutoff),
          isNull(creditSessions.deletedAt),
          isNull(creditLedger.id)
        )
      )
      .orderBy(asc(creditSessions.settledAt))
      .limit(limit);
    return rows.map((row) => row.session);
  },

  /**
   * BAL-399 reconciliation finder (the durability BACKSTOP for the expert-always-paid guarantee at
   * the disbursement layer): sessions FINALIZED under BAL-399 semantics (`billing_finalized_at`
   * stamped — legacy pre-deploy ended sessions have it NULL and are excluded) that have NO live
   * payout obligation. A LEFT-JOIN anti-join on `expert_payout_records` (the deleted-row filter is
   * in the JOIN so a soft-deleted obligation still counts as "missing"). Covers ALL four ending
   * paths uniformly because it keys on the DB END-STATE, not the trigger: a crash — or a swallowed
   * `finalizeBilling.record()` throw — between the `end()` commit and the payout booking leaves
   * exactly this shape. `cutoff` is `now − grace`, so a legitimate in-flight finalize (the µs
   * between `end()` commit and `record()` commit) is never raced. Batch-bounded via `limit`.
   */
  async findFinalizedMissingPayout(cutoff: Date, limit = 100): Promise<CreditSession[]> {
    const rows = await db
      .select({ session: creditSessions })
      .from(creditSessions)
      .leftJoin(
        expertPayoutRecords,
        and(
          eq(expertPayoutRecords.sessionId, creditSessions.id),
          isNull(expertPayoutRecords.deletedAt)
        )
      )
      .where(
        and(
          isNotNull(creditSessions.billingFinalizedAt),
          lte(creditSessions.billingFinalizedAt, cutoff),
          isNull(creditSessions.deletedAt),
          isNull(expertPayoutRecords.id)
        )
      )
      .orderBy(asc(creditSessions.billingFinalizedAt))
      .limit(limit);
    return rows.map((row) => row.session);
  },

  /**
   * BAL-412 — THE DURABILITY BACKSTOP: `presence` sessions whose MEETING has ended but which
   * never settled.
   *
   * ⚠ IT EXISTS BECAUSE SETTLEMENT IS CALLED BEST-EFFORT. Both terminal paths (the End button
   * and the lifecycle sweep) invoke it NON-FATALLY — the same posture as the Daily room
   * teardown — so a settlement fault can never fail an End request or abort a sweep tick. That
   * trade needs a backstop, and it needs a NEW one: `findFinalizedMissingPayout` keys on
   * `billing_finalized_at IS NOT NULL` and therefore cannot see this shape at all, which is
   * the exact OPPOSITE half of the space. A meeting ended with an unsettled session is a
   * stranding shape nothing else on main can find.
   *
   * The predicate, term by term:
   *   · `duration_source = 'presence'` — only this provenance settles from presence;
   *     `live_capture` finalizes at hang-up and `external` awaits BAL-133.
   *   · `billing_finalized_at IS NULL` — the unsettled half. This is also the marker
   *     `settleFromPresence` re-checks under the row lock, so a row picked up here and
   *     settled by a racing terminal path is a harmless `alreadySettled` no-op.
   *   · `status <> 'cancelled'` — a cancelled session never bills, so its marker stays NULL
   *     FOREVER; without this it would be returned on every tick, for the life of the row.
   *     (The same ruling as `findIdByMeetingId` and `sumExpertEarningsForEngagement`.)
   *   · `meetings.status = 'ended' AND meetings.ended_at <= cutoff` — an INNER join, so a
   *     session with a NULL `meeting_id` is structurally absent (it has no presence to settle
   *     from). `cutoff` is `now − grace`, so the microseconds between the meeting's
   *     termination commit and the terminal path's settlement are never raced.
   *   · both `deleted_at` guards.
   *
   * Rides `credit_sessions_presence_unsettled_idx` — `(duration_source, meeting_id) WHERE
   * billing_finalized_at IS NULL AND deleted_at IS NULL`. The two `IS NULL` tests imply the
   * predicate; `duration_source` is the leading scan key. See that index for why the enum
   * label is a KEY COLUMN rather than part of the predicate (it cannot be — `ADD VALUE`).
   *
   * ⚠ This is the operator ALERT read: it includes sessions whose settlement was permanently
   * refused and marked exhausted. The backstop itself reads `findPresenceSettlementCandidates`.
   *
   * Ordered oldest-ended first and batch-bounded via `limit`. ⚠ The CALLER must `log.warn`
   * when the batch FILLS — a silent cap on a money backstop reads as "nothing was stranded".
   *
   * ⚠⚠ G4 (second review round) — CORRECTING A NOW-FALSE CLAIM. This used to say "RETURNS `[]`
   * ON MAIN, ALWAYS (D10): nothing sets `duration_source='presence'`" — true before BAL-466,
   * false as of it: `openSession` (D1/D4) passes `durationSource: 'presence'` from
   * `joinMeetingAsMember`'s admission seam for every Case consultation a client is admitted to,
   * so this now returns real rows once such a session's meeting has ended and settlement has
   * not yet landed within the grace window.
   */
  async findPresenceUnsettled(cutoff: Date, limit = 100): Promise<CreditSession[]> {
    return selectPresenceUnsettled(presenceUnsettledTerms(cutoff), limit);
  },

  /**
   * The durability backstop's PASS-6 candidate read: {@link findPresenceUnsettled}'s predicate and
   * order, minus every session carrying a {@link PRESENCE_SETTLEMENT_EXHAUSTED_ACTION} marker.
   *
   * ⚠ A permanently refused settlement keeps `billing_finalized_at NULL` forever, so on
   * the unfiltered read it would sit at the head of the oldest-first batch on every tick and, once
   * `limit` such rows accumulate, starve every newer row behind them. The marker moves them out of
   * THIS read only; {@link findPresenceUnsettled} (the operator alert read) still returns them
   * until they actually settle.
   */
  async findPresenceSettlementCandidates(cutoff: Date, limit = 100): Promise<CreditSession[]> {
    return selectPresenceUnsettled(
      and(presenceUnsettledTerms(cutoff), notExists(exhaustionMarkerFor())),
      limit
    );
  },

  /**
   * How many presence sessions are unsettled AND marked exhausted — the ones pass 6 no longer
   * reads. The interim operator signal: a marked session must not go silent.
   */
  async countPresenceSettlementExhausted(cutoff: Date, exec: DbExecutor = db): Promise<number> {
    const [row] = await exec
      .select({ total: count() })
      .from(creditSessions)
      .innerJoin(meetings, eq(meetings.id, creditSessions.meetingId))
      .where(and(presenceUnsettledTerms(cutoff), exists(exhaustionMarkerFor())));
    return row?.total ?? 0;
  },

  /**
   * Write the {@link PRESENCE_SETTLEMENT_EXHAUSTED_ACTION} marker for a session whose settlement
   * was permanently refused (a {@link SettlementRefusedError}) — `actor_user_id` NULL, a system
   * act. Append-only: a duplicate marker is harmless, the candidate read needs only one.
   */
  async markPresenceSettlementExhausted(
    input: {
      sessionId: string;
      meetingId?: string;
      guard: SettlementRefusalGuard;
      error: string;
    },
    exec: DbExecutor = db
  ): Promise<{ markerId: string }> {
    const marker = await auditEventsRepository.record(
      {
        actorUserId: null,
        action: PRESENCE_SETTLEMENT_EXHAUSTED_ACTION,
        entityType: SESSION_AUDIT_ENTITY_TYPE,
        entityId: input.sessionId,
        metadata: {
          guard: input.guard,
          error: input.error,
          ...(input.meetingId === undefined ? {} : { meetingId: input.meetingId }),
          trigger: 'presence_settlement_backstop',
        },
      },
      exec
    );
    return { markerId: marker.id };
  },

  /**
   * BAL-410 BACKSTOP FINDER — `pending` sessions whose MEETING is `cancelled`.
   *
   * ⚠⚠ WHY A BACKSTOP EXISTS AT ALL. Cancelling a meeting removes it from the ONLY actor that
   * would ever have ended its session: `meeting-lifecycle-sweep` scans
   * `['scheduled','waiting_for_participants','in_progress']` and never sees a `cancelled` row.
   * The in-request release in `apps/api`'s cancel route therefore has NO SECOND CHANCE, and a
   * single transient failure between the meeting commit and that release strands the hold
   * PERMANENTLY: the company's available balance is reduced forever AND `open()`'s
   * one-live-session-per-wallet gate (`session_in_progress`) locks that company out of every
   * future Case session. This finder is that second chance.
   *
   * ⚠⚠ THIS IS NOT A WIDENING OF `findStalePending`, AND THE DISTINCTION IS THE WHOLE POINT.
   * That finder excludes `duration_source='presence'` to protect the NO-SHOW SETTLEMENT of an
   * ENDED meeting, and its docblock says outright "Do not fix the asymmetry by widening it
   * back" — because `cancelled` is a trap door for a settleable row. On a CANCELLED meeting
   * there is nothing to settle: `findPresenceUnsettled` requires `meetings.status='ended'`, so
   * no settlement can ever run for these rows, and `cancelled` is the only correct terminal for
   * them. Hence there is deliberately NO `duration_source` filter here — every provenance is
   * releasable once its meeting is gone — and this finder is scoped by the MEETING's status
   * rather than by a clock, so it can never reach a row `findStalePending` is protecting.
   *
   * ⚠ NO CUTOFF, DELIBERATELY. A cancelled meeting is immediately final; there is no grace
   * window to respect, and racing the in-request release is safe because
   * `creditSessionsRepository.cancel` returns early on an already-`cancelled` session.
   *
   * Join shape mirrors `findPresenceUnsettled` — an INNER join, so a session with a NULL
   * `meeting_id` is structurally absent (it has no meeting to have been cancelled). Both
   * `deleted_at` guards. Ordered oldest-created first and batch-bounded via `limit`.
   */
  async findPendingForCancelledMeetings(limit = 100): Promise<CreditSession[]> {
    const rows = await db
      .select({ session: creditSessions })
      .from(creditSessions)
      .innerJoin(meetings, eq(meetings.id, creditSessions.meetingId))
      .where(
        and(
          // Enum literals at QUERY time are always safe (the ADD-VALUE restriction is index
          // predicates + CHECKs).
          eq(creditSessions.status, 'pending'),
          isNull(creditSessions.deletedAt),
          eq(meetings.status, 'cancelled'),
          isNull(meetings.deletedAt)
        )
      )
      .orderBy(asc(creditSessions.createdAt), asc(creditSessions.id))
      .limit(limit);
    return rows.map((row) => row.session);
  },

  /**
   * BAL-474 (D11.2, security N2) — `pending` PRESENCE sessions whose meeting is still `scheduled` but
   * now starts BEYOND the join window: the backstop for a reschedule that moved a call out after its
   * in-window admission opened a session and a hold. The reschedule itself releases the session
   * (`rescheduleMeeting` → `releaseCreditHoldBestEffort`); this finder is the second chance if that
   * best-effort release failed, and the arm that catches a session opened before this shipped.
   *
   * ⚠ `meetings.status = 'scheduled'` IS THE POINT: a session on a `waiting_for_participants` /
   * `in_progress` meeting is a live call, and a billing-start session is always `in_progress`, so this
   * can never select one. `scheduled_start > now + window` rides `meeting_status_scheduled_start_idx`.
   * Both `deleted_at` guards; an INNER join, so a session with no meeting is structurally absent; no
   * `duration_source` filter needs asserting beyond `presence` — a `live_capture` session opened by an
   * actor is not this finder's to cancel. Oldest-created first, batch-bounded via `limit`.
   */
  async findPendingBeyondJoinWindow(input: {
    now: Date;
    windowMs: number;
    limit?: number;
  }): Promise<CreditSession[]> {
    const rows = await db
      .select({ session: creditSessions })
      .from(creditSessions)
      .innerJoin(meetings, eq(meetings.id, creditSessions.meetingId))
      .where(
        and(
          eq(creditSessions.status, 'pending'),
          eq(creditSessions.durationSource, 'presence'),
          isNull(creditSessions.deletedAt),
          eq(meetings.status, 'scheduled'),
          isNull(meetings.deletedAt),
          gt(meetings.scheduledStart, new Date(input.now.getTime() + input.windowMs))
        )
      )
      .orderBy(asc(creditSessions.createdAt), asc(creditSessions.id))
      .limit(input.limit ?? 100);
    return rows.map((row) => row.session);
  },

  /**
   * BAL-474 (ADR-1040 Amendment 7 §D.1, D5.4 / D7.5) — THE SESSIONLESS DURABILITY BACKSTOP'S
   * FINDER: ended Case meetings that have NO session and NO terminal marker. `findPresenceUnsettled`
   * can only retry sessions that already exist; a client no-show, an admission-time open that was
   * refused or threw, and a guest-only call all leave NO session — and a terminal-path attempt that
   * threw after `endMeeting` committed would otherwise have no retry path at all.
   *
   * The predicate, term by term:
   *   · `status = 'ended'`, not soft-deleted — REGARDLESS of `outcome` (a human End and the
   *     `abandoned_wait` rule both write `outcome` NULL);
   *   · `scheduled_start >= windowStart` AND `ended_at >= windowStart` — bounded on BOTH columns
   *     (D7.5); the first rides `meeting_status_scheduled_start_idx`. `ended_at <= endedBefore`
   *     leaves the inline terminal path its grace;
   *   · the PRIMARY context is a `case` — the SQL mirror of `selectPrimaryMeetingContext`: a live
   *     `case` context with an id, and NO live context of the TOP precedence tier that is a
   *     DIFFERENT `(type, id)` (an exact duplicate row is not ambiguity). The tier is DERIVED from
   *     `MEETING_CONTEXT_PRECEDENCE` (`TOP_TIER_CONTEXT_TYPES`), never restated; `admin` scores 0
   *     and can never tie `case`, so it needs no branch. A parity test runs one table of context
   *     sets through both the pure rule and this finder;
   *   · no NON-cancelled, non-deleted session (`credit_sessions_meeting_idx`) — a meeting whose
   *     only session was cancelled IS selected;
   *   · no `credit_session.sessionless_meeting_marked` row (`audit_events_entity_idx`) — a marked
   *     meeting leaves the finder forever.
   *
   * Ordered oldest-ended first and batch-bounded via `limit`. ⚠ The CALLER must `log.warn` when the
   * batch FILLS. No new index (plan §5).
   */
  async findSessionlessEndedCaseMeetings(input: {
    endedBefore: Date;
    windowStart: Date;
    limit?: number;
  }): Promise<SessionlessCaseMeetingCandidate[]> {
    const tied = alias(meetingContexts, 'tied_context');
    const rows = await db
      .select({
        meetingId: meetings.id,
        scheduledStart: meetings.scheduledStart,
        endedAt: meetings.endedAt,
      })
      .from(meetings)
      .where(
        and(
          eq(meetings.status, 'ended'),
          isNull(meetings.deletedAt),
          gte(meetings.scheduledStart, input.windowStart),
          gte(meetings.endedAt, input.windowStart),
          lte(meetings.endedAt, input.endedBefore),
          exists(
            db
              .select({ one: sql`1` })
              .from(meetingContexts)
              .where(
                and(
                  eq(meetingContexts.meetingId, meetings.id),
                  eq(meetingContexts.contextType, 'case'),
                  isNotNull(meetingContexts.contextId),
                  isNull(meetingContexts.deletedAt),
                  notExists(
                    db
                      .select({ one: sql`1` })
                      .from(tied)
                      .where(
                        and(
                          eq(tied.meetingId, meetings.id),
                          isNull(tied.deletedAt),
                          isNotNull(tied.contextId),
                          inArray(tied.contextType, [...TOP_TIER_CONTEXT_TYPES]),
                          or(
                            ne(tied.contextType, meetingContexts.contextType),
                            ne(tied.contextId, meetingContexts.contextId)
                          )
                        )
                      )
                  )
                )
              )
          ),
          notExists(
            db
              .select({ one: sql`1` })
              .from(creditSessions)
              .where(
                and(
                  eq(creditSessions.meetingId, meetings.id),
                  ne(creditSessions.status, 'cancelled'),
                  isNull(creditSessions.deletedAt)
                )
              )
          ),
          notExists(
            db
              .select({ one: sql`1` })
              .from(auditEvents)
              .where(
                and(
                  eq(auditEvents.entityType, 'meeting'),
                  eq(auditEvents.entityId, meetings.id),
                  eq(auditEvents.action, SESSIONLESS_CASE_MEETING_MARKED_ACTION)
                )
              )
          )
        )
      )
      // The row leaves the finder at the EARLIER of `scheduled_start + window` and `ended_at + window`
      // (both are bounded above), so the one nearest to dropping is tried first.
      .orderBy(asc(sql`LEAST(${meetings.scheduledStart}, ${meetings.endedAt})`), asc(meetings.id))
      .limit(input.limit ?? 100);
    // `ended_at` is NOT NULL on every selected row (the range predicate excludes NULL); the
    // narrowing only restates that for the type system.
    return rows.flatMap((row) =>
      row.endedAt === null
        ? []
        : [{ meetingId: row.meetingId, scheduledStart: row.scheduledStart, endedAt: row.endedAt }]
    );
  },

  /**
   * BAL-474 (ADR-1040 Amendment 7 §D.3, D5.4) — write the TERMINAL MARKER that takes an ended,
   * sessionless Case meeting out of {@link findSessionlessEndedCaseMeetings} forever, and — when
   * `outcome` is given — resolve `meetings.outcome` FIRST-WRITE-WINS, in ONE transaction. For a zero
   * shape that is the outcome the settlement transaction would have written had a session existed;
   * an outcome write never happens outside this transaction (never `setOutcomeIfUnset(db)`).
   *
   * The marker is an `audit_events` row: `entity_type 'meeting'`, `actor_user_id` NULL (a system
   * act), `metadata { disposition, reason, shape?, trigger }`. Append-only — a duplicate marker is
   * harmless; the finder needs only one.
   */
  async markSessionlessCaseMeeting(
    input: MarkSessionlessCaseMeetingInput,
    exec: Database = db
  ): Promise<MarkSessionlessCaseMeetingResult> {
    return exec.transaction(async (tx) => {
      const marker = await auditEventsRepository.record(
        {
          actorUserId: null,
          action: SESSIONLESS_CASE_MEETING_MARKED_ACTION,
          entityType: 'meeting',
          entityId: input.meetingId,
          metadata: {
            disposition: input.disposition,
            reason: input.reason,
            trigger: input.trigger,
            ...(input.shape === undefined ? {} : { shape: input.shape }),
          },
        },
        tx
      );
      const outcomeWritten =
        input.outcome === undefined
          ? false
          : await meetingsRepository.setOutcomeIfUnset(tx, {
              meetingId: input.meetingId,
              outcome: input.outcome,
              actorUserId: null,
            });
      return { markerId: marker.id, outcomeWritten };
    });
  },
};
