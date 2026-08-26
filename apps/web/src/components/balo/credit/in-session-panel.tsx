'use client';

import { useCallback, useEffect, useRef } from 'react';
import Link from 'next/link';
import {
  ExternalLink,
  MessageSquare,
  PauseCircle,
  Phone,
  Plus,
  ShieldCheck,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import type { DrawdownCta, DrawdownState } from '@balo/shared/credit';
import { cn } from '@/lib/utils';
import { track, SESSION_EVENTS } from '@/lib/analytics';
import { SessionMeter } from './session-meter';
import { NudgeButton } from './nudge-button';

/**
 * BAL-378 (ADR-1040 Lane 2) — the in-session shell (§9), rendering BOTH lenses off one
 * pre-derived {@link DrawdownState} (from `in-session-sequence.jsx` / `member-variant.jsx`).
 *
 * A dark call stage (elapsed time — NEVER a countdown — a live/paused pill, the
 * {@link SessionMeter}) over a warm notice card whose CTA is the client's Top up OR the
 * member's {@link NudgeButton}. The word "overdraft" never appears — grace is
 * "keeping you going". Fires the `low_balance_warning_shown` client analytics impression, once
 * per mount — **in the `'card'` variant only**.
 *
 * ⚠ BAL-466 (D7) — `session_started` NO LONGER FIRES FROM THIS COMPONENT. It moved server-side
 * to the real connect seam. See the effect below for why.
 *
 * ── ⚠⚠ BAL-403 ADDED THE `variant` PROP — ADDITIVE, `'card'` IS BYTE-IDENTICAL TO BAL-378 ────
 *
 * `'card'` (the default, and what every existing consumer passes) is UNCHANGED: the stage
 * header, the lifecycle `track()` call, the `max-w-[520px]` shadowed card. `'embedded'` is
 * the in-call drawer's composition — see `components/balo/credit/in-call-balance-panel.tsx`
 * for why (no `CallStageHeader`, the dark block kept for `SessionMeter` alone, no outer card
 * chrome, no lifecycle event, and — per the orchestrator's OQ1 decision — the CLIENT
 * lens's primary "Top up" BUTTON is ABSENT, never disabled, so no wallet money surface or
 * `TopUpLauncher` modal reaches the live call). The member lens's {@link NudgeButton} is
 * UNCHANGED in both variants.
 *
 * ⚠⚠ BAL-466 (F3, review fix round) — the CLIENT-lens escalation copy (`CLIENT_COPY` in
 * `@balo/shared/credit/drawdown-state.ts`, e.g. "Top up to pick right back up") instructs an
 * action that D9.2's deny-by-default CTA suppression left with NOTHING clickable in `'embedded'`
 * — a dead end for a client whose session has literally paused. `NoticeCard` now renders a
 * PLAIN navigation link (`EmbeddedTopUpLink`, opens `/billing/top-up` in a new tab) for that one
 * arm — NOT the `TopUpLauncher` modal, and NOT `CtaArea`'s primary button (which needs
 * `onTopUp`, never wired in `'embedded'`). It surfaces no wallet figures and no money payload,
 * so OQ1 / D9.2's suppression of a money-bearing surface is untouched; this is a link to
 * somewhere the client can already act, not a new affordance class.
 *
 * ⚠ GATED ON `cta.kind === 'client_topup'`, WHICH **IS** THE MANAGE_BILLING CHECK — not a
 * separate one. `get-drawdown-state.ts` sets `lens = MANAGE_BILLING ? 'client' : 'member'` and
 * `deriveDrawdownState` only ever produces a `'client_topup'` cta for the `'client'` lens
 * (`drawdown-state.ts`'s `CLIENT_COPY`). So by construction this link can never render for a
 * member without `MANAGE_BILLING` — they keep the existing {@link NudgeButton} affordance
 * (BAL-381) instead, exactly as F3 requires.
 *
 * ⚠ REUSES SHIPPED WORDING ONLY — the link's visible text is `cta.label` (e.g. "Top up",
 * "Top up to continue"), the exact string the `'card'` variant's button already renders for the
 * same state; `dashboard-wallet-card.tsx`'s existing `/billing/top-up` link ships the same "Top
 * up" wording for the plain case. No new money copy was written for this fix (MJ checkpoint).
 */

interface ExpertSummary {
  name: string;
  headline?: string | null;
}

type InSessionPanelBaseProps = {
  state: DrawdownState;
  sessionId: string;
  /** Client-lens Top up (future Booking wires the purchase flow). `'embedded'` never passes it. */
  onTopUp?: () => void;
  /** The low / near-wrap secondary ("Keep going" / "Dismiss"). `'embedded'` never passes it. */
  onDismiss?: () => void;
};

/**
 * ⚠ A DISCRIMINATED UNION, NOT AN OPTIONAL PAIR OF PROPS. `expertProfileId` / `expert` are used
 * ONLY by `CallStageHeader`, which `'embedded'` omits — so making them structurally
 * unavailable there is a type-level statement that the call page does not need to load the
 * delivering expert's profile for this surface, not a runtime `if`.
 */
type InSessionPanelProps = InSessionPanelBaseProps &
  (
    | { variant?: 'card'; expertProfileId: string; expert: ExpertSummary }
    | { variant: 'embedded'; expertProfileId?: never; expert?: never }
  );

/** `null` for the embedded variant — narrows the discriminated union once, at the top. */
function cardFields(
  props: InSessionPanelProps
): { expertProfileId: string; expert: ExpertSummary } | null {
  if (props.variant === 'embedded') return null;
  return { expertProfileId: props.expertProfileId, expert: props.expert };
}

type NoticeTone = 'amber' | 'keep' | 'wrap';

interface ToneConfig {
  card: string;
  iconWrap: string;
  iconColor: string;
  icon: LucideIcon;
  hairline: boolean;
}

const TONE_CONFIG: Record<NoticeTone, ToneConfig> = {
  amber: {
    card: 'border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10',
    iconWrap: 'border border-amber-200 bg-card dark:border-amber-500/30',
    iconColor: 'text-amber-600 dark:text-amber-400',
    icon: Wallet,
    hairline: false,
  },
  keep: {
    card: 'border-primary/30 bg-primary/5 dark:bg-primary/10',
    iconWrap: 'from-primary to-violet-600 bg-gradient-to-br',
    iconColor: 'text-white',
    icon: ShieldCheck,
    hairline: true,
  },
  wrap: {
    card: 'border-border bg-muted',
    iconWrap: 'border-border bg-card border',
    iconColor: 'text-foreground',
    icon: PauseCircle,
    hairline: false,
  },
};

/** First letters of the first two words of a name, uppercased (avatar fallback). */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  const letters = parts.map((part) => part.charAt(0)).join('');
  return letters.length > 0 ? letters.toUpperCase() : '?';
}

function reassuranceCopy(lens: DrawdownState['lens']): string {
  return lens === 'member'
    ? "You're all set — time draws from your team's balance as you talk."
    : "You're all set — time draws from your balance as you talk.";
}

// ── Call-stage header ──────────────────────────────────────────────────────
function CallStageHeader({
  expert,
  paused,
  elapsed,
}: Readonly<{ expert: ExpertSummary; paused: boolean; elapsed: string }>): React.JSX.Element {
  return (
    <>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className="from-primary flex size-11 items-center justify-center overflow-hidden rounded-[14px] bg-gradient-to-br to-violet-600 text-base font-semibold text-white"
            aria-hidden
          >
            {initialsOf(expert.name)}
          </div>
          <div>
            <div className="text-[15.5px] font-semibold text-white">{expert.name}</div>
            {expert.headline ? (
              <div className="text-xs font-medium text-white/55">{expert.headline}</div>
            ) : null}
          </div>
        </div>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-semibold',
            paused
              ? 'border-white/15 bg-white/10 text-white/70'
              : 'border-emerald-400/30 bg-emerald-500/15 text-emerald-300'
          )}
        >
          {paused ? (
            <PauseCircle className="size-3" strokeWidth={2.6} aria-hidden />
          ) : (
            <span
              className="size-[7px] rounded-full bg-emerald-400 motion-safe:animate-pulse"
              aria-hidden
            />
          )}
          {paused ? 'Paused' : 'In consultation'}
        </span>
      </div>

      <div className="mt-[18px] flex items-baseline gap-2">
        <span className="text-xs font-semibold text-white/45">Session time</span>
        <span className="text-xl font-semibold text-white tabular-nums">{elapsed}</span>
      </div>
    </>
  );
}

// ── Notify chips ────────────────────────────────────────────────────────────
function ChannelChips({
  channels,
  lens,
}: Readonly<{
  channels: DrawdownState['channels'];
  lens: DrawdownState['lens'];
}>): React.JSX.Element | null {
  if (channels.length === 0) {
    return null;
  }
  return (
    <div className="border-border/60 mt-3.5 flex flex-wrap items-center gap-1.5 border-t pt-3">
      <span className="text-muted-foreground/80 mr-0.5 text-[10.5px] font-semibold tracking-wide uppercase">
        {lens === 'member' ? 'Notifies you' : 'Notifies'}
      </span>
      {channels.map((channel) => {
        const isSms = channel === 'sms';
        return (
          <span
            key={channel}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase',
              isSms
                ? 'border-violet-500/25 bg-violet-500/10 text-violet-600 dark:text-violet-300'
                : 'border-border bg-muted text-muted-foreground'
            )}
          >
            {isSms ? (
              <MessageSquare className="size-2.5" strokeWidth={2.6} aria-hidden />
            ) : (
              <Phone className="size-2.5" strokeWidth={2.6} aria-hidden />
            )}
            {isSms ? 'SMS' : 'In-app'}
          </span>
        );
      })}
    </div>
  );
}

// ── CTA (client Top up | member Nudge) ──────────────────────────────────────
function CtaArea({
  cta,
  sessionId,
  adminName,
  primaryTone,
  onTopUp,
  onDismiss,
}: Readonly<{
  cta: DrawdownCta;
  sessionId: string;
  adminName?: string;
  primaryTone: boolean;
  onTopUp?: () => void;
  onDismiss?: () => void;
}>): React.JSX.Element {
  if (cta.kind === 'member_nudge') {
    return (
      <NudgeButton
        sessionId={sessionId}
        label={cta.label}
        adminName={adminName}
        tone={primaryTone ? 'primary' : 'subtle'}
      />
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <button
        type="button"
        onClick={onTopUp}
        className="from-primary focus-visible:ring-ring inline-flex min-h-11 items-center gap-1.5 rounded-[10px] bg-gradient-to-r to-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none"
      >
        <Plus className="size-[15px]" strokeWidth={2.6} aria-hidden />
        {cta.label}
      </button>
      {cta.secondaryLabel ? (
        <button
          type="button"
          onClick={onDismiss}
          className="border-border bg-card text-muted-foreground focus-visible:ring-ring hover:bg-muted inline-flex min-h-11 items-center rounded-[10px] border px-3.5 py-2.5 text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          {cta.secondaryLabel}
        </button>
      ) : null}
    </div>
  );
}

// ── Embedded top-up link (F3) ────────────────────────────────────────────────
/**
 * BAL-466 (F3) — the ONLY navigation affordance the `'embedded'` variant's client-lens notice
 * gets: a plain link to the billing top-up page, opened in a new tab so it never navigates away
 * from the live call. No wallet snapshot, no modal, no money figure — see the module docblock.
 */
function EmbeddedTopUpLink({ label }: Readonly<{ label: string }>): React.JSX.Element {
  return (
    <Link
      href="/billing/top-up"
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary focus-visible:ring-ring inline-flex min-h-11 items-center gap-1.5 text-[13.5px] font-semibold underline decoration-1 underline-offset-2 hover:opacity-80 focus-visible:rounded-md focus-visible:ring-2 focus-visible:outline-none"
    >
      {label}
      <ExternalLink className="size-3.5" strokeWidth={2.4} aria-hidden />
    </Link>
  );
}

// ── Notice card ─────────────────────────────────────────────────────────────
function NoticeCard({
  state,
  sessionId,
  variant,
  onTopUp,
  onDismiss,
}: Readonly<{
  state: DrawdownState;
  sessionId: string;
  variant: 'card' | 'embedded';
  onTopUp?: () => void;
  onDismiss?: () => void;
}>): React.JSX.Element {
  const tone = TONE_CONFIG[state.tone as NoticeTone];
  const primaryTone = state.key === 'wrap' || state.key === 'end';
  /**
   * ⚠⚠ BAL-403, ORCHESTRATOR DECISION OQ1 — the embedded (in-call) variant renders NO primary
   * "Top up" affordance for the client lens: `TopUpLauncher` needs a wallet snapshot
   * (`wallet`, `fx`, `balanceMinor`, `adminLabel`) the drawdown read does not supply, and a
   * modal over live video is the wrong interaction. **Absent, never disabled** — BAL-435's slot
   * rule. The secondary ("Keep going" / "Dismiss") goes with it, for the identical reason: it
   * has no handler in-call either.
   *
   * ⚠ THIS BRANCHES ON `cta.kind`, NOT ON `lens` BY NAME — the server already folded the lens
   * into `cta.kind` (`get-drawdown-state.ts`), so the member's `member_nudge` CTA is untouched
   * by this check and `NudgeButton` renders exactly as shipped in both variants.
   *
   * ⚠⚠ BAL-466 (D9.2) — DENY BY DEFAULT. This used to EXCLUDE one known kind
   * (`'client_topup'`), so a future money-bearing `DrawdownCta['kind']` would have rendered
   * in-call by default. It now ALLOWS one known kind instead: the embedded variant renders a
   * CTA only when it is the member NUDGE, which carries no money affordance and whose handler
   * (`NudgeButton` → `nudgeAdminAction`) is real in-call.
   *
   * ⚠ NOT A NEW RULE — the same OQ1 outcome, expressed so that widening `DrawdownCta` fails
   * SAFE. Payload absence is still the real fee-concealment control (`findForClientView`);
   * this is defence in depth.
   */
  const allowCta = variant !== 'embedded' || state.cta?.kind === 'member_nudge';
  // BAL-466 (F3) — the embedded/client_topup dead end: allowCta denies the primary button here
  // (correctly — see above), so give this ONE arm a plain nav link instead of nothing. See the
  // module docblock for why `cta.kind === 'client_topup'` already IS the MANAGE_BILLING check.
  const showEmbeddedTopUpLink = variant === 'embedded' && state.cta?.kind === 'client_topup';

  return (
    <div className={cn('relative overflow-hidden rounded-2xl border p-[18px]', tone.card)}>
      {tone.hairline ? (
        <div className="from-primary absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r to-violet-600" />
      ) : null}
      <div className="flex gap-3">
        <div
          className={cn(
            'flex size-[34px] shrink-0 items-center justify-center rounded-[10px]',
            tone.iconWrap
          )}
        >
          <tone.icon className={cn('size-[17px]', tone.iconColor)} strokeWidth={2.3} aria-hidden />
        </div>
        <div className="flex-1">
          {state.title ? (
            <div className="text-foreground text-[15px] font-semibold">{state.title}</div>
          ) : null}
          {state.body ? (
            <div className="text-muted-foreground mt-1.5 text-[13.5px] leading-relaxed">
              {state.body}
            </div>
          ) : null}
          {state.cta && allowCta ? (
            <div className="mt-3.5">
              <CtaArea
                cta={state.cta}
                sessionId={sessionId}
                adminName={state.adminName}
                primaryTone={primaryTone}
                onTopUp={onTopUp}
                onDismiss={onDismiss}
              />
            </div>
          ) : null}
          {!allowCta && showEmbeddedTopUpLink && state.cta ? (
            <div className="mt-3.5">
              <EmbeddedTopUpLink label={state.cta.label} />
            </div>
          ) : null}
          <ChannelChips channels={state.channels} lens={state.lens} />
        </div>
      </div>
    </div>
  );
}

// ── SMS preview ─────────────────────────────────────────────────────────────
function SmsPreview({ sms }: Readonly<{ sms: string }>): React.JSX.Element {
  return (
    <div className="mt-3.5 flex items-start gap-2.5">
      <div className="border-border bg-muted flex size-[30px] shrink-0 items-center justify-center rounded-lg border">
        <MessageSquare className="size-3.5 text-violet-500" strokeWidth={2.3} aria-hidden />
      </div>
      <div className="border-border bg-muted flex-1 rounded-xl rounded-tl-[3px] border px-3.5 py-2.5">
        <div className="text-muted-foreground/80 mb-1 text-[10.5px] font-semibold tracking-wide uppercase">
          SMS · Balo
        </div>
        <div className="text-foreground/90 text-[12.5px] leading-snug">{sms}</div>
      </div>
    </div>
  );
}

export function InSessionPanel(props: Readonly<InSessionPanelProps>): React.JSX.Element {
  const { state, sessionId, onTopUp, onDismiss } = props;
  const isEmbedded = props.variant === 'embedded';
  const card = cardFields(props);

  const lowTracked = useRef(false);

  // ⚠ BAL-466 (D7) — `session_started` NO LONGER FIRES HERE. It never fired in production (this
  // component's only render is `variant="embedded"`, whose `expertProfileId` is typed `never`,
  // so the effect always early-returned) and now fires SERVER-SIDE, at the real connect seam
  // (`services/meetings/presence-writer.ts`'s co-presence transition). See `connect-session.ts`.

  // `low_balance_warning_shown` — a once-per-mount impression the first time the low card shows.
  // ⚠ SUPPRESSED IN `'embedded'`: superseded there by `in_session_panel_viewed { state: 'low' }`,
  // which carries strictly more information (the lens too).
  useEffect(() => {
    if (isEmbedded || lowTracked.current) return;
    if (state.key === 'low') {
      lowTracked.current = true;
      track(SESSION_EVENTS.LOW_BALANCE_WARNING_SHOWN, {
        session_id: sessionId,
        minutes_remaining: state.minutesRemaining ?? 0,
      });
    }
  }, [isEmbedded, state.key, state.minutesRemaining, sessionId]);

  const handleTopUp = useCallback((): void => onTopUp?.(), [onTopUp]);
  const handleDismiss = useCallback((): void => onDismiss?.(), [onDismiss]);

  const hasNotice = state.tone !== 'none';

  return (
    <div
      className={cn(
        'overflow-hidden',
        isEmbedded
          ? 'w-full'
          : 'border-border bg-card w-full max-w-[520px] rounded-[22px] border shadow-[0_1px_2px_rgba(15,23,41,0.04),0_18px_50px_rgba(15,23,41,0.09)]'
      )}
    >
      {/* dark call stage — always dark, in both themes. Embedded: header dropped, tightened
          padding, rounded on its own (the drawer shell owns the outer chrome). */}
      <div
        className={cn(
          'bg-gradient-to-br from-slate-900 to-slate-800',
          isEmbedded ? 'rounded-2xl px-4 py-4' : 'px-6 pt-[22px] pb-6',
          state.paused && 'opacity-90'
        )}
      >
        {card === null ? null : (
          <CallStageHeader expert={card.expert} paused={state.paused} elapsed={state.elapsed} />
        )}
        <SessionMeter meter={state.meter} />
      </div>

      {/* notice area */}
      <div className={isEmbedded ? 'p-4' : 'p-[22px]'}>
        {hasNotice ? (
          <NoticeCard
            state={state}
            sessionId={sessionId}
            variant={isEmbedded ? 'embedded' : 'card'}
            onTopUp={handleTopUp}
            onDismiss={handleDismiss}
          />
        ) : (
          <div className="text-muted-foreground flex items-center gap-2.5 px-0.5 py-1">
            <ShieldCheck className="text-success size-[15px]" strokeWidth={2.2} aria-hidden />
            <span className="text-[13px] font-medium">{reassuranceCopy(state.lens)}</span>
          </div>
        )}

        {state.sms ? <SmsPreview sms={state.sms} /> : null}
      </div>
    </div>
  );
}
