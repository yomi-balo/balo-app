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
 *  5. FILE SHARING FROM THE CHAT (the "Whole page" prototype tab, which also shows 1–4
 *     together). The composer paperclip returns on project requests and writes the SAME
 *     request-file row as before (ADR-1048). The bottom "Files on this request" panel goes.
 *     Files live in the REQUEST PANEL: the "Request documents" card becomes "Files" (the brief
 *     plus the two most recent shares) and "All files · n" opens a sheet; the client can filter
 *     it to what one expert can see. Nothing file-related sits in the thread header or the tab
 *     strip — the header is for actions with this expert (calls, proposal, decline). Picking or dropping a file opens the reused share dialog at once, with a
 *     note field and a primary button that names the audience. Client, matched request:
 *     "{name} only" leads and is preselected. Direct request and expert: no options. Expert:
 *     own conversation only, and no audience shown anywhere.
 *     A share posts a file card (carrying the note) into every thread it reaches at share
 *     time; a track that opens later finds "All interested experts" files in Files only.
 *
 * Out of scope here: the multi-expert stepper / per-tab status chips (waiting on the
 * multi-EOI test run), the page StatusStepper, request context.
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
 *  · Change 5 (files): `conversation/message-composer.tsx` — pass `onAttach` again on the
 *      project-request surface (it was dropped by BAL-431 / OSD-2); it, and a drop on the
 *      thread, open the share dialog. Upload on pick via `request-shared-file-upload.ts`;
 *      write the audience on Share via `confirm-request-file-upload.ts` (immutable once
 *      created). `files/share-file-sheet.tsx` gains a thread mode (file preselected, no
 *      picker, leading "{name} only" option, or no options for direct / expert), a note field
 *      in both modes, an audience-named primary, the picked file shown as plain content (no
 *      outline, so it never reads as an option), and the description "Choose who can see it."
 *      replaced by a "Who can see it" label above the options. Choosing "Only specific
 *      experts" expands the checklist inside that same card, not in a second box below it. `files/request-files-panel.tsx`'s list, `request-file-row.tsx`
 *      and `request-file-audience-badges.tsx` move into the All files sheet, opened from the
 *      request panel's Files card (the renamed "Request documents" card in the shell). A file
 *      message in the conversation, referencing the request file, is new.
 *  · Buttons: solid `--primary` throughout. This is a dashboard surface, so the blue→violet
 *      gradient comes off the composer send button, the thread nudge's PRIMARY_CLASS and the
 *      header's Request / Build proposal CTAs (`from-primary bg-gradient-to-r to-violet-600`).
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  BadgeCheck,
  Banknote,
  Briefcase,
  Calendar,
  CalendarPlus,
  Check,
  Clock,
  File as FileIcon,
  FileSpreadsheet,
  FileText,
  Lock,
  MessageSquare,
  Paperclip,
  PartyPopper,
  Receipt,
  RotateCcw,
  Send,
  Upload,
  User,
  UserPlus,
  Users,
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

function CallGroup({ slot, mobile, expert = EXPERT }) {
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
            ? `Opens ${expert.first}'s profile to book a consultation`
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

function ThreadHeader({ lens, stage, slot, mobile, expert = EXPERT }) {
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
        {expert.name}
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
      aria-label={`Decline ${expert.name}`}
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
          <Avatar initials={expert.initials} />
          {name}
          {decline}
        </div>
        {(slot.kind !== 'none' || proposal) && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <CallGroup slot={slot} mobile expert={expert} />
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
      <Avatar initials={expert.initials} />
      {name}
      <CallGroup slot={slot} expert={expert} />
      {proposal}
      {decline}
    </div>
  );
}

// ── Thread nudge (the live edge at the top of the thread) ───────────────────────────────────

function threadNudgeFor(lens, requestStatus, stage, expert = EXPERT) {
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
        headline: `You didn't select ${expert.first}`,
        sub: "They've been notified graciously. The conversation stays here for your records.",
      };
    // CHANGED — accepted, won thread: nothing to do here, so it is an event, not a nudge.
    if (requestStatus === 'accepted')
      return { variant: 'event', headline: `You chose ${expert.first} for this project` };
    // CHANGED — the workspace link is live (was `stub`, always disabled).
    if (requestStatus === 'kickoff_approved')
      return {
        variant: 'done',
        icon: Zap,
        headline: 'Your project is underway',
        sub: `Milestones, files and updates from ${expert.first} live in the workspace.`,
        primary: {
          label: 'Open project workspace',
          icon: Briefcase,
          href: '/engagements/{deliveryEngagementId}',
        },
      };
    return {
      variant: 'commit',
      icon: Check,
      headline: `${expert.first}'s proposal is ready`,
      sub: 'Read it in full, then accept it or ask for changes.',
      primary: { label: `Accept ${expert.first}'s proposal`, icon: Check },
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

// ── Change 5 — file sharing from the chat ───────────────────────────────────────────────────
//
// One store (request files, ADR-1048), two ways in: the composer paperclip (new on project
// requests, plus drag and drop onto the conversation) and the "All files" sheet (replaces the
// bottom "Files on this request" panel). Picking or dropping a file opens the share dialog at
// once; nothing waits in the composer.
//
//  · Client, matched request: three options, "{name} only" leading and preselected.
//  · Client, direct request, and the expert lens: no options (one recipient). Experts never
//    see an audience anywhere (ADR-1048's concealment rule: the expert view has no audience).
//  · The primary button names the audience. The upload runs while the dialog is open; Share
//    during the upload shows progress and completes on its own. The audience is written on
//    Share (it is immutable once created).
//  · A share posts a file card (carrying the note) into every thread it reaches AT SHARE TIME.
//    A track that opens later finds "All interested experts" files in its Files list only.

const FS_EXPERTS = {
  r1: { id: 'r1', name: 'Charles Akintunde', first: 'Charles', initials: 'CA' },
  r2: { id: 'r2', name: 'Priya Raman', first: 'Priya', initials: 'PR' },
  r3: { id: 'r3', name: 'Sam Okafor', first: 'Sam', initials: 'SO' },
};
const FS_LATE_JOINER = 'r3';

export function initialFileState(kind) {
  const threads = kind === 'direct' ? ['r1'] : ['r1', 'r2'];
  const files = [
    {
      id: 'f1',
      name: 'Security questionnaire.xlsx',
      size: '48 KB',
      from: 'client',
      audience: { type: 'all' },
      note: null,
      when: '2 days ago',
    },
    {
      id: 'f2',
      name: 'Approach overview.pdf',
      size: '1.2 MB',
      from: 'r1',
      audience: { type: 'own', id: 'r1' },
      note: null,
      when: 'yesterday',
    },
  ];
  const messages = {
    r1: [
      { id: 'm1', kind: 'file', fileId: 'f1', from: 'client' },
      {
        id: 'm2',
        kind: 'text',
        from: 'r1',
        text: 'Thanks for the brief. Could you send the current lead-flow export?',
      },
      { id: 'm3', kind: 'file', fileId: 'f2', from: 'r1' },
    ],
    r2: [
      { id: 'm4', kind: 'file', fileId: 'f1', from: 'client' },
      {
        id: 'm5',
        kind: 'text',
        from: 'r2',
        text: 'Happy to look at the Marketing Cloud side too.',
      },
    ],
    r3: [],
  };
  return { kind, threads, files, messages, seq: 10 };
}

/** Which live threads a share reaches right now. */
export function receivingThreads(audience, liveThreads) {
  if (audience.type === 'all') return [...liveThreads];
  if (audience.type === 'some') return audience.ids.filter((id) => liveThreads.includes(id));
  return [audience.id];
}

/** Whether a thread's expert can see a file. "all" is dynamic: a later track sees it too. */
export function canSee(file, threadId, liveThreads) {
  if (file.audience.type === 'all') return liveThreads.includes(threadId);
  if (file.audience.type === 'some') return file.audience.ids.includes(threadId);
  return file.audience.id === threadId;
}

export function defaultAudience(lens, threadId) {
  return lens === 'client' ? { type: 'some', ids: [threadId] } : { type: 'own', id: threadId };
}

export function canChangeAudience(lens, kind) {
  return lens === 'client' && kind === 'matched';
}

const joinNames = (names) =>
  names.length <= 1
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** Client and admin copy only — the expert lens never renders an audience. */
export function audienceText(audience, liveThreads) {
  if (audience.type === 'all') return `All interested experts · ${liveThreads.length}`;
  if (audience.type === 'own') return 'Their conversation only';
  if (audience.ids.length === 0) return 'No experts have access';
  if (audience.ids.length === 1) return `${FS_EXPERTS[audience.ids[0]].first} only`;
  return joinNames(audience.ids.map((id) => FS_EXPERTS[id].first));
}

/** Share a file: one store row, plus a card (with the note) in every thread it reaches now. */
export function shareFile(state, { name, size, audience, note, from }) {
  const seq = state.seq + 1;
  const fileId = `f${seq}`;
  const file = { id: fileId, name, size, from, audience, note: note || null, when: 'just now' };
  const messages = { ...state.messages };
  for (const t of receivingThreads(audience, state.threads)) {
    messages[t] = [
      ...(messages[t] ?? []),
      { id: `m${seq}-${t}`, kind: 'file', fileId, from, note: note || null },
    ];
  }
  return { ...state, seq, files: [...state.files, file], messages };
}

export function postText(state, threadId, from, text) {
  const seq = state.seq + 1;
  return {
    ...state,
    seq,
    messages: {
      ...state.messages,
      [threadId]: [
        ...(state.messages[threadId] ?? []),
        { id: `m${seq}`, kind: 'text', from, text },
      ],
    },
  };
}

/** A new expert expresses interest. Their thread starts empty: no back-filled cards. */
export function addLateExpert(state) {
  if (state.threads.includes(FS_LATE_JOINER)) return state;
  return { ...state, threads: [...state.threads, FS_LATE_JOINER] };
}

/** Remove one expert's access to a "specific experts" file (the shipped revoke). */
export function revokeGrant(state, fileId, threadId) {
  return {
    ...state,
    files: state.files.map((f) =>
      f.id === fileId && f.audience.type === 'some'
        ? { ...f, audience: { type: 'some', ids: f.audience.ids.filter((id) => id !== threadId) } }
        : f
    ),
  };
}

const fmtSize = (bytes) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

function FileGlyph({ name, size = 18, color = c.muted }) {
  const Icon = /\.(xlsx|xls|csv)$/i.test(name)
    ? FileSpreadsheet
    : /\.(pdf|docx?|txt|md)$/i.test(name)
      ? FileText
      : FileIcon;
  return <Icon size={size} color={color} aria-hidden="true" />;
}

function AudienceBadge({ audience, liveThreads, onRevoke }) {
  if (audience.type === 'some' && audience.ids.length > 0 && onRevoke) {
    return (
      <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
        {audience.ids.map((id) => (
          <span
            key={id}
            data-badge="grant"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
              fontSize: 11.5,
              fontWeight: 500,
              padding: '2px 4px 2px 8px',
              borderRadius: 999,
              background: 'rgba(124, 58, 237, 0.08)',
              color: '#6d28d9',
            }}
          >
            {FS_EXPERTS[id].first} only
            <button
              type="button"
              aria-label={`Remove access for ${FS_EXPERTS[id].first}`}
              onClick={() => onRevoke(id)}
              style={{
                border: 'none',
                background: 'none',
                color: 'inherit',
                cursor: 'pointer',
                padding: '0 4px',
                display: 'inline-flex',
              }}
            >
              <X size={11} aria-hidden="true" />
            </button>
          </span>
        ))}
      </span>
    );
  }
  const isAll = audience.type === 'all';
  return (
    <span
      data-badge={audience.type}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11.5,
        fontWeight: 500,
        padding: '2px 8px',
        borderRadius: 999,
        background: isAll
          ? 'rgba(37, 99, 235, 0.08)'
          : audience.type === 'some'
            ? 'rgba(124, 58, 237, 0.08)'
            : c.bubbleTheirs,
        color: isAll ? '#1d4ed8' : audience.type === 'some' ? '#6d28d9' : c.muted,
      }}
    >
      {isAll ? <Users size={11} aria-hidden="true" /> : <Lock size={11} aria-hidden="true" />}
      {audienceText(audience, liveThreads)}
    </span>
  );
}

// ── The share dialog — opens the moment a file is picked or dropped ─────────────────────────

/** The primary button names the audience, so the commit says exactly what it does. */
export function shareLabel(lens, audience) {
  if (lens === 'expert') return `Share with ${COMPANY}`;
  if (audience.type === 'all') return 'Share with all interested experts';
  if (audience.ids.length === 1) return `Share with ${FS_EXPERTS[audience.ids[0]].first}`;
  if (audience.ids.length === 0) return 'Share';
  return `Share with ${audience.ids.length} experts`;
}

/**
 * One choice in the dialog. The card is the container; the radio is its header row. When a
 * choice has follow-up input (the expert checklist), it expands INSIDE the same card rather
 * than opening a second box below it. Checkboxes sit beside the radio button, never inside it
 * (no interactive content nested in a <button>).
 */
function OptionCard({ selected, icon: Icon, title, sub, onClick, value, children }) {
  return (
    <div
      data-option-card={value}
      style={{
        borderRadius: 10,
        border: `1px solid ${selected ? c.primary : c.border}`,
        background: selected ? c.primarySoft : c.card,
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        data-option={value}
        onClick={onClick}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          width: '100%',
          textAlign: 'left',
          padding: '10px 12px',
          cursor: 'pointer',
          fontFamily: FONT,
          border: 'none',
          background: 'none',
        }}
      >
        <Icon
          size={16}
          color={c.primary}
          style={{ marginTop: 2, flexShrink: 0 }}
          aria-hidden="true"
        />
        <span>
          <span style={{ display: 'block', fontSize: 14, fontWeight: 500, color: c.text }}>
            {title}
          </span>
          <span style={{ display: 'block', fontSize: 12.5, color: c.muted, marginTop: 1 }}>
            {sub}
          </span>
        </span>
      </button>
      {selected && children}
    </div>
  );
}

/**
 * The shipped share dialog, reused for both ways in.
 *  · mode 'thread' — opened by the composer paperclip or a drop on the thread. The file is
 *    already picked and uploading. Client on a matched request gets three options with
 *    "{name} only" leading and preselected. Direct requests and the expert lens get no
 *    options: one recipient, nothing to choose.
 *  · mode 'new' — "Share with several experts" in All files: file picker, the two shipped
 *    options, "All interested experts" preselected.
 * Both carry a note field (the caption) and a primary button named by the audience. Pressing
 * it during the upload shows progress and completes on its own; Cancel discards the upload.
 */
export function ShareDialog({
  mode,
  lens,
  kind,
  threadId,
  liveThreads,
  upload,
  pending,
  initialAudience,
  initialNote = '',
  onCancel,
  onShare,
  mobile,
}) {
  const showOptions = mode === 'new' || canChangeAudience(lens, kind);
  const seed =
    initialAudience ?? (mode === 'new' ? { type: 'all' } : defaultAudience(lens, threadId));
  const seedChoice =
    seed.type === 'all'
      ? 'all'
      : seed.type === 'own'
        ? 'own'
        : seed.ids.length === 1 && seed.ids[0] === threadId
          ? 'this'
          : 'some';
  const [choice, setChoice] = useState(seedChoice);
  const [picks, setPicks] = useState(seed.type === 'some' ? seed.ids : threadId ? [threadId] : []);
  const [note, setNote] = useState(initialNote);
  const [newFile, setNewFile] = useState(null);
  const [error, setError] = useState(null);
  const toggle = (id) => setPicks((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const audience =
    choice === 'own'
      ? { type: 'own', id: threadId }
      : choice === 'this'
        ? { type: 'some', ids: [threadId] }
        : choice === 'all'
          ? { type: 'all' }
          : { type: 'some', ids: picks };
  const reaches = receivingThreads(audience, liveThreads);
  const file = mode === 'new' ? newFile : upload;

  const share = () => {
    if (pending) return;
    if (mode === 'new' && newFile === null) return setError('Choose a file to share.');
    if (audience.type === 'some' && audience.ids.length === 0)
      return setError('Pick at least one expert.');
    onShare(audience, note.trim(), newFile);
  };

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.35)',
        display: 'flex',
        alignItems: mobile ? 'flex-end' : 'center',
        justifyContent: 'center',
        padding: mobile ? 0 : 24,
        zIndex: 30,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        data-dialog={mode}
        style={{
          background: c.card,
          width: '100%',
          maxWidth: mobile ? '100%' : 460,
          maxHeight: '100%',
          overflowY: 'auto',
          borderRadius: mobile ? '16px 16px 0 0' : 14,
          padding: 20,
          boxShadow: '0 12px 40px rgba(15, 23, 42, 0.18)',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div>
            <h3
              id="share-title"
              style={{ margin: 0, fontSize: 17, fontWeight: 600, color: c.text }}
            >
              Share a file
            </h3>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onCancel}
            style={{
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              color: c.muted,
              padding: 4,
            }}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        {mode === 'thread' ? (
          <div
            data-dialog-file=""
            style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '2px 0' }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 40,
                height: 40,
                borderRadius: 10,
                background: c.bubbleTheirs,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <FileGlyph name={upload.name} size={19} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p
                style={{
                  margin: 0,
                  fontSize: 13.5,
                  fontWeight: 500,
                  color: c.text,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {upload.name}
              </p>
              {upload.progress < 100 ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                  <span
                    style={{
                      flex: 1,
                      height: 4,
                      borderRadius: 2,
                      background: c.border,
                      overflow: 'hidden',
                    }}
                  >
                    <span
                      style={{
                        display: 'block',
                        height: '100%',
                        width: `${upload.progress}%`,
                        background: c.primary,
                      }}
                    />
                  </span>
                  <span
                    style={{ fontSize: 11.5, color: c.muted, fontVariantNumeric: 'tabular-nums' }}
                  >
                    {upload.progress}%
                  </span>
                </div>
              ) : (
                <p style={{ margin: 0, fontSize: 12, color: c.muted }}>{upload.size}</p>
              )}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label htmlFor="fs-new-file" style={{ fontSize: 12, fontWeight: 500, color: c.muted }}>
              File
            </label>
            <input
              id="fs-new-file"
              type="file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) setNewFile({ name: f.name, size: fmtSize(f.size) });
                setError(null);
              }}
              style={{
                border: `1px solid ${c.border}`,
                borderRadius: 8,
                padding: '6px 10px',
                fontSize: 13,
                fontFamily: FONT,
              }}
            />
            <button
              type="button"
              onClick={() => {
                setNewFile({ name: 'Org data model export.csv', size: '220 KB' });
                setError(null);
              }}
              style={{
                alignSelf: 'flex-start',
                border: 'none',
                background: 'none',
                padding: 0,
                color: c.primary,
                fontSize: 12.5,
                cursor: 'pointer',
                fontFamily: FONT,
              }}
            >
              {newFile ? `Selected: ${newFile.name}` : 'Prototype: use a sample file'}
            </button>
          </div>
        )}

        {showOptions && (
          <div
            role="radiogroup"
            aria-labelledby="share-audience-label"
            style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}
          >
            <span
              id="share-audience-label"
              data-audience-label=""
              style={{ fontSize: 12, fontWeight: 500, color: c.muted }}
            >
              Who can see it
            </span>
            {mode === 'thread' && (
              <OptionCard
                value="this"
                selected={choice === 'this'}
                icon={Lock}
                title={`${FS_EXPERTS[threadId].first} only`}
                sub="Just this conversation."
                onClick={() => {
                  setChoice('this');
                  setError(null);
                }}
              />
            )}
            <OptionCard
              value="all"
              selected={choice === 'all'}
              icon={Users}
              title={`All interested experts · ${liveThreads.length}`}
              sub="Experts who express interest later will also see this file."
              onClick={() => {
                setChoice('all');
                setError(null);
              }}
            />
            <OptionCard
              value="some"
              selected={choice === 'some'}
              icon={Lock}
              title="Only specific experts"
              sub="For sensitive documents — an NDA-gated contract, for example."
              onClick={() => {
                setChoice('some');
                setError(null);
              }}
            >
              {/* Indented to the title's left edge: 12px card padding + 16px icon + 10px gap. */}
              <div
                role="group"
                aria-label="Experts who can see it"
                data-expert-picks=""
                style={{ padding: '0 12px 8px 38px', display: 'flex', flexDirection: 'column' }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    height: 1,
                    background: c.primaryBorder,
                    opacity: 0.5,
                    margin: '0 0 4px',
                  }}
                />
                {liveThreads.map((id) => (
                  <label
                    key={id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      minHeight: mobile ? 44 : 36,
                      fontSize: 14,
                      color: c.text,
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={picks.includes(id)}
                      onChange={() => {
                        toggle(id);
                        setError(null);
                      }}
                      style={{ width: 16, height: 16, accentColor: c.primary, margin: 0 }}
                    />
                    {FS_EXPERTS[id].name}
                    {id === threadId && (
                      <span style={{ fontSize: 12, color: c.muted }}>this conversation</span>
                    )}
                  </label>
                ))}
              </div>
            </OptionCard>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label htmlFor="fs-note" style={{ fontSize: 12, fontWeight: 500, color: c.muted }}>
            Note (optional)
          </label>
          <textarea
            id="fs-note"
            data-note=""
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note to go with the file"
            style={{
              resize: 'vertical',
              border: `1px solid ${c.border}`,
              borderRadius: 10,
              padding: '9px 12px',
              fontSize: 14,
              fontFamily: FONT,
              color: c.text,
            }}
          />
        </div>

        {lens === 'client' &&
          mode === 'thread' &&
          showOptions &&
          !reaches.includes(threadId) &&
          reaches.length > 0 && (
            <p data-hint="excluded" style={{ margin: 0, fontSize: 12.5, color: c.warning }}>
              This file won't appear in this conversation. Only{' '}
              {joinNames(reaches.map((t) => FS_EXPERTS[t].first))} will see it.
            </p>
          )}
        {lens === 'client' && showOptions && reaches.length > 1 && (
          <p data-hint="note-travels" style={{ margin: 0, fontSize: 12.5, color: c.muted }}>
            Your note goes with the file to everyone it's shared with.
          </p>
        )}
        {error && (
          <p role="alert" style={{ margin: 0, fontSize: 12.5, color: '#dc2626' }}>
            {error}
          </p>
        )}

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            marginTop: 4,
            flexWrap: 'wrap',
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            style={{
              ...btnBase,
              padding: '0 14px',
              border: `1px solid ${c.border}`,
              background: c.card,
              color: c.text,
              fontWeight: 500,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            data-dialog-confirm=""
            aria-busy={pending || undefined}
            onClick={share}
            style={{
              ...btnBase,
              padding: '0 14px',
              border: 'none',
              background: c.primary,
              color: '#fff',
            }}
          >
            {pending ? `Sharing… ${file?.progress ?? 100}%` : shareLabel(lens, audience)}
            {!pending && <Check size={14} aria-hidden="true" />}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Files: one card in the request panel, one sheet ─────────────────────────────────────────
//
// Files live in the request panel, not the thread header or the tab strip: the header is for
// actions you take with THIS expert (calls, the proposal, declining). The card replaces
// "Request documents" — the brief plus recently shared files — and "All files · n" opens the
// sheet. On mobile the panel sits in the request sheet.

const BRIEF = { id: 'brief', name: '210601 - NDC CRM Brief vF.pdf', size: '260 KB' };

function BriefRow({ compact }) {
  return (
    <li
      data-brief=""
      style={{
        display: 'flex',
        gap: 10,
        padding: compact ? '8px 0' : '10px 10px',
        alignItems: 'center',
      }}
    >
      <span
        style={{
          width: 34,
          height: 34,
          borderRadius: 8,
          background: 'rgba(220, 38, 38, 0.08)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <FileText size={17} color="#dc2626" aria-hidden="true" />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontSize: 13.5,
            fontWeight: 500,
            color: c.text,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {BRIEF.name}
        </p>
        <p style={{ margin: 0, fontSize: 12, color: c.muted }}>Request brief · {BRIEF.size}</p>
      </div>
    </li>
  );
}

function SharedFileRow({ f, lens, viewerThread, liveThreads, onRevoke, compact }) {
  const by =
    lens === 'client'
      ? f.from === 'client'
        ? 'Shared by you'
        : `From ${FS_EXPERTS[f.from].first}`
      : f.from === viewerThread
        ? 'Shared by you'
        : `From ${COMPANY}`;
  return (
    <li
      data-file-row={f.id}
      style={{ display: 'flex', gap: 10, padding: compact ? '8px 0' : '10px 10px' }}
    >
      <span
        style={{
          width: 34,
          height: 34,
          borderRadius: 8,
          background: c.bubbleTheirs,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <FileGlyph name={f.name} size={17} />
      </span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <p
          style={{
            margin: 0,
            fontSize: 13.5,
            fontWeight: 500,
            color: c.text,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {f.name}
        </p>
        <p style={{ margin: 0, fontSize: 12, color: c.muted }}>
          {by} · {f.when}
          {compact ? '' : ` · ${f.size}`}
        </p>
        {/* Client only — the expert lens has no audience field (ADR-1048). */}
        {lens === 'client' && (
          <AudienceBadge
            audience={f.audience}
            liveThreads={liveThreads}
            onRevoke={
              onRevoke && f.audience.type === 'some' ? (id) => onRevoke(f.id, id) : undefined
            }
          />
        )}
      </div>
    </li>
  );
}

/** The request panel's Files card (was "Request documents"). */
function FilesCard({ lens, files, viewerThread, liveThreads, onOpenAll }) {
  const recent = [...files].reverse().slice(0, 2);
  return (
    <section
      aria-label="Files"
      data-files-card=""
      style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 18 }}
    >
      <h3
        style={{
          margin: '0 0 6px',
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          color: c.muted,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <Paperclip size={13} aria-hidden="true" />
        Files
      </h3>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        <BriefRow compact />
        {recent.map((f) => (
          <SharedFileRow
            key={f.id}
            f={f}
            lens={lens}
            viewerThread={viewerThread}
            liveThreads={liveThreads}
            compact
          />
        ))}
      </ul>
      <button
        type="button"
        data-files-card-all=""
        onClick={onOpenAll}
        style={{
          ...btnBase,
          width: '100%',
          marginTop: 8,
          border: `1px solid ${c.border}`,
          background: c.card,
          color: c.text,
          fontWeight: 500,
        }}
      >
        All files · {files.length + 1}
      </button>
    </section>
  );
}

/** The full list. Client on a matched request can filter to what one expert can see. */
function FilesSheet({
  files,
  lens,
  viewerThread,
  liveThreads,
  onClose,
  onRevoke,
  onShareNew,
  mobile,
  initialFilter = 'all',
}) {
  const [filter, setFilter] = useState(initialFilter);
  const showFilter = lens === 'client' && liveThreads.length > 1;
  const shown = filter === 'all' ? files : files.filter((f) => canSee(f, filter, liveThreads));
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.25)',
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: mobile ? 'flex-end' : 'stretch',
        zIndex: 25,
      }}
    >
      <aside
        role="dialog"
        aria-label="All files on this request"
        data-files-sheet=""
        style={{
          background: c.card,
          width: mobile ? '100%' : 420,
          maxHeight: mobile ? '85%' : '100%',
          borderRadius: mobile ? '16px 16px 0 0' : '0',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '-8px 0 30px rgba(15, 23, 42, 0.12)',
        }}
      >
        <div
          style={{
            padding: '16px 18px 12px',
            borderBottom: `1px solid ${c.border}`,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: c.text }}>
                {lens === 'client' ? 'All files on this request' : 'Files'}
              </h3>
              {lens === 'client' && (
                <p style={{ margin: '2px 0 0', fontSize: 12.5, color: c.muted }}>
                  You see every file. Experts see only what is shared with them.
                </p>
              )}
            </div>
            <button
              type="button"
              aria-label="Close files"
              onClick={onClose}
              style={{
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                color: c.muted,
                padding: 4,
              }}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          {showFilter && (
            <div
              role="radiogroup"
              aria-label="Show files"
              data-files-filter=""
              style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}
            >
              {[
                ['all', 'All'],
                ...liveThreads.map((id) => [id, `${FS_EXPERTS[id].first} can see`]),
              ].map(([v, l]) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={filter === v}
                  data-filter={v}
                  onClick={() => setFilter(v)}
                  style={{
                    ...btnBase,
                    minHeight: 30,
                    fontSize: 12,
                    fontWeight: 500,
                    padding: '0 10px',
                    borderRadius: 999,
                    border: `1px solid ${filter === v ? c.primaryBorder : c.border}`,
                    background: filter === v ? c.primarySoft : c.card,
                    color: filter === v ? c.primary : c.muted,
                  }}
                >
                  {l}
                </button>
              ))}
            </div>
          )}
        </div>
        <ul style={{ listStyle: 'none', margin: 0, padding: 8, overflowY: 'auto', flex: 1 }}>
          <BriefRow />
          {shown.map((f) => (
            <SharedFileRow
              key={f.id}
              f={f}
              lens={lens}
              viewerThread={viewerThread}
              liveThreads={liveThreads}
              onRevoke={onRevoke}
            />
          ))}
          {shown.length === 0 && (
            <li style={{ padding: 12, fontSize: 13, color: c.faint }}>No shared files yet.</li>
          )}
        </ul>
        {onShareNew && (
          <div style={{ padding: 14, borderTop: `1px solid ${c.border}` }}>
            <button
              type="button"
              data-share-new=""
              onClick={onShareNew}
              style={{
                ...btnBase,
                width: '100%',
                minHeight: 40,
                border: `1px solid ${c.border}`,
                background: c.card,
                color: c.text,
              }}
            >
              <Upload size={14} aria-hidden="true" />
              Share with several experts
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}

// ── Thread pieces ───────────────────────────────────────────────────────────────────────────

function FileCard({ file, mine, lens, liveThreads, note }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: mine ? 'flex-end' : 'flex-start',
        gap: 4,
      }}
    >
      <div
        data-file-card={file.id}
        style={{
          maxWidth: '78%',
          border: `1px solid ${mine ? c.primaryBorder : c.border}`,
          background: mine ? c.bubbleMine : c.card,
          borderRadius: 14,
          padding: '10px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <FileGlyph name={file.name} size={20} color={mine ? c.primary : c.muted} />
          <div style={{ minWidth: 0 }}>
            <p
              style={{
                margin: 0,
                fontSize: 13.5,
                fontWeight: 500,
                color: c.text,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {file.name}
            </p>
            <p style={{ margin: 0, fontSize: 12, color: c.muted }}>{file.size}</p>
          </div>
        </div>
        {note && <p style={{ margin: 0, fontSize: 14, color: c.text, lineHeight: 1.5 }}>{note}</p>}
      </div>
      {/* Client lens only. The expert lens has no audience field (ADR-1048 concealment). */}
      {lens === 'client' && <AudienceBadge audience={file.audience} liveThreads={liveThreads} />}
    </div>
  );
}

// ── The whole page: calls, kickoff and files together ───────────────────────────────────────

function RequestBriefCard() {
  return (
    <section
      aria-label="The request"
      style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 16, padding: 18 }}
    >
      <h3
        style={{
          margin: '0 0 8px',
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          color: c.muted,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <FileText size={13} aria-hidden="true" />
        The request
      </h3>
      <p style={{ margin: 0, fontSize: 15, fontWeight: 600, color: c.text, lineHeight: 1.35 }}>
        National Dental Care — CRM and Marketing Automation Implementation
      </p>
      <p style={{ margin: '8px 0 0', fontSize: 13, color: c.faint }}>
        Snapshot and details, unchanged.
      </p>
    </section>
  );
}

export function RequestPageView({
  lens = 'client',
  kind = 'matched',
  viewport = 'desktop',
  requestStatus = 'accepted',
  call = 'd1',
  initial,
}) {
  const mobile = viewport === 'mobile';
  const [state, setState] = useState(() => initial?.state ?? initialFileState(kind));
  const viewerThread = 'r1'; // the expert lens views as Charles
  const [current, setCurrent] = useState(initial?.current ?? 'r1');
  const [upload, setUpload] = useState(initial?.upload ?? null);
  const [pending, setPending] = useState(initial?.pending ?? null);
  const [draft, setDraft] = useState(initial?.draft ?? '');
  const [dialog, setDialog] = useState(initial?.dialog ?? null); // null | 'thread' | 'new'
  const [sheet, setSheet] = useState(initial?.sheet ?? false);
  const [railOpen, setRailOpen] = useState(initial?.railOpen ?? false); // mobile request sheet
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef(null);

  const threadId = lens === 'expert' ? viewerThread : current;
  const live = state.threads;
  const expert = FS_EXPERTS[threadId];
  const showTabs = lens === 'client' && state.kind === 'matched' && live.length > 1;
  const from = lens === 'client' ? 'client' : viewerThread;
  const panelFiles =
    lens === 'client' ? state.files : state.files.filter((f) => canSee(f, viewerThread, live));

  // Calls and stage, per thread: Charles is the expert who wins at acceptance.
  const decided = requestStatus !== 'proposal_submitted';
  const stage = !decided ? 'active' : threadId === 'r1' ? 'won' : 'not_selected';
  const beforeKickoff = requestStatus !== 'kickoff_approved';
  const slot = deriveCallSlot({
    lens,
    stage,
    calls: threadId === 'r1' ? CALL_SCENARIOS[call].calls : [],
    beforeKickoff,
  });
  const nudge = threadNudgeFor(lens, requestStatus, stage, expert);
  const showBoard = decided && (lens !== 'expert' || stage === 'won');

  useEffect(() => {
    if (!upload || upload.progress >= 100) return undefined;
    const t = setTimeout(
      () => setUpload((u) => (u ? { ...u, progress: Math.min(100, u.progress + 20) } : u)),
      260
    );
    return () => clearTimeout(t);
  }, [upload]);
  const close = () => {
    setUpload(null);
    setPending(null);
    setDialog(null);
  };
  const commit = (audience, note, file) => {
    setState((s) => shareFile(s, { name: file.name, size: file.size, audience, note, from }));
    setDraft('');
    close();
  };
  useEffect(() => {
    if (pending && upload && upload.progress >= 100) commit(pending.audience, pending.note, upload);
  }, [pending, upload]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (name, size) => {
    setUpload({ name, size, progress: 0 });
    setPending(null);
    setDialog('thread');
  };
  const sendText = () => {
    if (!draft.trim()) return;
    setState((s) => postText(s, threadId, from, draft.trim()));
    setDraft('');
  };

  const conversation = (
    <section
      aria-label="Conversation"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files?.[0];
        if (f) pick(f.name, fmtSize(f.size));
      }}
      style={{
        position: 'relative',
        background: c.card,
        border: `1px solid ${c.border}`,
        borderRadius: 16,
        overflow: 'hidden',
      }}
    >
      {showTabs && (
        <div
          role="tablist"
          aria-label="Experts"
          data-tabstrip=""
          style={{
            display: 'flex',
            alignItems: 'center',
            borderBottom: `1px solid ${c.border}`,
            overflowX: 'auto',
          }}
        >
          {live.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={current === id}
              data-tab={id}
              onClick={() => {
                setCurrent(id);
                setDraft('');
              }}
              style={{
                ...btnBase,
                borderRadius: 0,
                minHeight: 44,
                padding: '0 14px',
                border: 'none',
                borderBottom: `2px solid ${current === id ? c.primary : 'transparent'}`,
                background: 'none',
                color: current === id ? c.text : c.muted,
                fontWeight: current === id ? 600 : 500,
              }}
            >
              <Avatar initials={FS_EXPERTS[id].initials} size={22} />
              {mobile ? FS_EXPERTS[id].first : FS_EXPERTS[id].name}
            </button>
          ))}
        </div>
      )}

      <ThreadHeader lens={lens} stage={stage} slot={slot} mobile={mobile} expert={expert} />

      <div
        data-thread={threadId}
        style={{
          padding: mobile ? 14 : 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          minHeight: mobile ? 240 : 300,
        }}
      >
        {nudge && <ThreadNudge nudge={nudge} />}
        {(state.messages[threadId] ?? []).length === 0 && (
          <p
            data-empty-thread=""
            style={{ margin: 'auto', fontSize: 13, color: c.faint, textAlign: 'center' }}
          >
            {expert.first} just expressed interest. Files shared with all interested experts are in
            Files.
          </p>
        )}
        {(state.messages[threadId] ?? []).map((m) => {
          const mine = lens === 'client' ? m.from === 'client' : m.from === viewerThread;
          if (m.kind === 'text')
            return (
              <Bubble key={m.id} mine={mine}>
                {m.text}
              </Bubble>
            );
          const file = state.files.find((f) => f.id === m.fileId);
          return (
            <FileCard
              key={m.id}
              file={file}
              mine={mine}
              lens={lens}
              liveThreads={live}
              note={m.note}
            />
          );
        })}
      </div>

      <div
        style={{
          borderTop: `1px solid ${c.border}`,
          padding: 12,
          display: 'flex',
          gap: 8,
          alignItems: 'flex-end',
        }}
      >
        <input
          ref={fileInput}
          type="file"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) pick(f.name, fmtSize(f.size));
            e.target.value = '';
          }}
        />
        <button
          type="button"
          aria-label="Share a file"
          title="Share a file"
          data-attach=""
          onClick={() => fileInput.current?.click()}
          style={{
            ...btnBase,
            width: 44,
            height: 44,
            padding: 0,
            border: `1px solid ${c.border}`,
            background: c.card,
            color: c.muted,
          }}
        >
          <Paperclip size={16} aria-hidden="true" />
        </button>
        <textarea
          aria-label={lens === 'client' ? `Message ${expert.first}` : `Message ${COMPANY}`}
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              sendText();
            }
          }}
          placeholder={lens === 'client' ? `Message ${expert.first}…` : `Message ${COMPANY}…`}
          style={{
            flex: 1,
            minHeight: 44,
            resize: 'none',
            border: `1px solid ${c.border}`,
            borderRadius: 10,
            padding: '11px 12px',
            fontSize: 14,
            fontFamily: FONT,
            color: c.text,
          }}
        />
        <button
          type="button"
          aria-label="Send message"
          data-send=""
          onClick={sendText}
          aria-disabled={!draft.trim() || undefined}
          style={{
            ...btnBase,
            width: 44,
            height: 44,
            padding: 0,
            border: 'none',
            background: c.primary,
            color: '#fff',
            opacity: draft.trim() ? 1 : 0.5,
          }}
        >
          <Send size={16} aria-hidden="true" />
        </button>
      </div>

      {dragging && (
        <div
          data-drop-zone=""
          style={{
            position: 'absolute',
            inset: 8,
            border: `2px dashed ${c.primary}`,
            borderRadius: 12,
            background: 'rgba(37, 99, 235, 0.06)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: c.primary }}>
            Drop to share a file
          </span>
        </div>
      )}
    </section>
  );

  const rail = (
    <div data-rail="" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {showBoard && (
        <BeforeKickoff
          lens={lens}
          progress={requestStatus === 'kickoff_approved' ? 'payment' : 'invoice'}
          hasUpfront
          approved={requestStatus === 'kickoff_approved'}
          member={false}
          slot={stage === 'won' ? slot : { kind: 'none' }}
          mobile={mobile}
        />
      )}
      <RequestBriefCard />
      <FilesCard
        lens={lens}
        files={panelFiles}
        viewerThread={viewerThread}
        liveThreads={live}
        onOpenAll={() => setSheet(true)}
      />
    </div>
  );

  return (
    <div style={{ position: 'relative', minHeight: 640 }}>
      {mobile ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Mirrors mobile-request-sheet: the panel is one tap away. */}
          <button
            type="button"
            data-open-rail=""
            onClick={() => setRailOpen(true)}
            style={{
              ...btnBase,
              minHeight: 44,
              justifyContent: 'space-between',
              padding: '0 14px',
              border: `1px solid ${c.border}`,
              background: c.card,
              color: c.text,
              fontWeight: 500,
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <FileText size={15} aria-hidden="true" />
              Request, kickoff and files
            </span>
            <span style={{ fontSize: 12, color: c.muted }}>{panelFiles.length + 1} files</span>
          </button>
          {conversation}
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1.7fr) minmax(0, 1fr)',
            gap: 20,
            alignItems: 'start',
          }}
        >
          {conversation}
          {rail}
        </div>
      )}

      {mobile && railOpen && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.25)',
            display: 'flex',
            alignItems: 'flex-end',
            zIndex: 20,
          }}
        >
          <div
            role="dialog"
            aria-label="Request, kickoff and files"
            data-rail-sheet=""
            style={{
              background: c.page,
              width: '100%',
              maxHeight: '90%',
              overflowY: 'auto',
              borderRadius: '16px 16px 0 0',
              padding: 14,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setRailOpen(false)}
                style={{
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  color: c.muted,
                  padding: 4,
                }}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            {rail}
          </div>
        </div>
      )}

      {sheet && (
        <FilesSheet
          files={panelFiles}
          lens={lens}
          viewerThread={viewerThread}
          liveThreads={live}
          mobile={mobile}
          initialFilter={initial?.sheetFilter}
          onClose={() => setSheet(false)}
          onRevoke={(fileId, id) => setState((s) => revokeGrant(s, fileId, id))}
          onShareNew={
            lens === 'client' && state.kind === 'matched' ? () => setDialog('new') : undefined
          }
        />
      )}

      {dialog === 'thread' && upload && (
        <ShareDialog
          mode="thread"
          lens={lens}
          kind={state.kind}
          threadId={threadId}
          liveThreads={live}
          upload={upload}
          pending={pending !== null}
          initialAudience={initial?.audience}
          initialNote={draft}
          mobile={mobile}
          onCancel={close}
          onShare={(audience, note) =>
            upload.progress >= 100 ? commit(audience, note, upload) : setPending({ audience, note })
          }
        />
      )}
      {dialog === 'new' && (
        <ShareDialog
          mode="new"
          lens={lens}
          kind={state.kind}
          threadId={null}
          liveThreads={live}
          initialNote=""
          mobile={mobile}
          onCancel={() => setDialog(null)}
          onShare={(audience, note, file) => commit(audience, note, file)}
        />
      )}

      <div
        data-proto-helpers=""
        style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}
      >
        <OutlineButton
          icon={FileIcon}
          onClick={() =>
            pick(
              lens === 'client' ? 'Lead flow export.csv' : 'Discovery questions.docx',
              lens === 'client' ? '380 KB' : '64 KB'
            )
          }
        >
          Prototype: pick a sample file
        </OutlineButton>
        {state.kind === 'matched' && !live.includes(FS_LATE_JOINER) && (
          <OutlineButton icon={UserPlus} onClick={() => setState((s) => addLateExpert(s))}>
            Prototype: Sam expresses interest
          </OutlineButton>
        )}
        <OutlineButton
          icon={RotateCcw}
          onClick={() => {
            setState(initialFileState(state.kind));
            close();
            setDraft('');
            setCurrent('r1');
            setSheet(false);
            setRailOpen(false);
          }}
        >
          Reset
        </OutlineButton>
      </div>
    </div>
  );
}

function PageNotes() {
  const items = [
    [
      'Where things live',
      'The thread header holds only actions with this expert: calls, the proposal, declining. Files moved to the request panel: the “Request documents” card becomes “Files” (the brief plus recent shares), and “All files · n” opens the sheet. The tab strip holds only tabs, and the bottom panel is gone.',
    ],
    [
      'All files sheet',
      'The client sees every file, with audience badges and remove-access, and on a matched request can filter to what one expert can see (“Charles can see”). “Share with several experts” stays here. Experts see only their files, with no audience.',
    ],
    [
      'Sharing from the chat',
      'The paperclip, or a drop on the conversation, opens the share dialog at once: “{name} only” preselected on a matched request, no options on a direct request or for an expert, a note field, and a button that names the audience.',
    ],
    [
      'Threads',
      'A share posts a file card, with the note, into every thread it reaches at that moment. A track that opens later finds shared-with-all files in Files only. Try “Sam expresses interest”.',
    ],
    [
      'Mobile',
      'The panel sits behind “Request, kickoff and files” (mirroring the shipped request sheet). The header keeps Join and Book another call; the composer keeps the paperclip.',
    ],
  ];
  return (
    <section
      aria-label="Whole page notes"
      style={{
        background: c.card,
        border: `1px dashed ${c.borderStrong}`,
        borderRadius: 16,
        padding: 20,
      }}
    >
      <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600, color: c.text }}>
        Spec notes: the whole page
      </h3>
      <dl
        style={{
          margin: 0,
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 170px) minmax(0, 1fr)',
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
  const [section, setSection] = useState('page');
  const [lens, setLens] = useState('client');
  const [requestStatus, setRequestStatus] = useState('accepted');
  const [outcome, setOutcome] = useState('won');
  const [call, setCall] = useState('none');
  const [progress, setProgress] = useState('invoice');
  const [hasUpfront, setHasUpfront] = useState('yes');
  const [viewport, setViewport] = useState('desktop');
  const [fsLens, setFsLens] = useState('client');
  const [fsKind, setFsKind] = useState('matched');
  const [pgStatus, setPgStatus] = useState('accepted');
  const [pgCall, setPgCall] = useState('d1');

  const decided = requestStatus === 'accepted' || requestStatus === 'kickoff_approved';
  const narrow = {
    maxWidth: viewport === 'mobile' ? 390 : undefined,
    width: '100%',
    margin: viewport === 'mobile' ? '0 auto' : undefined,
  };
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
            {section === 'calls'
              ? 'Request page: booking, Join, nudges and the Before kickoff thread. “Now” is Tue 27 Oct, 10:00 am.'
              : 'The whole request page: calls in the header, kickoff and files in the panel, sharing from the chat. “Now” is Tue 27 Oct, 10:00 am.'}
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
            label="Prototype"
            value={section}
            onChange={setSection}
            options={[
              ['page', 'Whole page'],
              ['calls', 'Calls and kickoff states'],
            ]}
          />
          {section === 'calls' ? (
            <>
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
            </>
          ) : (
            <>
              <Segmented
                label="Lens"
                value={fsLens}
                onChange={setFsLens}
                options={[
                  ['client', 'Client'],
                  ['expert', 'Expert (Charles)'],
                ]}
              />
              <Segmented
                label="Request"
                value={fsKind}
                onChange={setFsKind}
                options={[
                  ['matched', 'Matched, 2 experts'],
                  ['direct', 'Direct, 1 expert'],
                ]}
              />
              <Segmented
                label="Stage"
                value={pgStatus}
                onChange={setPgStatus}
                options={[
                  ['proposal_submitted', 'Choosing'],
                  ['accepted', 'Accepted'],
                  ['kickoff_approved', 'Kicked off'],
                ]}
              />
              <Segmented
                label="Calls with Charles"
                value={pgCall}
                onChange={setPgCall}
                options={[
                  ['none', 'Nothing booked'],
                  ['d1', 'Tomorrow'],
                  ['window', 'Window open'],
                  ['two', 'Two booked'],
                ]}
              />
            </>
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

        {section === 'calls' ? (
          <>
            <div style={narrow}>
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
          </>
        ) : (
          <>
            <div style={narrow}>
              <RequestPageView
                key={`${fsLens}-${fsKind}`}
                lens={fsLens}
                kind={fsKind}
                viewport={viewport}
                requestStatus={pgStatus}
                call={pgCall}
              />
            </div>
            <PageNotes />
          </>
        )}
      </div>
    </div>
  );
}
