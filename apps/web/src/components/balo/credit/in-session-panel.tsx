'use client';

import { useCallback, useEffect, useRef } from 'react';
import {
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
 * "keeping you going". Fires the two client analytics impressions (session started on
 * connect; low-balance warning shown), each once per mount.
 */

interface ExpertSummary {
  name: string;
  headline?: string | null;
}

interface InSessionPanelProps {
  state: DrawdownState;
  sessionId: string;
  /** Subject of the `session_started` analytic + future accrual. */
  expertProfileId: string;
  expert: ExpertSummary;
  /** Client-lens Top up (future Booking wires the purchase flow). */
  onTopUp?: () => void;
  /** The low / near-wrap secondary ("Keep going" / "Dismiss"). */
  onDismiss?: () => void;
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

// ── Notice card ─────────────────────────────────────────────────────────────
function NoticeCard({
  state,
  sessionId,
  onTopUp,
  onDismiss,
}: Readonly<{
  state: DrawdownState;
  sessionId: string;
  onTopUp?: () => void;
  onDismiss?: () => void;
}>): React.JSX.Element {
  const tone = TONE_CONFIG[state.tone as NoticeTone];
  const primaryTone = state.key === 'wrap' || state.key === 'end';

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
          {state.cta ? (
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

export function InSessionPanel({
  state,
  sessionId,
  expertProfileId,
  expert,
  onTopUp,
  onDismiss,
}: Readonly<InSessionPanelProps>): React.JSX.Element {
  const startedTracked = useRef(false);
  const lowTracked = useRef(false);

  // `session_started` — once per mount, only for a live (connected) session. No explicit
  // connect UI exists in this lane, so the panel's first live render is the connect seam.
  useEffect(() => {
    if (startedTracked.current) return;
    if (state.status === 'active' || state.status === 'grace') {
      startedTracked.current = true;
      track(SESSION_EVENTS.STARTED, {
        session_id: sessionId,
        expert_profile_id: expertProfileId,
        rate_per_minute_minor: state.ratePerMinuteMinor,
      });
    }
  }, [state.status, state.ratePerMinuteMinor, sessionId, expertProfileId]);

  // `low_balance_warning_shown` — a once-per-mount impression the first time the low card shows.
  useEffect(() => {
    if (!lowTracked.current && state.key === 'low') {
      lowTracked.current = true;
      track(SESSION_EVENTS.LOW_BALANCE_WARNING_SHOWN, {
        session_id: sessionId,
        minutes_remaining: state.minutesRemaining ?? 0,
      });
    }
  }, [state.key, state.minutesRemaining, sessionId]);

  const handleTopUp = useCallback((): void => onTopUp?.(), [onTopUp]);
  const handleDismiss = useCallback((): void => onDismiss?.(), [onDismiss]);

  const hasNotice = state.tone !== 'none';

  return (
    <div className="border-border bg-card w-full max-w-[520px] overflow-hidden rounded-[22px] border shadow-[0_1px_2px_rgba(15,23,41,0.04),0_18px_50px_rgba(15,23,41,0.09)]">
      {/* dark call stage — always dark, in both themes */}
      <div
        className={cn(
          'bg-gradient-to-br from-slate-900 to-slate-800 px-6 pt-[22px] pb-6',
          state.paused && 'opacity-90'
        )}
      >
        <CallStageHeader expert={expert} paused={state.paused} elapsed={state.elapsed} />
        <SessionMeter meter={state.meter} />
      </div>

      {/* notice area */}
      <div className="p-[22px]">
        {hasNotice ? (
          <NoticeCard
            state={state}
            sessionId={sessionId}
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
