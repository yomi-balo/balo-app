import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import {
  applyBaloFee,
  deriveMinuteRateCents,
  DEFAULT_BALO_FEE_BPS,
  DEFAULT_OVERDRAFT_CEILING_MINOR,
  LOW_BALANCE_WARNING_MINUTES,
  MAX_SESSION_MINUTES,
  NEAR_WRAP_MINUTES,
  OVERDRAFT_GRACE_MINUTES,
} from '@balo/shared/pricing';
import { isWalletMandateActive, minutesOfRunway } from '@balo/shared/credit';
import { db, type Database } from '../client';
import {
  creditHolds,
  creditSessions,
  creditWallets,
  expertPayoutRecords,
  expertProfiles,
  meetings,
  type CreditDurationSource,
  type CreditSession,
  type CreditSessionStatus,
  type CreditSettlementShape,
  type CreditSettlementStatus,
  type CreditFinalizationPath,
  type CreditWallet,
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
   * sweep, which resolves through the seam, ages out another. CARRIED BY **BAL-400**
   * (booking — the first caller to pass both) with **BAL-129** supplying the meeting;
   * **BAL-412** and reporting consume `engagement_id` as given.
   */
  meetingId?: string | null;
  engagementId?: string | null;
  /**
   * BAL-412 seam (D11) — how this session's billable duration will be established. Defaults
   * to `'live_capture'`, which is exactly what every shipped caller gets today.
   *
   * ⚠⚠ **NOTHING ON MAIN PASSES THIS, AND THAT IS THE INERTNESS (D10).** `'presence'` is the
   * enabling condition for the entire settlement engine below — `settleFromPresence`,
   * `findPresenceUnsettled` and the widened `findMeterable` are all unreachable in production
   * until a caller sets it. The caller that will is **BAL-466** (session open), behind
   * **BAL-400** (booking); `apps/web`'s `openSessionAction` has zero non-test callers today.
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
   * wrongly. The obligation is BAL-466's.
   */
  durationSource?: CreditDurationSource;
}

/**
 * `open` outcome. Money-gate rejections (`account_hold` / `settlement_pending` /
 * `insufficient_no_mandate`), the one-live-session-per-wallet stop (`session_in_progress`), and
 * the rate-less-expert stop (`expert_rate_missing`, Decision Q9) are EXPECTED control flow
 * returned as a discriminated union — the service maps them to 409, not caught exceptions.
 *
 * `settlement_pending` blocks a NEW session while a PRIOR session's overdraft settlement has not
 * yet landed (`settlementStatus='processing'`, the webhook is the sole crediting authority) — or,
 * defensively, while the wallet balance is still negative. Opening now would let that prior
 * overdraft be folded into the next session's terminal `end` and charged a SECOND time (the
 * sequential co-charge).
 */
export type OpenSessionResult =
  | { ok: true; session: CreditSession }
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
}

export interface MeterSessionResult {
  session: CreditSession;
  transitions: MeterTransitions;
  /** How many `session_consume` ticks were newly posted this pass. */
  ticksPosted: number;
}

export interface EndSessionResult {
  session: CreditSession;
  /** Terminal negative-balance magnitude (the settlement basis; 0 when in credit). */
  overdraftMinor: number;
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
 * Nothing writes `credit_sessions.engagement_id` today (the live `openSession` service
 * passes neither it nor `meeting_id`; BAL-400 is the ticket that will), so EVERY case that
 * exists right now aggregates to `not_yet`. If that state carried `earningsAudMinor: 0`,
 * the case surface would render "A$0.00" — a MONEY CLAIM — for every expert on the
 * platform, and no amount of downstream care could tell it apart from a genuinely-zero
 * finalized session. Here the figure is STRUCTURALLY UNREPRESENTABLE until something has
 * actually finalized: `not_yet` and `pending` cannot HOLD a number, so the surface is
 * forced to render its designed empty/pending copy instead of a fabricated zero.
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
   * (`resolveMeetingSettlement`) defines it as `ruleMinutes > actualMinutes` — deliberately FALSE
   * when it was the Q1 NO-REFUND CLAMP, not the floor, that raised the figure. Re-deriving it
   * from `billableMinutes` (which is post-clamp) labels every clamp as a floor application, and
   * `credit_session.presence_settled` is the ONLY durable forensic record of that overcharge.
   * Persisted so `finalizeBilling`'s `floored:` analytics — the "how often does the minimum bind"
   * metric — reads the real answer instead of re-deriving the same wrong one.
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
  /** Terminal negative-balance magnitude (the settlement basis; 0 when in credit). */
  overdraftMinor: number;
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

/**
 * Reject a settlement input that is not whole, finite and non-negative BEFORE anything is
 * written. Not arithmetic — a domain guard on the ONE seam where a bad number becomes a
 * charge. A fractional `billableMinutes` would silently truncate into `connected_minutes`
 * (an `integer` column) and disagree with the ledger; a negative `topUpToTickSeq` is
 * harmless (the loop is empty) but is evidence the caller's maths broke, and a money path
 * should fail loudly on evidence rather than post a plausible amount.
 *
 * ⚠⚠ **AND IT IS BOUNDED FROM ABOVE, SYMMETRICALLY (F1).** The lower bound alone let an absurd
 * figure through: a `presence` session on a room nobody ever left settled at 480 minutes and was
 * charged OFF-SESSION against the stored mandate. `resolveMeetingSettlement` now caps
 * `ruleMinutes` at an injected `maxBillableMinutes`, but that is the CALLER's guard — this one
 * exists so a FUTURE SECOND CALLER that skips or misconfigures the pure core still cannot write
 * an unbillable number. `MAX_SESSION_MINUTES` is the same ceiling the reaper's force-end and
 * both the `estimatedMinutes` / `finalizeDuration` Zod schemas already hold every other
 * provenance to; a settlement above it is a defect, never a long consultation.
 *
 * ⚠ `billingFloorMinutes` is bounded for the same reason (F5): the floor is a MONEY input — an
 * operator who set `MEETING_NO_SHOW_FLOOR_MINUTES=900` thinking seconds would make every
 * no-show settle at 900 minutes. `apps/api`'s `resolveBillingFloorMs` discards such an override
 * at the config seam; this refuses it even from a caller that does not.
 */
function assertSettlementFigures(input: SettleFromPresenceRepoInput): void {
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
      throw new Error(
        `settleFromPresence: ${name} must be a non-negative integer (received ${String(value)})`
      );
    }
  }
  if (!Number.isInteger(input.topUpToTickSeq)) {
    throw new Error(
      `settleFromPresence: topUpToTickSeq must be an integer (received ${String(input.topUpToTickSeq)})`
    );
  }
  const bounded: ReadonlyArray<readonly [string, number]> = [
    ['billableMinutes', input.billableMinutes],
    ['actualMinutes', input.actualMinutes],
    ['topUpToTickSeq', input.topUpToTickSeq],
    ['billingFloorMinutes', input.billingFloorMinutes],
  ];
  for (const [name, value] of bounded) {
    if (value > MAX_SESSION_MINUTES) {
      throw new Error(
        `settleFromPresence: ${name} must not exceed MAX_SESSION_MINUTES (${String(MAX_SESSION_MINUTES)}) — received ${String(value)}. ` +
          'The caller caps the presence-derived figure (resolveMeetingSettlement takes a required ' +
          'maxBillableMinutes); this repository refuses to post an unbillable settlement.'
      );
    }
  }
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
  mandateActive: boolean;
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

  // Would cross zero WITHOUT a mandate → hard stop, no post (no overdraft without a card).
  if (!params.mandateActive) {
    wrapSession(state, tickTimeMs, transitions, false);
    return;
  }

  // Would cross zero WITH a mandate → enter grace and post the crossing minute (balance negative).
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

export const creditSessionsRepository = {
  /**
   * The pre-connect funds-or-mandate gate + hold + create-pending, in ONE wallet-locked
   * txn (§6). Steps: advisory-lock → soft-hold gate (open receivable) → one-live-session gate
   * → settlement-pending gate (reject while a prior session's settlement is `processing`, or the
   * balance is still negative — a prior overdraft is unsettled)
   * → snapshot the expert rate (reject if null, Q9) + derive marked-up/raw per-minute rates →
   * RE-DERIVE available `= balance − Σ active holds` UNDER the lock (never the advisory
   * `getAvailableBalance`) → connect gate (`available ≥ estimate OR mandate active`) → place the
   * hold in-txn → insert the pending session → link the hold back to it. Rejections are
   * returned, not thrown.
   */
  async open(input: OpenSessionInput): Promise<OpenSessionResult> {
    return db.transaction(async (tx) => {
      // 1. Serialise against every other writer on this wallet.
      await acquireWalletLock(tx, input.walletId);

      // 2. Soft-hold gate — no new sessions while a receivable is open.
      if (await creditReceivablesRepository.hasOpenReceivable(input.companyId, tx)) {
        return { ok: false, code: 'account_hold' };
      }

      // 2b. One live consultation per wallet. `end` settles the ENTIRE wallet terminal negative,
      //     so a SECOND non-terminal session on the same wallet would double-settle → the card is
      //     charged ~2×. The wallet advisory lock (step 1) serialises concurrent opens, so this
      //     read-then-reject is race-safe.
      const [inProgress] = await tx
        .select({ id: creditSessions.id })
        .from(creditSessions)
        .where(
          and(
            eq(creditSessions.walletId, input.walletId),
            inArray(creditSessions.status, ['pending', 'active', 'grace', 'wrapped']),
            isNull(creditSessions.deletedAt)
          )
        )
        .limit(1);
      if (inProgress !== undefined) {
        return { ok: false, code: 'session_in_progress' };
      }

      const wallet = await readWalletOrThrow(tx, input.walletId);

      // 2c. Settlement-pending gate — reject a new open while a PRIOR session's overdraft
      //     settlement is still IN FLIGHT (`settlementStatus='processing'`, the webhook is the
      //     sole crediting authority). Gate on that REAL predicate directly: a negative balance
      //     is only a PROXY, and it is defeated by any independent positive credit
      //     (`manual_purchase` / `auto_topup`) landing during the processing window — the credit
      //     masks the still-negative session balance, the balance-only check passes, and the new
      //     session's terminal `end` folds the prior uncredited overdraft into its own negative →
      //     the prior overdraft is charged a SECOND time (the sequential co-charge). The indexed
      //     `settlementStatus='processing'` lookup rides `credit_sessions_settling_idx`; the
      //     balance-sign check is retained as defense-in-depth.
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
      if (settling !== undefined || wallet.balanceMinor < 0) {
        return { ok: false, code: 'settlement_pending' };
      }

      // 3. Snapshot the expert rate (Q9 hard-stop on a rate-less expert).
      const [expert] = await tx
        .select({ rateCents: expertProfiles.rateCents })
        .from(expertProfiles)
        .where(eq(expertProfiles.id, input.expertProfileId))
        .limit(1);
      if (expert === undefined) {
        throw new ExpertProfileNotFoundError(input.expertProfileId);
      }
      if (expert.rateCents === null) {
        return { ok: false, code: 'expert_rate_missing' };
      }

      const expertHourly = expert.rateCents;
      const baloFeeBps = input.baloFeeBps ?? DEFAULT_BALO_FEE_BPS;
      const clientHourly = applyBaloFee(expertHourly, baloFeeBps);
      const clientRateMinorPerMinute = deriveMinuteRateCents(clientHourly);
      const expertRateMinorPerMinute = deriveMinuteRateCents(expertHourly);
      const estimateMinor = input.estimatedMinutes * clientRateMinorPerMinute;

      // 4. Re-derive available UNDER the lock (the money gate must not trust the advisory read).
      const available = wallet.balanceMinor - (await activeHoldsSum(tx, input.walletId));
      const mandateActive = isWalletMandateActive(wallet);

      // 5. Connect gate — fund the estimate OR present a mandate (Model C hard-stop otherwise).
      if (available < estimateMinor && !mandateActive) {
        return { ok: false, code: 'insufficient_no_mandate' };
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

      // 7. Insert the pending session with the full rate/ceiling snapshot.
      const effectiveCeilingMinor = wallet.overdraftCeilingMinor ?? DEFAULT_OVERDRAFT_CEILING_MINOR;
      const [session] = await tx
        .insert(creditSessions)
        .values({
          walletId: input.walletId,
          companyId: input.companyId,
          expertProfileId: input.expertProfileId,
          initiatingMemberId: input.initiatingMemberId,
          holdId: hold.id,
          estimatedMinutes: input.estimatedMinutes,
          expertRateMinorPerHour: expertHourly,
          baloFeeBps,
          clientRateMinorPerMinute,
          expertRateMinorPerMinute,
          effectiveCeilingMinor,
          graceBoundMinutes: OVERDRAFT_GRACE_MINUTES,
          // BAL-418 seam — both nullable, both optional; existing callers are unchanged.
          meetingId: input.meetingId ?? null,
          engagementId: input.engagementId ?? null,
          // BAL-412 seam — write-once provenance. Omitted ⇒ `'live_capture'`, i.e. exactly
          // what every shipped caller gets. NOTHING on main passes `'presence'` (D10).
          durationSource: input.durationSource ?? 'live_capture',
        })
        .returning();
      if (session === undefined) {
        throw new Error('Failed to insert credit session');
      }

      // 8. Link the hold back to the session (full two-way linkage).
      await tx
        .update(creditHolds)
        .set({ sessionId: session.id })
        .where(eq(creditHolds.id, hold.id));

      return { ok: true, session };
    });
  },

  /**
   * pending → active, stamping `connectedAt` (the metering anchor). Idempotent on an
   * already-`active` session (returns it unchanged, never re-anchoring the clock). No money,
   * no wallet lock. Any other current status is an illegal transition.
   */
  async connect(sessionId: string, opts: { now?: Date } = {}): Promise<CreditSession> {
    const now = opts.now ?? new Date();
    return db.transaction(async (tx) => {
      const session = await readSessionForUpdate(tx, sessionId);
      if (session === undefined) {
        throw new SessionNotFoundError(sessionId);
      }
      if (session.status === 'active') {
        return session; // idempotent — do not re-anchor connectedAt
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
      return updated;
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
   * The reusable extraction of the two inline gates in `open()` — but DELIBERATELY NOT used
   * to refactor `open()`, which needs the granular `session_in_progress` vs
   * `settlement_pending` rejection codes. Threads the caller's `exec` so it runs UNDER the
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
   * ⚠ RETURNS `not_yet` FOR EVERY CASE ON `main` TODAY, AND THAT IS CORRECT — the live
   * `openSession` service passes neither column (BAL-400 will). Do not "fix" the empty
   * result by widening the read. See {@link CaseExpertEarningsAggregate} for why the empty
   * state is a distinct value rather than a zero.
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
   *   · `meterSessionToNow` draws off the WALL CLOCK (`floor((now − connectedAt)/60s)`), so it
   *     keeps posting `session_consume` ticks for a room nobody is in;
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
   * `session_consume` tick from `lastTickSeq+1` to `floor((now − connectedAt)/60s)`, advance
   * the grace/ceiling/no-mandate state machine, set one-shot markers, and return the set of
   * NEWLY-crossed transitions. Deterministic + idempotent: a replayed tickSeq dedups on the
   * ledger UNIQUE (balance mirrors DB truth), so re-metering crosses nothing new.
   *
   * Transition rules (evaluated per tick):
   *  - active, would cross zero, mandate active  → enter grace, POST (balance goes negative).
   *  - active, would cross zero, NO mandate       → STOP: do not post, `wrapped` (key `end`).
   *  - grace, 30-min bound OR |balanceAfter| ≥ ceiling → POST the completing minute (warm,
   *    ≤1-min overshoot, Q6), then `wrapped`.
   *  - otherwise POST normally.
   * One-shot markers: `lowWarnedAt` (active, `minutesOfRunway(...)` ≤
   * LOW_BALANCE_WARNING_MINUTES), `nearWrapWarnedAt` (grace, grace-remaining OR ceiling-room ≤
   * NEAR_WRAP_MINUTES).
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
      const targetTickSeq = Math.floor((now.getTime() - connectedAtMs) / 60_000);
      if (targetTickSeq <= session.lastTickSeq) {
        return { session, transitions: {}, ticksPosted: 0 };
      }

      const meterParams: MeterParams = {
        rate: session.clientRateMinorPerMinute,
        expertRate: session.expertRateMinorPerMinute,
        ceiling: session.effectiveCeilingMinor,
        graceBoundMs: session.graceBoundMinutes * 60_000,
        nearWrapMs: NEAR_WRAP_MINUTES * 60_000,
        mandateActive: isWalletMandateActive(wallet),
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
   * balance (`overdraftMinor = −balance` if negative) → FINALIZE the expert accrual + write
   * the `credit_session.expert_accrued` audit row (the expert-always-paid record, committed
   * BEFORE any charge) → set `status='ended'`, `endedAt`, `overdraftSettledMinor`, and
   * `settlementStatus` (`not_required` when in credit, else `processing`). This method is
   * PURE DB — it never calls Stripe; it returns `overdraftMinor` + `mandateActive` for the
   * service to drive the off-session charge. Idempotent on an already-`ended` session.
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
      const overdraftMinor = wallet.balanceMinor < 0 ? -wallet.balanceMinor : 0;
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
        })
        .where(eq(creditSessions.id, session.id))
        .returning();
      if (updated === undefined) {
        throw new SessionNotFoundError(sessionId);
      }

      return {
        session: updated,
        overdraftMinor,
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
   *   6. Terminal balance read UNDER the lock (never `getAvailableBalance`, which is advisory).
   *   7. TWO audit rows — `credit_session.expert_accrued` (parity with `end()`, the
   *      expert-always-paid record) and `credit_session.presence_settled` (this ticket's
   *      reasoning record).
   *   8. `meetings.outcome`, via `setOutcomeIfUnset` on the same `tx` — first write wins, so
   *      the sweep's `missed_call` is never overwritten.
   *   9. The terminal session UPDATE.
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
   * `mandateActive` for the service to drive the off-session charge.
   *
   * ⚠ INERT ON MAIN (D10) — reachable only from a `duration_source='presence'` session, which
   * nothing opens (BAL-400 booking → BAL-466 session open).
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

    return exec.transaction(async (tx) => {
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
        throw new Error(
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

      // 6. Terminal balance, under the lock.
      const wallet = await readWalletOrThrow(tx, session.walletId);
      const overdraftMinor = wallet.balanceMinor < 0 ? -wallet.balanceMinor : 0;

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
        })
        .where(eq(creditSessions.id, session.id))
        .returning();
      if (updated === undefined) {
        throw new SessionNotFoundError(input.sessionId);
      }

      return {
        session: updated,
        overdraftMinor,
        expertAccruedMinor,
        mandateActive: isWalletMandateActive(wallet),
        alreadySettled: false,
        ticksPosted,
        outcomeWritten,
      };
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
    const [row] = await exec
      .update(creditSessions)
      .set(set)
      .where(eq(creditSessions.id, input.sessionId))
      .returning();
    if (row === undefined) {
      throw new SessionNotFoundError(input.sessionId);
    }
    return row;
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
   * Ordered oldest-ended first and batch-bounded via `limit`. ⚠ The CALLER must `log.warn`
   * when the batch FILLS — a silent cap on a money backstop reads as "nothing was stranded".
   *
   * ⚠ RETURNS `[]` ON MAIN, ALWAYS (D10): nothing sets `duration_source='presence'`.
   */
  async findPresenceUnsettled(cutoff: Date, limit = 100): Promise<CreditSession[]> {
    const rows = await db
      .select({ session: creditSessions })
      .from(creditSessions)
      .innerJoin(meetings, eq(meetings.id, creditSessions.meetingId))
      .where(
        and(
          // Enum literals at QUERY time are always safe (the ADD-VALUE restriction is index
          // predicates + CHECKs).
          eq(creditSessions.durationSource, 'presence'),
          isNull(creditSessions.billingFinalizedAt),
          ne(creditSessions.status, 'cancelled'),
          isNull(creditSessions.deletedAt),
          eq(meetings.status, 'ended'),
          lte(meetings.endedAt, cutoff),
          isNull(meetings.deletedAt)
        )
      )
      .orderBy(asc(meetings.endedAt), asc(creditSessions.id))
      .limit(limit);
    return rows.map((row) => row.session);
  },
};
