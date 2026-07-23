import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import {
  applyBaloFee,
  deriveMinuteRateCents,
  DEFAULT_BALO_FEE_BPS,
  DEFAULT_OVERDRAFT_CEILING_MINOR,
  LOW_BALANCE_WARNING_MINUTES,
  NEAR_WRAP_MINUTES,
  OVERDRAFT_GRACE_MINUTES,
} from '@balo/shared/pricing';
import { isWalletMandateActive } from '@balo/shared/credit';
import { db } from '../client';
import {
  creditHolds,
  creditSessions,
  creditWallets,
  expertPayoutRecords,
  expertProfiles,
  type CreditSession,
  type CreditSessionStatus,
  type CreditSettlementStatus,
  type CreditFinalizationPath,
  type CreditWallet,
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

/** The audit action + entity type for the expert-always-paid accrual record (ADR-1030). */
export const SESSION_EXPERT_ACCRUED_ACTION = 'credit_session.expert_accrued' as const;
export const SESSION_AUDIT_ENTITY_TYPE = 'credit_session' as const;

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

export interface MarkSettlementResultInput {
  sessionId: string;
  status: Extract<CreditSettlementStatus, 'processing' | 'settled' | 'failed' | 'requires_action'>;
  /** The settlement PaymentIntent (reconciliation). */
  stripePaymentIntentId?: string | null;
  now?: Date;
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
    if (
      state.lowWarnedAtMs === null &&
      Math.floor(state.balance / params.rate) <= LOW_BALANCE_WARNING_MINUTES
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
   * Sessions the reaper must meter — status ∈ {active, grace}, oldest-connected first.
   * BAL-399: `duration_source = 'live_capture'` only — an `external` session is settled via
   * BAL-133 confirmation (`applyExternalDuration`), never wall-clock metered.
   */
  async findMeterable(): Promise<CreditSession[]> {
    return db
      .select()
      .from(creditSessions)
      .where(
        and(
          inArray(creditSessions.status, ['active', 'grace']),
          eq(creditSessions.durationSource, 'live_capture'),
          isNull(creditSessions.deletedAt)
        )
      )
      .orderBy(asc(creditSessions.connectedAt));
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
   * One-shot markers: `lowWarnedAt` (active, minutesRemaining ≤ LOW_BALANCE_WARNING_MINUTES),
   * `nearWrapWarnedAt` (grace, grace-remaining OR ceiling-room ≤ NEAR_WRAP_MINUTES).
   */
  async meterSessionToNow(sessionId: string, now: Date): Promise<MeterSessionResult> {
    return db.transaction(async (tx) => {
      const session = await readSessionForUpdate(tx, sessionId);
      if (session === undefined) {
        throw new SessionNotFoundError(sessionId);
      }
      // Only active/grace sessions meter; a null anchor cannot be metered. BAL-399: an
      // `external` session is settled via BAL-133 confirmation, never wall-clock metered —
      // early-return defensively even if the reaper finder's guard were ever bypassed.
      if (
        (session.status !== 'active' && session.status !== 'grace') ||
        session.connectedAt === null ||
        session.durationSource !== 'live_capture'
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

      const params: MeterParams = {
        rate: session.clientRateMinorPerMinute,
        expertRate: session.expertRateMinorPerMinute,
        ceiling: session.effectiveCeilingMinor,
        graceBoundMs: session.graceBoundMinutes * 60_000,
        nearWrapMs: NEAR_WRAP_MINUTES * 60_000,
        mandateActive: isWalletMandateActive(wallet),
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
          await applyActiveTick(tx, session, state, params, seq, tickTimeMs, transitions);
        } else {
          await applyGraceTick(tx, session, state, params, seq, tickTimeMs, transitions);
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
   */
  async findStalePending(cutoff: Date): Promise<CreditSession[]> {
    return db
      .select()
      .from(creditSessions)
      .where(
        and(
          eq(creditSessions.status, 'pending'),
          lte(creditSessions.createdAt, cutoff),
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
};
