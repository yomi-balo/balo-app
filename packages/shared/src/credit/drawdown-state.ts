/**
 * BAL-378 (ADR-1040 Lane 2) — the PURE drawdown-state projection.
 *
 * A dependency-free module (NO `@balo/db`, NO postgres, NO I/O) behind the
 * `@balo/shared/credit` subpath so BOTH the apps/api route (`GET /sessions/:id/
 * drawdown-state`) and the apps/web `"use client"` in-session components share one
 * type — and the components can consume it without dragging the postgres driver into
 * the client bundle (the client-bundle footgun).
 *
 * `deriveDrawdownState` maps a session snapshot + the live wallet balance into the six
 * presentational keys (healthy | low | grace | near | wrap | end) across the client and
 * member lenses, with/without an active mandate (BAL-552 + BAL-405: the `wrap` AND `end` keys'
 * copy branches on `DrawdownInputs.mandateActive`). Copy ORIGINATES from the two design
 * prototypes (`in-session-sequence.jsx`, `member-variant.jsx`), except where a later
 * truthfulness fix superseded them (BAL-535 R3 on `low`, BAL-552 on `end`, BAL-405 on `low`'s
 * `graceAvailable` arm, `near`, `wrap` and `end`). Those four keys' prototype wording is an
 * ACCEPTED GAP, not drift: the shipped strings state presence-path truth (ADR-1052 D2 /
 * ADR-1040 Amendment 6 §H — the call never stops), and re-syncing the prototypes (including
 * `in-session-sequence.jsx`'s "at the ceiling the session pauses warmly" rationale) is its own
 * task. Tone rules honoured:
 *  - `elapsed` is session time, NEVER a countdown;
 *  - `minutesRemaining` / grace-room surface only when actionable;
 *  - SMS fires only on entering grace + nearing the wrap;
 *  - the word "overdraft" NEVER appears in any client/member-facing string
 *    ("keep me going" / "keeping you going" is its warm name).
 */

import { LOW_BALANCE_WARNING_MINUTES, NEAR_WRAP_MINUTES } from '../pricing';
import { minutesOfRunway } from './runway';

/** Persisted session status (mirrors `@balo/db` `CreditSessionStatus`; kept local to stay db-free). */
export type CreditSessionStatus =
  | 'pending'
  | 'active'
  | 'grace'
  | 'wrapped'
  | 'ended'
  | 'cancelled';

/** The presentational drawdown key derived on read (§5). */
export type DrawdownKey = 'healthy' | 'low' | 'grace' | 'near' | 'wrap' | 'end';

/** The meter bar descriptor the `SessionMeter` renders. */
export interface DrawdownMeter {
  mode: 'balance' | 'grace' | 'empty';
  /** 0–100 fill; balance mode = runway, grace mode = fill toward the ceiling. */
  pct: number;
  tone: 'blue' | 'amber' | 'grad' | 'faint';
  label: string;
}

/** The single call-to-action a notice card offers (client top-up vs member nudge). */
export interface DrawdownCta {
  kind: 'client_topup' | 'member_nudge';
  label: string;
  secondaryLabel?: string;
}

/** The typed prop the in-session components render off (shared api ↔ web). */
export interface DrawdownState {
  key: DrawdownKey;
  status: CreditSessionStatus;
  /** "HH:MM:SS" session time — NEVER remaining. */
  elapsed: string;
  meter: DrawdownMeter;
  tone: 'none' | 'amber' | 'keep' | 'wrap';
  title?: string;
  body?: string;
  cta?: DrawdownCta;
  channels: Array<'in-app' | 'sms'>;
  sms?: string;
  balanceMinor: number;
  /** Surfaced only when actionable (the `low` key). */
  minutesRemaining?: number;
  graceRemainingMinutes?: number;
  ceilingRoomMinor?: number;
  /**
   * BAL-523 — = the money path's `walletAllowsOverdraftGrace(wallet)`. Spelled without the word
   * "overdraft" because this object is serialised to the client. It is the SAME predicate —
   * never re-derive it here.
   */
  graceAvailable: boolean;
  lens: 'client' | 'member';
  /** Widget Gift chip (display only). */
  promoRemainingMinor?: number;
  ratePerMinuteMinor: number;
  /** The billing.manage holder named in the member-nudge cta. */
  adminName?: string;
}

/** The snapshot + live figures `deriveDrawdownState` projects from. */
export interface DrawdownInputs {
  status: CreditSessionStatus;
  connectedAt: Date | null;
  clientRateMinorPerMinute: number;
  effectiveCeilingMinor: number;
  graceBoundMinutes: number;
  graceEnteredAt: Date | null;
  /** Live wallet balance (drawn down by the reaper; negative in grace). */
  balanceMinor: number;
  /**
   * BAL-412 (ADR-1044 §7, D5/D6) — the billing floor in whole minutes, INJECTED (this module
   * reads no constant). Feeds the corrected `minutesOfRunway` (`@balo/shared/credit/runway`)
   * so early-session runway sets aside the unconsumed remainder of the floor before reporting
   * discretionary time. See that module's docblock for the worked example.
   */
  billingFloorMinutes: number;
  /**
   * BAL-412 (D6) — minutes ALREADY DRAWN against the balance (`credit_sessions.connected_
   * minutes`). Drawn, not elapsed — see `runway.ts`'s docblock for why the distinction matters.
   */
  minutesAlreadyDrawn: number;
  /** Reserved (pre-connect hold) — carried for widget availability context. */
  activeHoldsMinor?: number;
  promoRemainingMinor?: number;
  /**
   * BAL-523 — = the money path's `walletAllowsOverdraftGrace(wallet)`. Spelled without the word
   * "overdraft" because this object is serialised to the client. It is the SAME predicate —
   * never re-derive it here.
   */
  graceAvailable: boolean;
  /**
   * BAL-552 — = the money path's `isWalletMandateActive(wallet)`, NOT re-derived here. REQUIRED
   * (not optional): an optional field defaults to a silent `false`, which would tell a
   * live-mandate client they will not be charged — the exact defect this ticket removes.
   * Strictly WIDER than `graceAvailable` (`graceAvailable = isWalletMandateActive(w) &&
   * isCardBackedLowBalanceMode(w.lowBalanceMode)`), so the two are not interchangeable and
   * neither may be folded into the other.
   */
  mandateActive: boolean;
  lens: 'client' | 'member';
  adminName?: string;
  now: Date;
}

/** Ledger sums for the promo-remaining chip (§14 Q10). */
export interface PromoLedgerSums {
  /** Σ `reason='promo'` grants (positive minor units). */
  promoGrantedMinor: number;
  /** Σ consumption since the promo grant (positive minor units). */
  consumedSincePromoMinor: number;
  currentBalanceMinor: number;
}

const MS_PER_MINUTE = 60_000;
/** Display scale: ~an hour of runway reads as a full balance bar (presentation only). */
const METER_FULL_MINUTES = 60;
const MIN_METER_PCT = 3;

/**
 * Promo remaining for the widget Gift chip: `clamp(Σ promoGrants − Σ consumptionSincePromo,
 * 0, currentBalance)` (§14 Q10). Display-only — NEVER used in drawdown / settlement math.
 */
export function derivePromoRemainingMinor(sums: PromoLedgerSums): number {
  const remaining = sums.promoGrantedMinor - sums.consumedSincePromoMinor;
  const clampedLow = Math.max(0, remaining);
  return Math.min(clampedLow, Math.max(0, sums.currentBalanceMinor));
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

/** Session time as "HH:MM:SS" (never a countdown). A null anchor reads as 00:00:00. */
function formatElapsed(connectedAt: Date | null, now: Date): string {
  if (connectedAt === null) {
    return '00:00:00';
  }
  const totalSeconds = Math.max(0, Math.floor((now.getTime() - connectedAt.getTime()) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

/** Whole minutes of grace time left before the 30-min bound. */
function graceMinutesLeft(inputs: DrawdownInputs): number {
  if (inputs.graceEnteredAt === null) {
    return inputs.graceBoundMinutes;
  }
  const elapsedMinutes = Math.floor(
    (inputs.now.getTime() - inputs.graceEnteredAt.getTime()) / MS_PER_MINUTE
  );
  return Math.max(0, inputs.graceBoundMinutes - elapsedMinutes);
}

/** AUD-minor room left before hitting the overdraft ceiling. */
function ceilingRoomMinor(inputs: DrawdownInputs): number {
  const used = inputs.balanceMinor < 0 ? -inputs.balanceMinor : 0;
  return Math.max(0, inputs.effectiveCeilingMinor - used);
}

/** The presentational key from the persisted status + live runway (§5). */
function deriveKey(inputs: DrawdownInputs, minutesRemaining: number): DrawdownKey {
  switch (inputs.status) {
    case 'active':
      return minutesRemaining <= LOW_BALANCE_WARNING_MINUTES ? 'low' : 'healthy';
    case 'grace':
      return isNearWrap(inputs) ? 'near' : 'grace';
    case 'wrapped':
      // Grace history ⇒ past the ceiling/30-min bound (`wrap`); none ⇒ balance-used (`end`).
      // ⚠ BAL-405 — NEITHER key pauses anything on the presence path; see `KEY_BASE`. ⚠ R9:
      // "no-mandate" is stale — since BAL-523 grace is withheld for a card-backed-MODE failure
      // too, so `end` is now reached by either an absent mandate or "Just notify me". Which of
      // the two it was is now carried explicitly by `DrawdownInputs.mandateActive`, and the
      // `end` copy branches on it (BAL-552) — `graceAvailable` alone cannot tell the two apart.
      return inputs.graceEnteredAt === null ? 'end' : 'wrap';
    default:
      return 'healthy';
  }
}

/** In grace, within the near-wrap threshold on either the time bound OR the ceiling room. */
function isNearWrap(inputs: DrawdownInputs): boolean {
  const graceLeft = graceMinutesLeft(inputs);
  const roomMinutes =
    inputs.clientRateMinorPerMinute > 0
      ? Math.floor(ceilingRoomMinor(inputs) / inputs.clientRateMinorPerMinute)
      : 0;
  return graceLeft <= NEAR_WRAP_MINUTES || roomMinutes <= NEAR_WRAP_MINUTES;
}

/** The meter fill (0–100) for a key + live figures. */
function deriveMeterPct(
  key: DrawdownKey,
  inputs: DrawdownInputs,
  minutesRemaining: number
): number {
  if (key === 'end') {
    return 0;
  }
  if (key === 'grace' || key === 'near' || key === 'wrap') {
    const used = inputs.balanceMinor < 0 ? -inputs.balanceMinor : 0;
    const ceiling = inputs.effectiveCeilingMinor > 0 ? inputs.effectiveCeilingMinor : 1;
    return clampPct(Math.round((used / ceiling) * 100));
  }
  // balance mode (healthy | low): runway against the display scale.
  return clampPct(Math.round((minutesRemaining / METER_FULL_MINUTES) * 100));
}

function clampPct(pct: number): number {
  if (pct < MIN_METER_PCT) {
    return MIN_METER_PCT;
  }
  return Math.min(100, pct);
}

// ── Structural (lens-independent) per-key descriptor ──────────────────────
interface KeyBase {
  tone: DrawdownState['tone'];
  meterMode: DrawdownMeter['mode'];
  meterTone: DrawdownMeter['tone'];
  channels: Array<'in-app' | 'sms'>;
}

/**
 * ⚠ BAL-405 — THERE IS NO `paused` FLAG, deliberately. On the PRESENCE path the call never
 * stops (ADR-1052 D2 / ADR-1040 Amendment 6 §H): at `wrap` and `end` the meter changes and Balo
 * stops advancing, but the expert stays, the minutes keep accruing and
 * `settleSessionFromPresence` posts every one of them at meeting end. A `paused: true` here
 * rendered a literal "Paused" pill over a live, billing call. (The `live_capture` path DOES
 * stop metering at `wrapped` and is auto-ended by the reaper — but it cannot reach this panel,
 * so no copy here may claim a pause.) If a future key ever DOES pause a call (BAL-477,
 * concurrent sessions — unmerged), add the flag back for that key alone.
 */
const KEY_BASE: Record<DrawdownKey, KeyBase> = {
  healthy: { tone: 'none', meterMode: 'balance', meterTone: 'blue', channels: [] },
  low: { tone: 'amber', meterMode: 'balance', meterTone: 'amber', channels: ['in-app'] },
  grace: { tone: 'keep', meterMode: 'grace', meterTone: 'grad', channels: ['in-app', 'sms'] },
  near: { tone: 'amber', meterMode: 'grace', meterTone: 'grad', channels: ['in-app', 'sms'] },
  wrap: { tone: 'wrap', meterMode: 'grace', meterTone: 'grad', channels: ['in-app'] },
  end: { tone: 'wrap', meterMode: 'empty', meterTone: 'faint', channels: ['in-app'] },
};

// ── Lens copy ─────────────────────────────────────────────────────────────
interface CopyCtx {
  minutesRemaining: number;
  /** min(grace time left, ceiling room in minutes) — the "N more minutes" figure. */
  remainingBeforeWrap: number;
  graceAvailable: boolean;
  mandateActive: boolean;
  adminName: string;
}

interface Copy {
  meterLabel: string;
  title?: string;
  body?: string;
  cta?: DrawdownCta;
  sms?: string;
}

/**
 * BAL-552 (ADR-1040 Amendment 6 §A.1/§D) — the `end` key's settlement fact, in four strings that
 * share ONE prefix so the two lenses × two mandate arms cannot drift apart. Same posture as
 * `LowBalanceModePicker.tsx`'s `BEYOND_BALANCE`, which this is the compressed echo of.
 *
 * ⚠ THE ARMS ARE CHOSEN BY `mandateActive`, NEVER BY `graceAvailable`. `graceAvailable` is
 * strictly narrower (`isWalletMandateActive && isCardBackedLowBalanceMode`), so a `notify_only`
 * wallet with a LIVE mandate reads `graceAvailable: false` — and settlement charges it anyway
 * (Amendment 6 §A.1, permanent). Branching on `graceAvailable` would tell exactly that client
 * they will not be charged. Neither arm promises a pause or any enforcement.
 *
 * BAL-405 — `wrap` consumes these too. It previously promised "We'll settle the extra time used
 * to your card" UNCONDITIONALLY, which is the same defect BAL-552 removed from `end`. The rule
 * these four strings tell: the extra time is charged iff the wallet's mandate is LIVE AT
 * SETTLEMENT TIME — `settleOverdraft` (`end-session.ts`) re-reads the wallet and, when
 * `!isWalletMandateActive(wallet)`, opens a receivable + dunning instead of charging (ADR-1040
 * Amendment 5 §C / Amendment 6 §E); the pinned instrument is evidence and preference, never
 * authority. A live mandate CAN disappear mid-grace via Stripe's `payment_method.detached`
 * webhook (`clearSavedCard`), so a `wrap` with `mandateActive: false` is reachable, not
 * theoretical.
 */
const EXTRA_TIME_FROM_HERE = 'Extra time from here';
const SETTLES_TO_CARD_CLIENT = `${EXTRA_TIME_FROM_HERE} settles to your card afterward.`;
const SETTLES_TO_CARD_MEMBER = `${EXTRA_TIME_FROM_HERE} settles to your team's card afterward.`;
const NEEDS_SETTLING_CLIENT = `${EXTRA_TIME_FROM_HERE} still needs settling — your next top-up covers it.`;
const NEEDS_SETTLING_MEMBER = `${EXTRA_TIME_FROM_HERE} still needs settling — the next top-up covers it.`;

/**
 * BAL-405 — THE CALL NEVER STOPS on the presence path (ADR-1052 D2 / ADR-1040 Amendment 6 §H):
 * the expert stays, the minutes keep accruing, and `settleSessionFromPresence` posts every one
 * of them at meeting end. `wrap` and `end` share this sentence because nothing user-visible
 * differs between them — `grace` already stated the settlement fact, so the ONLY thing `wrap`
 * adds over `end` is which title and meter describe how the client got there.
 */
const CALL_CONTINUES_CLIENT =
  'Your call keeps going — top up whenever you like to bring your balance back up.';

function callContinuesMember(adminName: string): string {
  return `Your call keeps going — ask ${adminName} to top up to bring your team's balance back up.`;
}

/** Client-lens copy (from `in-session-sequence.jsx`). */
const CLIENT_COPY: Record<DrawdownKey, (ctx: CopyCtx) => Copy> = {
  healthy: () => ({ meterLabel: 'Balance healthy' }),
  low: (ctx) => ({
    meterLabel: 'Running low',
    title: `About ${ctx.minutesRemaining} minutes of balance left`,
    // ⚠ FIX ROUND 2 (R3) + BAL-405 — NEITHER branch builds its nudge on "interruption". Nothing
    // interrupts the session on the presence path either way (the presence finalizer is
    // mode-blind — BAL-535), so a promise phrased around being interrupted was shaky in both
    // directions. What IS true is the runway: the balance is nearly out, and topping up keeps you
    // ahead of it. No pause promised, no no-charge promised.
    body: ctx.graceAvailable
      ? 'Want to top up to stay ahead of it? You can also keep going — any extra time settles to your card when you wrap up.'
      : "You're near the end of your balance — top up whenever you like to stay ahead of it.",
    cta: ctx.graceAvailable
      ? { kind: 'client_topup', label: 'Top up', secondaryLabel: 'Keep going' }
      : { kind: 'client_topup', label: 'Top up' },
  }),
  grace: (ctx) => ({
    meterLabel: 'Keeping you going',
    title: "We're keeping you going",
    body: `You've used your balance — no interruption. Extra time from here settles to your card afterward, and you've got room for about ${ctx.remainingBeforeWrap} more minutes.`,
    cta: { kind: 'client_topup', label: 'Top up' },
    sms: 'Your session continues past your balance — the extra time settles to your card afterward.',
  }),
  near: (ctx) => ({
    meterLabel: 'Wrapping soon',
    title: 'Coming up on a good place to wrap',
    body: `About ${ctx.remainingBeforeWrap} more minutes of the extra time we set aside. Want to top up to stay ahead of it?`,
    cta: { kind: 'client_topup', label: 'Top up to keep going', secondaryLabel: 'Dismiss' },
    sms: "You're nearing the end of this session's extra time — top up any time to stay ahead of it.",
  }),
  // ⚠ BAL-552 + BAL-405 — `wrap` and `end` branch on `ctx.mandateActive`, NEVER on
  // `ctx.graceAvailable`. See the clause constants' docblock above for why the two are not
  // interchangeable, and why neither key may claim the call stopped.
  wrap: (ctx) => ({
    meterLabel: 'Still going',
    title: "You're past the extra time we set aside",
    body: `${CALL_CONTINUES_CLIENT} ${ctx.mandateActive ? SETTLES_TO_CARD_CLIENT : NEEDS_SETTLING_CLIENT}`,
    cta: { kind: 'client_topup', label: 'Top up' },
  }),
  end: (ctx) => ({
    meterLabel: 'Balance used',
    title: "You're at the end of your balance",
    body: `${CALL_CONTINUES_CLIENT} ${ctx.mandateActive ? SETTLES_TO_CARD_CLIENT : NEEDS_SETTLING_CLIENT}`,
    cta: { kind: 'client_topup', label: 'Top up' },
  }),
};

/** Member-lens copy (from `member-variant.jsx`) — team-framed, nudge instead of top-up. */
const MEMBER_COPY: Record<DrawdownKey, (ctx: CopyCtx) => Copy> = {
  healthy: () => ({ meterLabel: 'Team balance healthy' }),
  low: (ctx) => ({
    meterLabel: 'Team balance running low',
    title: "Your team's balance is running low",
    // ⚠ BAL-523 — the member twin of `CLIENT_COPY.low`'s gate. `notify_only` is the schema
    // DEFAULT for every new wallet, so the un-gated branch is the COMMON case here, not an edge
    // one: promising "won't be interrupted" to a member whose team is on "Just notify me" is a
    // promise the meter refuses at zero. Both branches keep the nudge CTA — the member can act
    // either way.
    //
    // ⚠ FIX ROUND 2 (R3) + BAL-405 — the `false` branch said "and then we'll pause to settle up".
    // NOTHING pauses: not the call, not the billing (on the presence path the finalizer posts
    // every billable minute at meeting end regardless of the mode and settles off-session —
    // BAL-535), and since BAL-405 not even the meter label (`wrap` reads "Still going"). So the
    // branch flags the runway and nudges, and promises neither a pause nor a no-charge.
    body: ctx.graceAvailable
      ? `About ${ctx.minutesRemaining} minutes left. Your session won't be interrupted — extra time settles to your team's card afterward. Want to let ${ctx.adminName} know?`
      : `About ${ctx.minutesRemaining} minutes left on your team's balance. Want to let ${ctx.adminName} know?`,
    cta: { kind: 'member_nudge', label: `Let ${ctx.adminName} know` },
  }),
  grace: () => ({
    meterLabel: 'Keeping you going',
    title: "We're keeping you going",
    body: "Your team's balance is used — no interruption. Extra time from here settles to your team's card afterward.",
    sms: "Your session continues past your team's balance — extra time settles to the team card afterward.",
  }),
  near: (ctx) => ({
    meterLabel: 'Wrapping soon',
    title: 'Coming up on a good place to wrap',
    body: `About ${ctx.remainingBeforeWrap} more minutes of the extra time we set aside. Want ${ctx.adminName} to top up to stay ahead of it?`,
    cta: { kind: 'member_nudge', label: `Ask ${ctx.adminName} to top up` },
    sms: 'Your session is nearing the end of its extra time — ask your admin to top up to keep going.',
  }),
  // ⚠ BAL-552 + BAL-405 — `wrap` and `end` branch on `ctx.mandateActive`, NEVER on
  // `ctx.graceAvailable`. See the clause constants' docblock above for why the two are not
  // interchangeable, and why neither key may claim the call stopped.
  wrap: (ctx) => ({
    meterLabel: 'Still going',
    title: "You're past the extra time we set aside",
    body: `${callContinuesMember(ctx.adminName)} ${ctx.mandateActive ? SETTLES_TO_CARD_MEMBER : NEEDS_SETTLING_MEMBER}`,
    cta: { kind: 'member_nudge', label: `Ask ${ctx.adminName} to top up` },
  }),
  end: (ctx) => ({
    meterLabel: 'Team balance used',
    title: "Your team's balance is used up",
    body: `${callContinuesMember(ctx.adminName)} ${ctx.mandateActive ? SETTLES_TO_CARD_MEMBER : NEEDS_SETTLING_MEMBER}`,
    cta: { kind: 'member_nudge', label: `Ask ${ctx.adminName} to top up` },
  }),
};

/**
 * PURE projection: session snapshot + live wallet figures → the typed `DrawdownState` the
 * in-session components render. Encodes all lens-specific copy/CTA/tone so the components
 * stay dumb renderers.
 */
export function deriveDrawdownState(inputs: DrawdownInputs): DrawdownState {
  const rate = inputs.clientRateMinorPerMinute;
  const minutesRemaining = minutesOfRunway({
    balanceMinor: inputs.balanceMinor,
    ratePerMinuteMinor: rate,
    floorMinutes: inputs.billingFloorMinutes,
    minutesAlreadyDrawn: inputs.minutesAlreadyDrawn,
  });
  const key = deriveKey(inputs, minutesRemaining);
  const base = KEY_BASE[key];

  const room = ceilingRoomMinor(inputs);
  const roomMinutes = rate > 0 ? Math.floor(room / rate) : 0;
  const graceLeft = graceMinutesLeft(inputs);
  const remainingBeforeWrap = Math.min(graceLeft, roomMinutes);

  const adminName = inputs.adminName ?? 'your admin';
  const ctx: CopyCtx = {
    minutesRemaining,
    remainingBeforeWrap,
    graceAvailable: inputs.graceAvailable,
    mandateActive: inputs.mandateActive,
    adminName,
  };
  const copy = (inputs.lens === 'client' ? CLIENT_COPY : MEMBER_COPY)[key](ctx);

  const state: DrawdownState = {
    key,
    status: inputs.status,
    elapsed: formatElapsed(inputs.connectedAt, inputs.now),
    meter: {
      mode: base.meterMode,
      pct: deriveMeterPct(key, inputs, minutesRemaining),
      tone: base.meterTone,
      label: copy.meterLabel,
    },
    tone: base.tone,
    channels: [...base.channels],
    balanceMinor: inputs.balanceMinor,
    graceAvailable: inputs.graceAvailable,
    lens: inputs.lens,
    ratePerMinuteMinor: rate,
  };

  if (copy.title !== undefined) state.title = copy.title;
  if (copy.body !== undefined) state.body = copy.body;
  if (copy.cta !== undefined) state.cta = copy.cta;
  if (copy.sms !== undefined) state.sms = copy.sms;
  if (inputs.adminName !== undefined) state.adminName = inputs.adminName;
  if (inputs.promoRemainingMinor !== undefined)
    state.promoRemainingMinor = inputs.promoRemainingMinor;

  // Actionable figures only (no countdown when healthy).
  if (key === 'low') state.minutesRemaining = minutesRemaining;
  if (key === 'grace' || key === 'near' || key === 'wrap') {
    state.graceRemainingMinutes = graceLeft;
  }
  if (key === 'grace' || key === 'near') {
    state.ceilingRoomMinor = room;
  }

  return state;
}
