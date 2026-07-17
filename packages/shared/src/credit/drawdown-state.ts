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
 * member lenses, with/without an active mandate. All copy is VERBATIM from the two design
 * prototypes (`in-session-sequence.jsx`, `member-variant.jsx`). Tone rules honoured:
 *  - `elapsed` is session time, NEVER a countdown;
 *  - `minutesRemaining` / grace-room surface only when actionable;
 *  - SMS fires only on entering grace + nearing the wrap;
 *  - the word "overdraft" NEVER appears in any client/member-facing string
 *    ("keep me going" / "keeping you going" is its warm name).
 */

import { LOW_BALANCE_WARNING_MINUTES, NEAR_WRAP_MINUTES } from '../pricing';

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
  paused: boolean;
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
  mandatePresent: boolean;
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
  /** Reserved (pre-connect hold) — carried for widget availability context. */
  activeHoldsMinor?: number;
  promoRemainingMinor?: number;
  mandatePresent: boolean;
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
  const clampedLow = remaining > 0 ? remaining : 0;
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

/** Whole minutes of funded runway remaining (0 when the rate is unknown/zero). */
function minutesOfRunway(balanceMinor: number, rate: number): number {
  if (rate <= 0 || balanceMinor <= 0) {
    return 0;
  }
  return Math.floor(balanceMinor / rate);
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
      // Grace history ⇒ the ceiling/30-min pause (`wrap`); none ⇒ no-mandate balance-used (`end`).
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
  return pct > 100 ? 100 : pct;
}

// ── Structural (lens-independent) per-key descriptor ──────────────────────
interface KeyBase {
  tone: DrawdownState['tone'];
  paused: boolean;
  meterMode: DrawdownMeter['mode'];
  meterTone: DrawdownMeter['tone'];
  channels: Array<'in-app' | 'sms'>;
}

const KEY_BASE: Record<DrawdownKey, KeyBase> = {
  healthy: { tone: 'none', paused: false, meterMode: 'balance', meterTone: 'blue', channels: [] },
  low: {
    tone: 'amber',
    paused: false,
    meterMode: 'balance',
    meterTone: 'amber',
    channels: ['in-app'],
  },
  grace: {
    tone: 'keep',
    paused: false,
    meterMode: 'grace',
    meterTone: 'grad',
    channels: ['in-app', 'sms'],
  },
  near: {
    tone: 'amber',
    paused: false,
    meterMode: 'grace',
    meterTone: 'grad',
    channels: ['in-app', 'sms'],
  },
  wrap: { tone: 'wrap', paused: true, meterMode: 'grace', meterTone: 'grad', channels: ['in-app'] },
  end: { tone: 'wrap', paused: true, meterMode: 'empty', meterTone: 'faint', channels: ['in-app'] },
};

// ── Lens copy ─────────────────────────────────────────────────────────────
interface CopyCtx {
  minutesRemaining: number;
  /** min(grace time left, ceiling room in minutes) — the "N more minutes" figure. */
  remainingBeforeWrap: number;
  mandatePresent: boolean;
  adminName: string;
}

interface Copy {
  meterLabel: string;
  title?: string;
  body?: string;
  cta?: DrawdownCta;
  sms?: string;
}

/** Client-lens copy (from `in-session-sequence.jsx`). */
const CLIENT_COPY: Record<DrawdownKey, (ctx: CopyCtx) => Copy> = {
  healthy: () => ({ meterLabel: 'Balance healthy' }),
  low: (ctx) => ({
    meterLabel: 'Running low',
    title: `About ${ctx.minutesRemaining} minutes of balance left`,
    body: ctx.mandatePresent
      ? 'Want to top up so nothing interrupts you? You can also keep going — any extra time settles to your card when you wrap up.'
      : "Top up so nothing interrupts your session — you're near the end of your balance.",
    cta: ctx.mandatePresent
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
    body: `About ${ctx.remainingBeforeWrap} more minutes before we'll pause to settle up. Want to top up to keep going without a break?`,
    cta: { kind: 'client_topup', label: 'Top up to keep going', secondaryLabel: 'Dismiss' },
    sms: "You're nearing the end of this session's extra time — top up to keep going without a break.",
  }),
  wrap: () => ({
    meterLabel: 'Paused',
    title: "Let's pause here for now",
    body: "We've reached the extra time we can cover this session. Top up to pick right back up — your expert can rejoin in a moment. We'll settle the extra time used to your card.",
    cta: { kind: 'client_topup', label: 'Top up to continue' },
  }),
  end: () => ({
    meterLabel: 'Balance used',
    title: "You're at the end of your balance",
    body: "Top up to keep going — your expert can pick right back up whenever you're ready.",
    cta: { kind: 'client_topup', label: 'Top up to continue' },
  }),
};

/** Member-lens copy (from `member-variant.jsx`) — team-framed, nudge instead of top-up. */
const MEMBER_COPY: Record<DrawdownKey, (ctx: CopyCtx) => Copy> = {
  healthy: () => ({ meterLabel: 'Team balance healthy' }),
  low: (ctx) => ({
    meterLabel: 'Team balance running low',
    title: "Your team's balance is running low",
    body: `About ${ctx.minutesRemaining} minutes left. Your session won't be interrupted — extra time settles to your team's card afterward. Want to let ${ctx.adminName} know?`,
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
    body: `About ${ctx.remainingBeforeWrap} more minutes before we pause to settle up. Want ${ctx.adminName} to top up so you can keep going?`,
    cta: { kind: 'member_nudge', label: `Ask ${ctx.adminName} to top up` },
    sms: 'Your session is nearing the end of its extra time — ask your admin to top up to keep going.',
  }),
  wrap: (ctx) => ({
    meterLabel: 'Paused',
    title: "Let's pause here for now",
    body: `We've reached the extra time we can cover this session. Ask ${ctx.adminName} to top up to pick right back up.`,
    cta: { kind: 'member_nudge', label: `Ask ${ctx.adminName} to top up` },
  }),
  end: (ctx) => ({
    meterLabel: 'Team balance used',
    title: "Your team's balance is used up",
    body: `Ask ${ctx.adminName} to top up to keep going — your expert can pick right back up.`,
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
  const minutesRemaining = minutesOfRunway(inputs.balanceMinor, rate);
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
    mandatePresent: inputs.mandatePresent,
    adminName,
  };
  const copy = (inputs.lens === 'client' ? CLIENT_COPY : MEMBER_COPY)[key](ctx);

  const state: DrawdownState = {
    key,
    status: inputs.status,
    elapsed: formatElapsed(inputs.connectedAt, inputs.now),
    paused: base.paused,
    meter: {
      mode: base.meterMode,
      pct: deriveMeterPct(key, inputs, minutesRemaining),
      tone: base.meterTone,
      label: copy.meterLabel,
    },
    tone: base.tone,
    channels: [...base.channels],
    balanceMinor: inputs.balanceMinor,
    mandatePresent: inputs.mandatePresent,
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
