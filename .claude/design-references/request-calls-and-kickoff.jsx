/**
 * request-calls-and-kickoff.jsx — design reference (Oct 2026)
 *
 * Request page (/projects/[requestId]), conversation + kickoff region. Four agreed changes:
 *
 *  1. ALWAYS BOOKABLE. The client can book a call with the expert at every request stage and
 *     state. Active and won threads book in place. Not-selected threads and closed requests
 *     keep a "Book a call" that opens the expert's profile booking (a consultation outside
 *     this request), so BAL-540's closed-request booking guard stays intact.
 *  2. HEADER BOOK / JOIN STATES. Nothing upcoming → labelled "Book a call". A call upcoming →
 *     a next-call line under the name, the labelled slot becomes the Join countdown (the
 *     dashboard ladder; only "Join now" is live), and booking shrinks to a calendar-plus icon
 *     button, "Book another call". Several upcoming → "+N more". Expert lens: never books,
 *     but sees the same next-call line and Join.
 *  3. NO DEAD NUDGES. A nudge never renders a disabled button; the `stub` action is retired.
 *     Client, accepted (won thread) → a quiet milestone line, no card, no button. Kickoff
 *     approved → "Your project is underway" with a LIVE workspace link (expert cell too).
 *  4. "BEFORE KICKOFF" THREAD. Replaces "What's blocking kickoff". One vertical thread:
 *     done steps checked, the one current step highlighted, future steps muted with no
 *     status chip. Each step names its owner. The counter counts gating steps only. Admin
 *     actions render only on the current step (no disabled future buttons). The kickoff call
 *     row is optional and never gates approval. The subtitle is gone.
 *
 * Out of scope here: the multi-expert stepper / per-tab status chips (waiting on the
 * multi-EOI test run), the page StatusStepper, request context, files panel.
 *
 * ── Implementation map (real code, verified 2026-10-23) ─────────────────────────────────
 *  · apps/web/src/components/balo/project-request/conversation/thread-actions.ts
 *      `deriveCallSlot` today returns 'none' unless `beforeKickoff && thread.stage === 'active'`,
 *      and 'booked' REMOVES the slot. Split the gate: the call gate becomes
 *      lens === 'client' && stage ∈ {active, won} at any request status (profile route for
 *      not_selected / request_closed); the proposal slot keeps today's gate.
 *  · .../conversation/thread-header.tsx and mobile-action-rail.tsx — render the states below.
 *  · apps/web/src/lib/project-request/conversation-view-types.ts — `bookedCall` (one meeting,
 *      request_interaction only) becomes the upcoming list across the thread's meeting
 *      contexts (intro + project), soonest first, still picked by `pickUpcomingContextMeeting`'s
 *      rule so header and server guard agree.
 *  · apps/web/src/lib/project-request/thread-nudge-content.ts + .../conversation/thread-nudge.tsx
 *      Retire `stub`. Add an `event` variant. `deliveryEngagementId` must reach ConversationStage
 *      so the kickoff-approved cells link to the workspace (request-detail-shell already has it).
 *  · .../project-request/proposal/kickoff-board.tsx — thread layout; `resolveSteps` and the
 *      lens copy functions stay the source of truth, re-worded per this file.
 *  · Reuse: `joinCountdownLabel` + JOIN_WINDOW_MINUTES (join-window.ts), the dashboard Up next
 *      row label ("Tomorrow at…"), IntroCallBookingDialog / BAL-236 picker, BAL-400 profile
 *      booking for the profile route (`/experts/{username}?book=1&src=request_thread`).
 *  · API work (separate ticket): project-level meeting context after acceptance; relax
 *      `assertNoLiveIntroCall` so a second call can be booked before acceptance.
 *  · Buttons: solid `--primary` throughout. This is a dashboard surface, so the blue→violet
 *      gradient comes off the composer send button, the thread nudge's PRIMARY_CLASS and the
 *      header's Request / Build proposal CTAs (`from-primary bg-gradient-to-r to-violet-600`).
 */

import React, { useState } from 'react';
import {
  BadgeCheck,
  Banknote,
  Briefcase,
  Calendar,
  CalendarPlus,
  Check,
  Clock,
  FileText,
  MessageSquare,
  PartyPopper,
  Receipt,
  Send,
  User,
  Video,
  X,
  Zap,
} from 'lucide-react';

// ── Tokens (mirrors the shipped request page: Geist, primary blue, success green) ────────────
const c = {
  page: '#f8fafc',
  card: '#ffffff',
  border: '#e5e7eb',
  borderStrong: '#d1d5db',
  text: '#0f172a',
  muted: '#64748b',
  faint: '#94a3b8',
  primary: '#2563eb',
  primarySoft: 'rgba(37, 99, 235, 0.06)',
  primaryTint: 'rgba(37, 99, 235, 0.10)',
  primaryBorder: 'rgba(37, 99, 235, 0.32)',
  success: '#16a34a',
  successSoft: 'rgba(22, 163, 74, 0.10)',
  successBorder: 'rgba(22, 163, 74, 0.35)',
  warning: '#d97706',
  bubbleMine: '#eef4ff',
  bubbleTheirs: '#f1f5f9',
};
const FONT = 'Geist, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

// ── Fixture ─────────────────────────────────────────────────────────────────────────────────
const EXPERT = {
  name: 'Charles Akintunde',
  first: 'Charles',
  initials: 'CA',
  username: 'charles-akintunde',
};
const COMPANY = 'National Dental Care';
const UPFRONT = 'A$8,125';

// ── Clock: one fixed "now" so every label is deterministic ──────────────────────────────────
// Tue 27 Oct 2026, 10:00 local.
const NOW = new Date(2026, 9, 27, 10, 0);
const JOIN_WINDOW_MINUTES = 15; // mirrors join-window.ts
const at = (dayOffset, h, m = 0) => new Date(2026, 9, 27 + dayOffset, h, m);

const CALL_SCENARIOS = {
  none: { label: 'Nothing booked', calls: [] },
  window: { label: 'Window open', calls: [at(0, 10, 8)] },
  m40: { label: 'In 40 min', calls: [at(0, 10, 40)] },
  h3: { label: 'In 3 hours', calls: [at(0, 13, 0)] },
  d1: { label: 'Tomorrow', calls: [at(1, 14, 0)] },
  d2: { label: 'In 2 days', calls: [at(2, 11, 0)] },
  two: { label: 'Two booked', calls: [at(1, 14, 0), at(2, 11, 0)] },
};

const DAY_MS = 86400000;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const calendarDaysBetween = (from, to) => Math.round((startOfDay(to) - startOfDay(from)) / DAY_MS);
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtTime(d) {
  const h = d.getHours();
  const m = d.getMinutes();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

/** The dashboard Up next row label, lower-cased for mid-sentence use. */
function callWhen(start) {
  const days = calendarDaysBetween(NOW, start);
  if (days === 0) return `today at ${fmtTime(start)}`;
  if (days === 1) return `tomorrow at ${fmtTime(start)}`;
  return `${WEEKDAYS[start.getDay()]} ${start.getDate()} ${MONTHS[start.getMonth()]} at ${fmtTime(start)}`;
}

/** The dashboard ladder (`joinCountdownLabel`). Only "Join now" is live. */
function joinCountdown(start) {
  const minutes = Math.round((start.getTime() - NOW.getTime()) / 60000);
  if (minutes <= JOIN_WINDOW_MINUTES) return { label: 'Join now', live: true };
  if (minutes < 60) return { label: `Join in ${minutes} minutes`, live: false };
  if (minutes < 1440) {
    const hours = Math.round(minutes / 60);
    return { label: `Join in ${hours} hour${hours === 1 ? '' : 's'}`, live: false };
  }
  const days = calendarDaysBetween(NOW, start);
  return { label: days === 1 ? 'Join tomorrow' : `Join in ${days} days`, live: false };
}

// ── Derivations (the rules CC implements) ───────────────────────────────────────────────────

/** Thread stage, as `deriveThreadStage` would produce it for the selected scenario. */
function threadStageFor(requestStatus, outcome) {
  if (requestStatus === 'closed') return 'request_closed';
  if (requestStatus === 'proposal_submitted') return 'active';
  return outcome; // 'won' | 'not_selected'
}

/**
 * The call slot. Client: always present. Expert: never books, but sees upcoming calls.
 *  · { kind: 'book', route: 'in_place' | 'profile' }
 *  · { kind: 'upcoming', next, more, join, canBookAnother }
 *  · { kind: 'propose' } — expert only, unchanged
 */
function deriveCallSlot({ lens, stage, calls, beforeKickoff }) {
  const upcoming = [...calls].sort((a, b) => a - b);
  const inPlace = stage === 'active' || stage === 'won';
  if (upcoming.length > 0 && inPlace) {
    return {
      kind: 'upcoming',
      next: upcoming[0],
      more: upcoming.length - 1,
      join: joinCountdown(upcoming[0]),
      canBookAnother: lens === 'client',
    };
  }
  if (lens === 'expert') {
    // Unchanged: "Propose times" / "Availability shared" keep today's gate (pre-kickoff, active).
    return stage === 'active' && beforeKickoff ? { kind: 'propose' } : { kind: 'none' };
  }
  return { kind: 'book', route: inPlace ? 'in_place' : 'profile' };
}

/**
 * Gating kickoff steps — same dependency order and, apart from the future-step lines marked
 * CHANGED, the same copy as `resolveSteps` / `billingSub` / `invoiceSub` / `paymentSub` /
 * `approvalSub` in kickoff-board.tsx. The expert lens never sees the amount.
 */
function deriveKickoffSteps({ lens, progress, hasUpfront, approved, member }) {
  const billingDone = approved || progress !== 'billing';
  const invoiceDone = approved || progress === 'payment';
  const amount = lens === 'expert' ? null : UPFRONT;
  const theInvoice = amount === null ? 'the upfront invoice' : `the ${amount} upfront invoice`;
  const memberBlocked = lens === 'client' && member && !billingDone;

  const billing = {
    key: 'billing',
    owner: 'client',
    icon: User,
    label: 'Add billing details',
    done: billingDone,
    sub: (() => {
      if (memberBlocked)
        return 'A company owner or admin needs to add these billing details before kickoff.';
      if (billingDone) return 'Billing details added';
      if (lens === 'client') return 'Add your billing details';
      return `Waiting on ${COMPANY} to add billing details`;
    })(),
    futureSub: null,
    // ClientBillingAffordance, unchanged (capture form / member notice / view-edit).
    action: lens === 'client' && !memberBlocked ? { label: 'Add details' } : null,
    doneAction: lens === 'client' && !member ? { label: 'View' } : null,
  };

  if (!hasUpfront) {
    return [
      billing,
      {
        key: 'approval',
        owner: 'admin',
        icon: BadgeCheck,
        label: 'Approve kickoff',
        done: approved,
        sub: approved
          ? 'Kickoff approved'
          : lens === 'admin'
            ? 'Nothing is due upfront on this deal — approve to kick off'
            : 'Nothing is due upfront — waiting on Balo to approve kickoff',
        futureSub: 'Available once billing details are in',
        action: lens === 'admin' ? { label: 'Approve' } : null,
      },
    ];
  }

  return [
    billing,
    {
      key: 'invoice',
      owner: 'admin',
      icon: Receipt,
      label: 'Raise the upfront invoice',
      done: invoiceDone,
      sub: invoiceDone
        ? amount === null
          ? 'Upfront invoice sent'
          : `Invoice for ${amount} sent`
        : lens === 'admin'
          ? `Invoice ${COMPANY} for ${UPFRONT}, then mark it sent`
          : `Waiting on Balo to send ${theInvoice}`,
      // CHANGED for client/expert (was "Waiting on Balo to send…" before it could start).
      futureSub: 'Available once billing details are in',
      action: lens === 'admin' ? { label: 'Mark sent' } : null,
    },
    {
      key: 'payment',
      owner: 'client',
      icon: Banknote,
      label: 'Pay the upfront invoice',
      done: approved,
      sub: approved
        ? 'Upfront invoice paid'
        : lens === 'client'
          ? `Pay ${theInvoice} Balo sent — kickoff follows as soon as it lands`
          : lens === 'admin'
            ? `Confirm once ${COMPANY}'s payment lands — this kicks off the project`
            : `Waiting on ${COMPANY} to pay the upfront invoice`,
      futureSub:
        lens === 'client'
          ? `Due once Balo sends ${theInvoice}`
          : lens === 'admin'
            ? 'Available once the invoice is sent'
            : 'Due once Balo sends the upfront invoice', // CHANGED for expert
      action: lens === 'admin' ? { label: 'Confirm payment' } : null,
    },
  ];
}

// ── Primitives ──────────────────────────────────────────────────────────────────────────────

function Avatar({ initials, size = 36 }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: c.primaryTint,
        color: c.primary,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12.5,
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      {initials}
    </span>
  );
}

const btnBase = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  minHeight: 36,
  borderRadius: 9,
  fontSize: 12.5,
  fontWeight: 600,
  fontFamily: FONT,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

function OutlineButton({ icon: Icon, children, mobile, grow, ...rest }) {
  return (
    <button
      type="button"
      {...rest}
      style={{
        ...btnBase,
        minHeight: mobile ? 44 : 36,
        flex: grow ? 1 : undefined,
        padding: '0 12px',
        border: `1px solid ${c.border}`,
        background: c.card,
        color: c.muted,
      }}
    >
      {Icon && <Icon size={14} aria-hidden="true" />}
      {children}
    </button>
  );
}

function IconButton({ icon: Icon, label, mobile }) {
  const size = mobile ? 44 : 36;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-book-another=""
      style={{
        ...btnBase,
        width: size,
        height: size,
        minHeight: size,
        padding: 0,
        border: `1px solid ${c.border}`,
        background: c.card,
        color: c.muted,
        flexShrink: 0,
      }}
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  );
}

/** Exactly one Join slot. Live only inside the window; otherwise a countdown, never a disabled button. */
function JoinSlot({ join, mobile }) {
  if (join.live) {
    return (
      <button
        type="button"
        data-join="live"
        style={{
          ...btnBase,
          minHeight: mobile ? 44 : 36,
          flex: mobile ? 1 : undefined,
          padding: '0 14px',
          border: 'none',
          background: c.primary,
          color: '#fff',
          fontSize: 13,
        }}
      >
        <Video size={15} aria-hidden="true" />
        {join.label}
      </button>
    );
  }
  return (
    <span
      data-join="countdown"
      aria-disabled="true"
      title={`Opens ${JOIN_WINDOW_MINUTES} minutes before the call`}
      style={{
        ...btnBase,
        cursor: 'default',
        minHeight: mobile ? 44 : 36,
        flex: mobile ? 1 : undefined,
        padding: '0 12px',
        border: `1px solid ${c.border}`,
        background: c.page,
        color: c.muted,
        fontWeight: 500,
      }}
    >
      <Video size={14} aria-hidden="true" />
      {join.label}
    </span>
  );
}

// ── Thread header ───────────────────────────────────────────────────────────────────────────

function CallGroup({ slot, mobile }) {
  if (slot.kind === 'none') return null;
  if (slot.kind === 'propose') {
    return (
      <OutlineButton icon={Calendar} mobile={mobile} grow={mobile} data-call="propose">
        Propose times
      </OutlineButton>
    );
  }
  if (slot.kind === 'book') {
    return (
      <OutlineButton
        icon={Calendar}
        mobile={mobile}
        grow={mobile}
        data-call="book"
        data-route={slot.route}
        title={
          slot.route === 'profile'
            ? `Opens ${EXPERT.first}'s profile to book a consultation`
            : undefined
        }
      >
        Book a call
      </OutlineButton>
    );
  }
  return (
    <div style={{ display: 'flex', gap: 8, flex: mobile ? 1 : undefined }}>
      <JoinSlot join={slot.join} mobile={mobile} />
      {slot.canBookAnother && (
        <IconButton icon={CalendarPlus} label="Book another call" mobile={mobile} />
      )}
    </div>
  );
}

function NextCallLine({ slot }) {
  if (slot.kind !== 'upcoming') return null;
  return (
    <p
      data-next-call=""
      style={{ margin: '2px 0 0', fontSize: 12.5, color: c.muted, lineHeight: 1.4 }}
    >
      Next call {callWhen(slot.next)}
      {slot.more > 0 && (
        <>
          {' · '}
          <a href="#upcoming" style={{ color: c.primary, textDecoration: 'none', fontWeight: 500 }}>
            +{slot.more} more
          </a>
        </>
      )}
    </p>
  );
}

function ThreadHeader({ lens, stage, slot, mobile }) {
  const showViewProposal = stage === 'active';
  const showDecline = lens === 'client' && stage === 'active';
  const name = (
    <div style={{ minWidth: 0, flex: 1 }}>
      <p
        style={{
          margin: 0,
          fontSize: 14,
          fontWeight: 600,
          color: c.text,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {EXPERT.name}
        {lens === 'expert' && (
          <span style={{ marginLeft: 6, fontSize: 11, color: c.muted, fontWeight: 400 }}>
            (you)
          </span>
        )}
      </p>
      {/* The line is a link to the meeting, where Reschedule lives as a text button. */}
      <NextCallLine slot={slot} />
    </div>
  );
  const proposal = showViewProposal ? (
    <button
      type="button"
      style={{
        ...btnBase,
        padding: '0 12px',
        border: `1px solid ${c.primaryBorder}`,
        background: c.primarySoft,
        color: c.primary,
        minHeight: mobile ? 44 : 36,
      }}
    >
      <FileText size={14} aria-hidden="true" />
      {lens === 'expert' ? 'View submitted proposal' : 'View proposal'}
    </button>
  ) : null;
  const decline = showDecline ? (
    <button
      type="button"
      aria-label={`Decline ${EXPERT.name}`}
      style={{
        ...btnBase,
        width: 36,
        height: 36,
        padding: 0,
        border: `1px solid ${c.border}`,
        background: c.card,
        color: c.muted,
      }}
    >
      <X size={14} aria-hidden="true" />
    </button>
  ) : null;

  if (mobile) {
    return (
      <div
        data-thread-header=""
        style={{
          borderBottom: `1px solid ${c.border}`,
          padding: '12px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Avatar initials={EXPERT.initials} />
          {name}
          {decline}
        </div>
        {(slot.kind !== 'none' || proposal) && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <CallGroup slot={slot} mobile />
            {proposal}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      data-thread-header=""
      style={{
        borderBottom: `1px solid ${c.border}`,
        padding: '12px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <Avatar initials={EXPERT.initials} />
      {name}
      <CallGroup slot={slot} />
      {proposal}
      {decline}
    </div>
  );
}

// ── Thread nudge (the live edge at the top of the thread) ───────────────────────────────────

function threadNudgeFor(lens, requestStatus, stage) {
  if (lens === 'client') {
    if (requestStatus === 'closed')
      return {
        variant: 'done',
        icon: MessageSquare,
        headline: 'This request was closed.',
        sub: 'The conversation stays here for your records.',
      };
    if (stage === 'not_selected')
      return {
        variant: 'done',
        icon: MessageSquare,
        headline: `You didn't select ${EXPERT.first}`,
        sub: "They've been notified graciously. The conversation stays here for your records.",
      };
    // CHANGED — accepted, won thread: nothing to do here, so it is an event, not a nudge.
    if (requestStatus === 'accepted')
      return { variant: 'event', headline: `You chose ${EXPERT.first} for this project` };
    // CHANGED — the workspace link is live (was `stub`, always disabled).
    if (requestStatus === 'kickoff_approved')
      return {
        variant: 'done',
        icon: Zap,
        headline: 'Your project is underway',
        sub: `Milestones, files and updates from ${EXPERT.first} live in the workspace.`,
        primary: {
          label: 'Open project workspace',
          icon: Briefcase,
          href: '/engagements/{deliveryEngagementId}',
        },
      };
    return {
      variant: 'commit',
      icon: Check,
      headline: `${EXPERT.first}'s proposal is ready`,
      sub: 'Read it in full, then accept it or ask for changes.',
      primary: { label: `Accept ${EXPERT.first}'s proposal`, icon: Check },
      secondary: { label: 'View full proposal', icon: FileText },
    };
  }
  // Expert lens
  if (requestStatus === 'closed')
    return {
      variant: 'done',
      icon: MessageSquare,
      headline: `${COMPANY} closed this request.`,
      sub: 'The conversation stays here for your records.',
    };
  if (stage === 'not_selected')
    return {
      variant: 'done',
      icon: MessageSquare,
      headline: 'The client went with another expert',
      sub: 'Thanks for engaging — the conversation stays here for your records.',
    };
  if (requestStatus === 'accepted')
    return {
      variant: 'waiting',
      icon: Clock,
      headline: 'Proposal accepted — kickoff is on its way 🎉',
      sub: `Nothing for you to do yet — Balo is sorting billing with ${COMPANY}, and you'll hear the moment the project kicks off.`,
      secondary: { label: 'Send a message', icon: MessageSquare },
    };
  // CHANGED — live (was `stub`).
  if (requestStatus === 'kickoff_approved')
    return {
      variant: 'done',
      icon: Zap,
      headline: 'Kicked off — time to deliver',
      sub: 'Milestones are in the workspace. Mark them done as you go.',
      primary: {
        label: 'Open workspace',
        icon: Briefcase,
        href: '/engagements/{deliveryEngagementId}',
      },
    };
  return {
    variant: 'waiting',
    icon: Clock,
    headline: 'Your proposal is with the client',
    sub: "They're reviewing it alongside others. Keep the conversation warm.",
    secondary: { label: 'Send a message', icon: MessageSquare },
  };
}

const EYEBROW = {
  action: 'Your next step',
  commit: 'Your next step',
  waiting: 'Waiting',
  done: 'Done',
};
const ACCENT = { action: c.primary, commit: c.primary, waiting: c.warning, done: c.success };

function ThreadNudge({ nudge }) {
  if (nudge.variant === 'event') {
    return (
      <div
        data-nudge="event"
        role="status"
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '2px 2px' }}
      >
        <span style={{ flex: 1, height: 1, background: c.border }} />
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12.5,
            color: c.muted,
          }}
        >
          <PartyPopper size={14} color={c.success} aria-hidden="true" />
          {nudge.headline}
        </span>
        <span style={{ flex: 1, height: 1, background: c.border }} />
      </div>
    );
  }
  const accent = ACCENT[nudge.variant];
  const Icon = nudge.icon;
  return (
    <div
      data-nudge={nudge.variant}
      style={{
        display: 'flex',
        border: `1px solid ${c.border}`,
        borderRadius: 12,
        overflow: 'hidden',
        background: c.card,
      }}
    >
      <span style={{ width: 4, background: accent, flexShrink: 0 }} aria-hidden="true" />
      <div style={{ padding: 14, flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <span
            style={{
              width: 20,
              height: 20,
              borderRadius: 6,
              border: `1px solid ${accent}55`,
              background: `${accent}14`,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon size={12} color={accent} aria-hidden="true" />
          </span>
          {/* The shipped eyebrow style, unchanged. */}
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: accent,
            }}
          >
            {EYEBROW[nudge.variant]}
          </span>
        </div>
        <p style={{ margin: '0 0 0 28px', fontSize: 14, fontWeight: 600, color: c.text }}>
          {nudge.headline}
        </p>
        {nudge.sub && (
          <p style={{ margin: '2px 0 0 28px', fontSize: 13, color: c.muted, lineHeight: 1.5 }}>
            {nudge.sub}
          </p>
        )}
        {(nudge.primary || nudge.secondary) && (
          <div style={{ margin: '10px 0 0 28px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {nudge.primary &&
              (nudge.primary.href ? (
                <a
                  href={nudge.primary.href}
                  data-nudge-primary="link"
                  style={{
                    ...btnBase,
                    textDecoration: 'none',
                    padding: '0 14px',
                    borderRadius: 10,
                    background: c.primary,
                    color: '#fff',
                    fontSize: 13,
                  }}
                >
                  <nudge.primary.icon size={14} aria-hidden="true" />
                  {nudge.primary.label}
                </a>
              ) : (
                <button
                  type="button"
                  style={{
                    ...btnBase,
                    padding: '0 14px',
                    borderRadius: 10,
                    border: 'none',
                    background: c.primary,
                    color: '#fff',
                    fontSize: 13,
                  }}
                >
                  <nudge.primary.icon size={14} aria-hidden="true" />
                  {nudge.primary.label}
                </button>
              ))}
            {nudge.secondary && (
              <button
                type="button"
                style={{
                  ...btnBase,
                  padding: '0 12px',
                  borderRadius: 10,
                  border: `1px solid ${c.border}`,
                  background: c.card,
                  color: c.muted,
                  fontWeight: 500,
                }}
              >
                <nudge.secondary.icon size={14} aria-hidden="true" />
                {nudge.secondary.label}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Conversation card ───────────────────────────────────────────────────────────────────────

function Bubble({ mine, children }) {
  return (
    <div style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start' }}>
      <p
        style={{
          margin: 0,
          maxWidth: '78%',
          padding: '9px 13px',
          borderRadius: 14,
          fontSize: 14,
          lineHeight: 1.5,
          color: c.text,
          background: mine ? c.bubbleMine : c.bubbleTheirs,
          border: mine ? `1px solid ${c.primaryBorder}` : 'none',
        }}
      >
        {children}
      </p>
    </div>
  );
}

function ConversationCard({ lens, requestStatus, stage, slot, mobile }) {
  const nudge = threadNudgeFor(lens, requestStatus, stage);
  const fromClient = lens === 'client';
  return (
    <section
      aria-label="Conversation"
      style={{
        background: c.card,
        border: `1px solid ${c.border}`,
        borderRadius: 16,
        overflow: 'hidden',
      }}
    >
      <ThreadHeader lens={lens} stage={stage} slot={slot} mobile={mobile} />
      <div style={{ padding: mobile ? 14 : 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {nudge && <ThreadNudge nudge={nudge} />}
        <Bubble mine={!fromClient}>
          Thanks for the brief. Happy to walk through the plan on a call this week.
        </Bubble>
        <Bubble mine={fromClient}>
          Great, that would help us line up the contact centre team.
        </Bubble>
      </div>
      <div style={{ borderTop: `1px solid ${c.border}`, padding: 12, display: 'flex', gap: 8 }}>
        <input
          aria-label="Message"
          placeholder={fromClient ? `Message ${EXPERT.first}` : `Message ${COMPANY}`}
          style={{
            flex: 1,
            minHeight: 40,
            border: `1px solid ${c.border}`,
            borderRadius: 10,
            padding: '0 12px',
            fontSize: 14,
            fontFamily: FONT,
            color: c.text,
          }}
        />
        <button
          type="button"
          aria-label="Send message"
          style={{
            ...btnBase,
            width: 40,
            height: 40,
            padding: 0,
            border: 'none',
            borderRadius: 10,
            background: c.primary,
            color: '#fff',
          }}
        >
          <Send size={15} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

// ── Before kickoff thread ───────────────────────────────────────────────────────────────────

function StepNode({ state }) {
  const base = {
    width: 24,
    height: 24,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    boxSizing: 'border-box',
  };
  if (state === 'done')
    return (
      <span aria-hidden="true" style={{ ...base, background: c.success, color: '#fff' }}>
        <Check size={13} />
      </span>
    );
  if (state === 'current')
    return (
      <span
        aria-hidden="true"
        style={{
          ...base,
          border: `2px solid ${c.primary}`,
          background: c.primaryTint,
          color: c.primary,
        }}
      >
        <Clock size={12} />
      </span>
    );
  if (state === 'optional')
    return (
      <span
        aria-hidden="true"
        style={{ ...base, border: `1.5px dashed ${c.borderStrong}`, color: c.faint }}
      >
        <Video size={11} />
      </span>
    );
  return <span aria-hidden="true" style={{ ...base, border: `1.5px solid ${c.borderStrong}` }} />;
}

function Rail({ state, line, children }) {
  return (
    <li
      data-step-state={state}
      aria-current={state === 'current' ? 'step' : undefined}
      style={{
        display: 'grid',
        gridTemplateColumns: '24px minmax(0, 1fr)',
        columnGap: 12,
        listStyle: 'none',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <StepNode state={state} />
        {line && (
          <span
            aria-hidden="true"
            style={{ width: 2, flex: 1, minHeight: 14, margin: '4px 0', ...line }}
          />
        )}
      </div>
      <div style={{ paddingBottom: line ? 18 : 0, minWidth: 0 }}>{children}</div>
    </li>
  );
}

function StepBody({ step, state, owner }) {
  const muted = state === 'future';
  const sub = state === 'future' ? step.futureSub : step.sub;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            margin: '2px 0 0',
            fontSize: 14,
            fontWeight: 500,
            color: muted ? c.muted : c.text,
          }}
        >
          {step.label}
          <span
            data-owner=""
            style={{
              marginLeft: 8,
              fontSize: 12,
              fontWeight: 400,
              color: state === 'current' && owner === 'You' ? c.primary : c.faint,
            }}
          >
            {owner}
          </span>
        </p>
        {sub && (
          <p
            style={{
              margin: '2px 0 0',
              fontSize: 12.5,
              lineHeight: 1.5,
              color: muted ? c.faint : c.muted,
            }}
          >
            {sub}
          </p>
        )}
      </div>
      {state === 'current' && step.action && (
        <button
          type="button"
          data-step-action=""
          style={{
            ...btnBase,
            padding: '0 14px',
            border: 'none',
            borderRadius: 8,
            background: c.primary,
            color: '#fff',
            fontSize: 13,
          }}
        >
          {step.action.label}
        </button>
      )}
      {state === 'done' && step.doneAction && (
        <a
          href="#billing"
          style={{
            fontSize: 12.5,
            color: c.primary,
            textDecoration: 'none',
            fontWeight: 500,
            marginTop: 3,
          }}
        >
          {step.doneAction.label}
        </a>
      )}
    </div>
  );
}

function KickoffCelebration() {
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        border: `1px solid ${c.successBorder}`,
        background: c.successSoft,
        borderRadius: 16,
        padding: 18,
      }}
    >
      <PartyPopper size={20} color={c.success} aria-hidden="true" />
      <div>
        <p style={{ margin: 0, fontSize: 15, fontWeight: 600, color: c.text }}>
          Project kicked off
        </p>
        <p style={{ margin: '2px 0 0', fontSize: 13.5, color: c.muted, lineHeight: 1.5 }}>
          Kickoff celebration banner, unchanged.
        </p>
      </div>
    </div>
  );
}

function BeforeKickoff({ lens, progress, hasUpfront, approved, member, slot, mobile }) {
  const steps = deriveKickoffSteps({ lens, progress, hasUpfront, approved, member });
  const firstOpen = steps.findIndex((s) => !s.done);
  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length;
  const ownerLabel = (owner) => {
    if (owner === 'client') return lens === 'client' ? 'You' : COMPANY;
    return lens === 'admin' ? 'You' : 'Balo';
  };
  const callBooked = slot.kind === 'upcoming';
  const callSub = (() => {
    if (callBooked) return `Booked for ${callWhen(slot.next)}.`;
    if (lens === 'client') return "Book any time — it doesn't hold up kickoff.";
    if (lens === 'expert') return `${COMPANY} can book a time on your calendar.`;
    return "Optional — it doesn't hold up approval.";
  })();
  const callLabel =
    lens === 'client'
      ? `Kickoff call with ${EXPERT.first}`
      : lens === 'expert'
        ? `Kickoff call with ${COMPANY}`
        : 'Kickoff call';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {approved && <KickoffCelebration />}
      <section
        aria-label="Before kickoff"
        data-kickoff-board=""
        style={{
          background: c.card,
          border: `1px solid ${c.border}`,
          borderRadius: 16,
          padding: mobile ? 16 : 22,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 12,
            marginBottom: 18,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: c.text }}>
            Before kickoff
          </h3>
          <span
            data-counter=""
            style={{
              fontSize: 12.5,
              fontWeight: 500,
              color: allDone ? c.success : c.muted,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {allDone ? 'All done' : `${doneCount} of ${steps.length} done`}
          </span>
        </div>
        <ol style={{ margin: 0, padding: 0 }}>
          {steps.map((step, i) => {
            const state = step.done ? 'done' : i === firstOpen ? 'current' : 'future';
            const isLastGate = i === steps.length - 1;
            const showCallRow = !approved;
            let line = null;
            if (!isLastGate) line = { background: step.done ? c.successBorder : c.border };
            else if (showCallRow)
              line = { background: 'none', borderLeft: `2px dashed ${c.border}`, width: 0 };
            return (
              <Rail key={step.key} state={state} line={line}>
                <StepBody step={step} state={state} owner={ownerLabel(step.owner)} />
              </Rail>
            );
          })}
          {!approved && (
            <Rail state="optional" line={null}>
              <div
                data-kickoff-call=""
                style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: '2px 0 0', fontSize: 14, fontWeight: 500, color: c.text }}>
                    {callLabel}
                  </p>
                  <p style={{ margin: '2px 0 0', fontSize: 12.5, lineHeight: 1.5, color: c.muted }}>
                    {callSub}
                  </p>
                </div>
                {lens === 'client' && !callBooked && (
                  <OutlineButton icon={Calendar} data-call="kickoff">
                    Pick a time
                  </OutlineButton>
                )}
              </div>
            </Rail>
          )}
        </ol>
      </section>
    </div>
  );
}

// ── Controls ────────────────────────────────────────────────────────────────────────────────

function Segmented({ label, value, options, onChange }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, color: c.muted }}>{label}</span>
      <div
        role="radiogroup"
        aria-label={label}
        style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}
      >
        {options.map(([v, l]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={value === v}
            onClick={() => onChange(v)}
            style={{
              ...btnBase,
              minHeight: 30,
              fontSize: 12,
              fontWeight: 500,
              padding: '0 10px',
              borderRadius: 8,
              border: `1px solid ${value === v ? c.primaryBorder : c.border}`,
              background: value === v ? c.primarySoft : c.card,
              color: value === v ? c.primary : c.muted,
            }}
          >
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

function Notes() {
  const items = [
    [
      'Always bookable',
      'Client lens, every stage. Active and won threads book in place (intro dialog before acceptance, project-context dialog after). Not-selected threads and closed requests route to the expert’s profile booking; hide the button only when the expert has no public username.',
    ],
    [
      'Booked',
      'Next-call line under the name, using the Up next row label. One Join slot from the dashboard ladder; only “Join now” is a button. Booking shrinks to the calendar-plus icon with tooltip and aria-label “Book another call”. “+N more” opens the upcoming list. Tapping the line opens the meeting, where Reschedule lives.',
    ],
    [
      'Expert lens',
      'Never books from here. Sees the next-call line and Join. “Propose times” keeps today’s gate.',
    ],
    [
      'Nudges',
      'Never a disabled button; `stub` is gone. Accepted (won) is a quiet event line. Kickoff approved links to the workspace for both lenses.',
    ],
    [
      'Before kickoff',
      'Owner named on every step. One current step, highlighted; future steps muted with no chip. Counter counts gating steps only. Admin buttons only on the current step. Kickoff call row is optional, never counted, never gates approval, and disappears once kickoff is approved.',
    ],
  ];
  return (
    <section
      aria-label="Spec notes"
      style={{
        background: c.card,
        border: `1px dashed ${c.borderStrong}`,
        borderRadius: 16,
        padding: 20,
      }}
    >
      <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600, color: c.text }}>
        Spec notes for implementation
      </h3>
      <dl
        style={{
          margin: 0,
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 150px) minmax(0, 1fr)',
          gap: '10px 16px',
        }}
      >
        {items.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt style={{ fontSize: 13, fontWeight: 600, color: c.text }}>{k}</dt>
            <dd style={{ margin: 0, fontSize: 13, color: c.muted, lineHeight: 1.55 }}>{v}</dd>
          </React.Fragment>
        ))}
      </dl>
    </section>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────────────────────

export function RequestCallsAndKickoffView({
  lens = 'client',
  requestStatus = 'accepted',
  outcome = 'won',
  call = 'none',
  progress = 'invoice',
  hasUpfront = true,
  member = false,
  viewport = 'desktop',
}) {
  const mobile = viewport === 'mobile';
  const stage = threadStageFor(requestStatus, outcome);
  const beforeKickoff = requestStatus === 'proposal_submitted' || requestStatus === 'accepted';
  const slot = deriveCallSlot({ lens, stage, calls: CALL_SCENARIOS[call].calls, beforeKickoff });
  const decided = requestStatus === 'accepted' || requestStatus === 'kickoff_approved';
  const approved = requestStatus === 'kickoff_approved';
  // Client sees the board on any tab once decided; the expert only on the won thread; admin always.
  const showBoard = decided && (lens !== 'expert' || stage === 'won');
  const board = showBoard ? (
    <BeforeKickoff
      lens={lens}
      progress={approved ? 'payment' : progress}
      hasUpfront={hasUpfront}
      approved={approved}
      member={member}
      slot={slot}
      mobile={mobile}
    />
  ) : null;
  const briefPlaceholder = (
    <div
      style={{
        background: c.card,
        border: `1px solid ${c.border}`,
        borderRadius: 16,
        padding: 18,
        fontSize: 13,
        color: c.faint,
      }}
    >
      The request brief, details and documents (unchanged).
    </div>
  );

  if (lens === 'admin') {
    return (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: mobile ? '1fr' : 'minmax(0, 1.5fr) minmax(0, 1fr)',
          gap: 20,
          alignItems: 'start',
        }}
      >
        {briefPlaceholder}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {board ?? briefPlaceholder}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: mobile ? '1fr' : 'minmax(0, 1.7fr) minmax(0, 1fr)',
        gap: 20,
        alignItems: 'start',
      }}
    >
      <ConversationCard
        lens={lens}
        requestStatus={requestStatus}
        stage={stage}
        slot={slot}
        mobile={mobile}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {board}
        {briefPlaceholder}
      </div>
    </div>
  );
}

export default function RequestCallsAndKickoff() {
  const [lens, setLens] = useState('client');
  const [requestStatus, setRequestStatus] = useState('accepted');
  const [outcome, setOutcome] = useState('won');
  const [call, setCall] = useState('none');
  const [progress, setProgress] = useState('invoice');
  const [hasUpfront, setHasUpfront] = useState('yes');
  const [viewport, setViewport] = useState('desktop');

  const decided = requestStatus === 'accepted' || requestStatus === 'kickoff_approved';
  return (
    <div
      style={{
        fontFamily: FONT,
        background: c.page,
        minHeight: '100vh',
        padding: 24,
        color: c.text,
      }}
    >
      <div
        style={{
          maxWidth: 1180,
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
        }}
      >
        <header style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
            National Dental Care — CRM and marketing automation
          </h1>
          <p style={{ margin: 0, fontSize: 13, color: c.muted }}>
            Request page: booking, Join, nudges and the Before kickoff thread. “Now” is Tue 27 Oct,
            10:00 am.
          </p>
        </header>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 18,
            background: c.card,
            border: `1px solid ${c.border}`,
            borderRadius: 14,
            padding: 16,
          }}
        >
          <Segmented
            label="Lens"
            value={lens}
            onChange={setLens}
            options={[
              ['client', 'Client'],
              ['expert', 'Expert'],
              ['admin', 'Admin'],
            ]}
          />
          <Segmented
            label="Request"
            value={requestStatus}
            onChange={setRequestStatus}
            options={[
              ['proposal_submitted', 'Choosing'],
              ['accepted', 'Accepted'],
              ['kickoff_approved', 'Kicked off'],
              ['closed', 'Closed'],
            ]}
          />
          {decided && lens !== 'admin' && (
            <Segmented
              label="This thread"
              value={outcome}
              onChange={setOutcome}
              options={[
                ['won', 'Won'],
                ['not_selected', 'Not selected'],
              ]}
            />
          )}
          {lens !== 'admin' && (
            <Segmented
              label="Calls"
              value={call}
              onChange={setCall}
              options={Object.entries(CALL_SCENARIOS).map(([k, v]) => [k, v.label])}
            />
          )}
          {requestStatus === 'accepted' && (
            <Segmented
              label="Kickoff"
              value={progress}
              onChange={setProgress}
              options={[
                ['billing', 'Billing pending'],
                ['billing_member', 'Billing, member'],
                ['invoice', 'Invoice pending'],
                ['payment', 'Payment pending'],
              ]}
            />
          )}
          {decided && (
            <Segmented
              label="Upfront due"
              value={hasUpfront}
              onChange={setHasUpfront}
              options={[
                ['yes', 'Yes'],
                ['no', 'No'],
              ]}
            />
          )}
          <Segmented
            label="Viewport"
            value={viewport}
            onChange={setViewport}
            options={[
              ['desktop', 'Desktop'],
              ['mobile', 'Mobile'],
            ]}
          />
        </div>

        <div
          style={{
            maxWidth: viewport === 'mobile' ? 390 : undefined,
            width: '100%',
            margin: viewport === 'mobile' ? '0 auto' : undefined,
          }}
        >
          <RequestCallsAndKickoffView
            lens={lens}
            requestStatus={requestStatus}
            outcome={outcome}
            call={call}
            progress={progress === 'billing_member' ? 'billing' : progress}
            member={progress === 'billing_member'}
            hasUpfront={hasUpfront === 'yes'}
            viewport={viewport}
          />
        </div>

        <Notes />
      </div>
    </div>
  );
}
