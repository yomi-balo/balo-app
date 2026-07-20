/**
 * BAL-399 (ADR-1040 / ADR-1043) — the PURE money-block projection.
 *
 * A dependency-free module (NO `@balo/db`, NO postgres, NO I/O) behind the
 * `@balo/shared/credit` subpath so BOTH the apps/api money-block route and the apps/web
 * recap fragment share ONE payload type — and the fragment can consume it without dragging
 * the postgres driver into the client bundle (memory `reference_balo_db_client_bundle_footgun`).
 *
 * Three lens-typed payloads on the fee-concealment audience axis (client / expert / admin):
 *  - CLIENT sees the all-in charge only — NEVER the expert rate/accrual, the fee, or the margin.
 *  - EXPERT sees own earnings only — NEVER the client rate, the fee, the margin, or the
 *    overdraft the client's card settled.
 *  - ADMIN is the SOLE relaxed lens — it may surface `marginAudMinor` + `baloFeeBps`.
 *
 * The builders enforce the `pending` / `finalized` discriminant: while `billingFinalizedAt`
 * is NULL the receipt is PENDING and EVERY derived money figure is 0 (the recap shows elapsed
 * only, from `deriveDrawdownState`), so a pending receipt never leaks a finalized number.
 *
 * Margin is `clientCharge − expertEarnings` from the session's IMMUTABLE snapshots — never an
 * ad-hoc markup re-derivation (the rates are already snapshotted at `open`).
 */

/** Which path finalized the billing (mirrors `@balo/db` `CreditFinalizationPath`; kept local to stay db-free). */
export type MoneyBlockFinalizationPath =
  | 'live_capture'
  | 'confirmed'
  | 'disputed'
  | 'auto_confirmed';

/** Expert payout obligation status (mirrors `@balo/db` `ExpertPayoutRecordStatus`; kept local to stay db-free). */
export type MoneyBlockPayoutStatus = 'recorded' | 'disbursing' | 'paid' | 'failed';

/** The audience lens a money block was projected for. */
export type MoneyBlockLens = 'client' | 'expert' | 'admin';

/** `pending` ⇒ elapsed-only receipt (money not finalized); `finalized` ⇒ the figures are set. */
export type MoneyBlockState = 'pending' | 'finalized';

/**
 * CLIENT lens — the all-in charge. Structurally carries NO expert rate/accrual, NO
 * `baloFeeBps`, NO margin, NO Stripe reference. `amountAudMinor` already includes any
 * extra-time (grace) minutes — those tick at the client rate and count in `durationMinutes`.
 */
export interface ClientMoneyBlock {
  lens: 'client';
  state: MoneyBlockState;
  sessionId: string;
  /** Charged minutes (0 while pending). */
  durationMinutes: number;
  /** connectedMinutes × clientRateMinorPerMinute — the all-in charge (0 while pending). */
  amountAudMinor: number;
  /** The marked-up per-minute rate snapshot (already shown live; client-safe). */
  ratePerMinuteMinor: number;
  /** Settlement pill hint (client-safe status string). */
  settlementStatus: string;
  /** Which path finalized (omitted while pending). */
  finalizationPath?: MoneyBlockFinalizationPath;
}

/**
 * EXPERT lens — own earnings only. Reads EXACTLY the columns the client view excludes
 * (`expertRateMinorPerMinute` → `expertAccruedMinor`). Carries NO client rate/charge, NO
 * `baloFeeBps`, NO margin, NO `overdraftSettledMinor` (the client's charge), NO Stripe reference.
 */
export interface ExpertMoneyBlock {
  lens: 'expert';
  state: MoneyBlockState;
  sessionId: string;
  /** Charged minutes (0 while pending). */
  durationMinutes: number;
  /** = expertAccruedMinor — the expert's own earnings (0 while pending). */
  earningsAudMinor: number;
  /** The booked payout obligation's status, if any (from expert_payout_records). */
  payoutStatus?: MoneyBlockPayoutStatus;
  /** Which path finalized (omitted while pending). */
  finalizationPath?: MoneyBlockFinalizationPath;
}

/** ADMIN lens — the SOLE margin-bearing surface. Full economics incl. margin + fee. */
export interface AdminMoneyBlock {
  lens: 'admin';
  state: MoneyBlockState;
  sessionId: string;
  /** Charged minutes (0 while pending). */
  durationMinutes: number;
  /** connectedMinutes × clientRateMinorPerMinute — the client all-in (0 while pending). */
  clientChargeAudMinor: number;
  /** = expertAccruedMinor — the expert accrual (0 while pending). */
  expertEarningsAudMinor: number;
  /** clientCharge − expertEarnings, from the SNAPSHOTTED rates (0 while pending). */
  marginAudMinor: number;
  /** The fee snapshot (bps). */
  baloFeeBps: number;
  /** Extra-time settled to the card (0 while pending). */
  overdraftSettledMinor: number;
  /** Which path finalized (omitted while pending). */
  finalizationPath?: MoneyBlockFinalizationPath;
}

/**
 * The member/expert money block a `GET /sessions/:id/money-block` response carries (the ADMIN
 * lens is served only on the platform-gated route). Declared ONCE here so the api resolver, the
 * web fetch module, and the web fragment all share the SAME union alias.
 */
export type SessionMoneyBlock = ClientMoneyBlock | ExpertMoneyBlock;

/** Snapshot fields the CLIENT builder reads (fee-safe subset). */
export interface ClientMoneyBlockInput {
  sessionId: string;
  connectedMinutes: number;
  clientRateMinorPerMinute: number;
  settlementStatus: string;
  billingFinalizedAt: Date | null;
  finalizationPath: MoneyBlockFinalizationPath | null;
}

/** Snapshot fields the EXPERT builder reads (own-economics subset). */
export interface ExpertMoneyBlockInput {
  sessionId: string;
  connectedMinutes: number;
  expertAccruedMinor: number;
  billingFinalizedAt: Date | null;
  finalizationPath: MoneyBlockFinalizationPath | null;
  /** Threaded in by the caller from expert_payout_records (never a session column). */
  payoutStatus?: MoneyBlockPayoutStatus;
}

/** Snapshot fields the ADMIN builder reads (full economics — the sole relaxed input). */
export interface AdminMoneyBlockInput {
  sessionId: string;
  connectedMinutes: number;
  clientRateMinorPerMinute: number;
  expertAccruedMinor: number;
  baloFeeBps: number;
  overdraftSettledMinor: number;
  billingFinalizedAt: Date | null;
  finalizationPath: MoneyBlockFinalizationPath | null;
}

/** The pending/finalized discriminant: finalized only once `billingFinalizedAt` is stamped. */
function deriveState(billingFinalizedAt: Date | null): MoneyBlockState {
  return billingFinalizedAt === null ? 'pending' : 'finalized';
}

/** Build the CLIENT money block. Pending ⇒ every derived figure is 0 (never leaks the total). */
export function buildClientMoneyBlock(input: ClientMoneyBlockInput): ClientMoneyBlock {
  const state = deriveState(input.billingFinalizedAt);
  const finalized = state === 'finalized';
  const durationMinutes = finalized ? input.connectedMinutes : 0;
  const block: ClientMoneyBlock = {
    lens: 'client',
    state,
    sessionId: input.sessionId,
    durationMinutes,
    amountAudMinor: finalized ? durationMinutes * input.clientRateMinorPerMinute : 0,
    ratePerMinuteMinor: input.clientRateMinorPerMinute,
    settlementStatus: input.settlementStatus,
  };
  if (finalized && input.finalizationPath !== null) {
    block.finalizationPath = input.finalizationPath;
  }
  return block;
}

/** Build the EXPERT money block. Reads own earnings only; pending ⇒ every figure is 0. */
export function buildExpertMoneyBlock(input: ExpertMoneyBlockInput): ExpertMoneyBlock {
  const state = deriveState(input.billingFinalizedAt);
  const finalized = state === 'finalized';
  const block: ExpertMoneyBlock = {
    lens: 'expert',
    state,
    sessionId: input.sessionId,
    durationMinutes: finalized ? input.connectedMinutes : 0,
    earningsAudMinor: finalized ? input.expertAccruedMinor : 0,
  };
  if (input.payoutStatus !== undefined) {
    block.payoutStatus = input.payoutStatus;
  }
  if (finalized && input.finalizationPath !== null) {
    block.finalizationPath = input.finalizationPath;
  }
  return block;
}

/** Build the ADMIN money block — margin from snapshots. Pending ⇒ every figure is 0. */
export function buildAdminMoneyBlock(input: AdminMoneyBlockInput): AdminMoneyBlock {
  const state = deriveState(input.billingFinalizedAt);
  const finalized = state === 'finalized';
  const durationMinutes = finalized ? input.connectedMinutes : 0;
  const clientChargeAudMinor = finalized ? durationMinutes * input.clientRateMinorPerMinute : 0;
  const expertEarningsAudMinor = finalized ? input.expertAccruedMinor : 0;
  const block: AdminMoneyBlock = {
    lens: 'admin',
    state,
    sessionId: input.sessionId,
    durationMinutes,
    clientChargeAudMinor,
    expertEarningsAudMinor,
    // Margin from the immutable snapshots — never an ad-hoc markup re-derivation.
    marginAudMinor: clientChargeAudMinor - expertEarningsAudMinor,
    baloFeeBps: input.baloFeeBps,
    overdraftSettledMinor: finalized ? input.overdraftSettledMinor : 0,
  };
  if (finalized && input.finalizationPath !== null) {
    block.finalizationPath = input.finalizationPath;
  }
  return block;
}
