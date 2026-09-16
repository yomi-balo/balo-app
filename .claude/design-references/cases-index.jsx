/*
  Balo — Cases index + dashboard "Up next" (design reference, not production code)

  STATUS — PROPOSED, 2026-09-16. Replaces the earlier consultations-index.jsx draft. Commit to
  .claude/design-references/cases-index.jsx once approved; the Linear tickets reference it.
  Shell structure, tokens and motion come from balo-nav-explorer.jsx (ADR-1053).

  Decisions this reference encodes (agreed in chat, 2026-09-16):
    - Primary nav item lists CASES, not consultations. A consultation is a meeting inside a case,
      the way a kickoff is a meeting inside a project. Proposed label "Cases" (route /cases);
      needs an ADR-1053 amendment and a check of Bubble's customer-facing wording. The toolbar
      toggle shows the "Consultations" label on the same page for comparison.
    - No Upcoming tab. Clients rarely have more than one or two bookings: the soonest booking is
      the featured "ticket" card; a second booking shows inside its own case card.
    - Case card anatomy: title, counterparty, product tags, one "what's next" slot (same priority
      as the case page's selectCaseNudge), footer facts (call trail, held count, open action items
      for you, unread messages, opened date).
    - Left off cards: description, money (either lens), rating, people counts.
    - Expert lens: same anatomy, denser three-column grid.
    - Resolved cases: compact, collapsed by default.
    - Dashboard "Up next": every meeting type in V1 (projects are ~90% of revenue). Client view is
      company-wide and leads the client dashboard; the wallet moves beside it.

  Card states covered: booked, starting soon / live, new times suggested, resolution asked,
  nothing booked, no calls yet, resolved, closed automatically.

  Data notes for the build (all batched across the listed cases, never per card):
    - trail + held count + next booking: one meeting_contexts read over the listed case ids;
    - product tags: case_engagement_products;
    - "for you": open action items grouped by assignee_party, lens-relative;
    - unread: conversation_read_states watermark vs thread messages (a batched count may be new);
    - live reschedule proposals: rescheduleProposalsRepository.findLivePendingByMeetingIds.
  Ordering: featured = soonest booking; then other bookings, soonest first; then nothing-booked
  cases by most recent activity. NOT listOpenForCompanyAndExpert's order (its lastActivityAt is
  MAX(scheduled_start), which ranks a booking six weeks out above today's call).

  Faces: production renders users.avatarUrl. Tinted initials here are the fallback style.
  Corrections vs repo: the shipped case row note "join link in your calendar" is not true for
  clients until BAL-475; tertiary text uses slate-500 for WCAG AA.
  Motion: page enter fade + rise 240ms; resolved section reveal on toggle; live dot ping 1.8s;
  all off under prefers-reduced-motion. Copy: every user-facing string is an MJ checkpoint.
*/
import { useState, useEffect, useLayoutEffect, useRef, Fragment } from 'react';
import {
  LayoutDashboard,
  Search,
  Video,
  FolderKanban,
  MessageSquare,
  CalendarDays,
  Settings,
  SlidersHorizontal,
  User,
  Bell,
  ChevronsUpDown,
  ChevronDown,
  ArrowRight,
  ArrowUpRight,
  MoreHorizontal,
  Wallet,
  CalendarClock,
  CalendarPlus,
  CircleCheck,
  CircleSlash,
  CircleHelp,
  ListChecks,
  Lock,
  Plus,
  PanelLeft,
  Briefcase,
  Compass,
  Handshake,
  Clock,
} from 'lucide-react';

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/* ───────────────────────────── tokens ───────────────────────────── */
const T = {
  font: "Geist, Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  primary: '#4f46e5',
  primaryLight: '#eef2ff',
  primaryBorder: '#c7d2fe',
  violet: '#6d28d9',
  violetLight: '#f5f3ff',
  violetBorder: '#ddd6fe',
  gradient: 'linear-gradient(90deg,#3b82f6 0%,#8b5cf6 100%)',
  text: '#0f172a',
  text2: '#475569',
  text3: '#64748b',
  border: '#e2e8f0',
  borderStrong: '#cbd5e1',
  muted: '#f8fafc',
  canvas: '#f4f6fa',
  sk: '#eef2f7',
  green: '#047857',
  greenMid: '#10b981',
  greenLight: '#ecfdf5',
  greenPill: '#d1fae5',
  greenBorder: '#a7f3d0',
  amber: '#b45309',
  amberLight: '#fffbeb',
  amberBorder: '#fde68a',
};

const STYLE = `
@keyframes ciFadeUp { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }
@keyframes ciReveal { from { opacity: 0; transform: translateY(-4px) } to { opacity: 1; transform: none } }
@keyframes ciPing { 0% { transform: scale(.6); opacity: .9 } 80%, 100% { transform: scale(2.2); opacity: 0 } }
.ci-page { animation: ciFadeUp .24s cubic-bezier(.4,0,.2,1) both }
.ci-reveal { animation: ciReveal .18s ease both }
.ci-toast { animation: ciFadeUp .2s ease both }
.ci-live::after { content: ""; position: absolute; inset: -3px; border-radius: 999px; border: 2px solid rgba(16,185,129,.55); animation: ciPing 1.8s cubic-bezier(0,0,.2,1) infinite }
.ci-card { transition: border-color .16s ease }
.ci-card:hover { border-color: #cbd5e1 !important }
.ci-row { transition: background .14s ease }
.ci-row:hover { background: #f8fafc !important }
.ci-nav:not([aria-current]):hover { background: rgba(15,23,42,.04) !important }
.ci-press { transition: transform .12s ease, background .14s ease }
.ci-press:active { transform: scale(.97) }
.ci-cta { transition: transform .16s ease, box-shadow .16s ease }
.ci-cta:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(79,70,229,.28) }
.ci-cta:active { transform: translateY(0) scale(.98) }
.ci-root button:focus-visible, .ci-tools button:focus-visible { outline: 2px solid #6366f1 !important; outline-offset: 2px }
@media (prefers-reduced-motion: reduce) {
  .ci-page, .ci-reveal, .ci-toast { animation: none !important }
  .ci-live::after { display: none }
  * { transition: none !important }
}
`;

const plainBtn = {
  background: 'transparent',
  padding: 0,
  margin: 0,
  fontFamily: 'inherit',
  color: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
};
const ellipsis = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const clamp2 = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
};
const iconBox = {
  width: 32,
  height: 32,
  borderRadius: 8,
  color: T.text2,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};
const separator = (last) => (last ? 'none' : `inset 0 -1px 0 ${T.border}`);

/* ───────────────────────────── fixtures ─────────────────────────────
   Now is Wed 16 Sep. Marcus Lee delivers through Stratus Advisory, so the same Acme Corp cases
   appear in both workspaces, named from each side. */
const PEOPLE = {
  marcus: {
    name: 'Marcus Lee',
    first: 'Marcus',
    org: 'Stratus Advisory',
    headline: 'CPQ and Revenue Cloud specialist',
    initials: 'ML',
    tint: ['#dbeafe', '#1e40af'],
  },
  aisha: {
    name: 'Aisha Rahman',
    first: 'Aisha',
    org: null,
    initials: 'AR',
    tint: ['#fce7f3', '#9d174d'],
  },
  priya: {
    name: 'Priya Nair',
    first: 'Priya',
    org: null,
    initials: 'PN',
    tint: ['#dcfce7', '#166534'],
  },
  diego: {
    name: 'Diego Alvarez',
    first: 'Diego',
    org: null,
    initials: 'DA',
    tint: ['#ffedd5', '#9a3412'],
  },
};
const ORGS = {
  acme: { name: 'Acme Corp', initials: 'AC' },
  globex: { name: 'Globex', initials: 'GX' },
  initech: { name: 'Initech', initials: 'IN' },
  harbour: { name: 'Harbour Health', initials: 'HH' },
  northwind: { name: 'Northwind', initials: 'NW' },
};

const B_TODAY = {
  dow: 'Wed',
  dowLong: 'Wednesday',
  day: '16',
  mon: 'Sep',
  monLong: 'September',
  time: '2:30 pm',
  duration: 30,
  relative: 'Today',
};
const B_TOMORROW = {
  dow: 'Thu',
  day: '17',
  mon: 'Sep',
  time: '10:00 am',
  duration: 45,
  relative: 'Tomorrow',
};
const B_FRI = {
  dow: 'Fri',
  day: '18',
  mon: 'Sep',
  time: '1:00 pm',
  duration: 30,
  relative: 'In 2 days',
};
const B_OCT = {
  dow: 'Tue',
  day: '27',
  mon: 'Oct',
  time: '9:30 am',
  duration: 60,
  relative: 'In 6 weeks',
};

function clientFixture(second) {
  const c2base = {
    id: 'c2',
    title: 'Experience Cloud login loop',
    who: PEOPLE.aisha,
    tags: ['Experience Cloud', 'Identity'],
    opened: '14 Sep',
  };
  let c2 = {
    ...c2base,
    state: 'resolution_ask',
    trail: ['held', 'held'],
    held: 2,
    itemsForYou: 0,
    unread: 1,
    lastCall: '15 Sep',
  };
  if (second === 'booked') {
    c2 = {
      ...c2base,
      state: 'booked',
      trail: ['held', 'upcoming'],
      held: 1,
      itemsForYou: 1,
      unread: 0,
      booking: B_TOMORROW,
    };
  }
  if (second === 'proposal') {
    c2 = {
      ...c2base,
      state: 'proposal',
      trail: ['held', 'upcoming'],
      held: 1,
      itemsForYou: 1,
      unread: 2,
      booking: B_TOMORROW,
      proposalCount: 3,
    };
  }
  return {
    featured: {
      id: 'c1',
      title: 'CPQ discount schedule errors',
      who: PEOPLE.marcus,
      tags: ['CPQ', 'Revenue Cloud'],
      trail: ['held', 'upcoming'],
      held: 1,
      itemsForYou: 2,
      unread: 1,
      opened: '2 Sep',
      booking: B_TODAY,
    },
    open: [
      c2,
      {
        id: 'c3',
        title: 'Flow error on lead conversion',
        who: PEOPLE.priya,
        tags: ['Sales Cloud', 'Flow'],
        state: 'nothing',
        trail: ['held'],
        held: 1,
        itemsForYou: 1,
        unread: 0,
        lastCall: '12 Sep',
        opened: '10 Sep',
      },
      {
        id: 'c4',
        title: 'Report builder timeouts',
        who: PEOPLE.aisha,
        tags: ['CRM Analytics'],
        state: 'no_calls',
        trail: [],
        held: 0,
        itemsForYou: 0,
        unread: 0,
        opened: '11 Sep',
      },
      {
        id: 'c5',
        title: 'Sharing rules for the partner community',
        who: PEOPLE.marcus,
        tags: ['Experience Cloud', 'Security', 'Sharing'],
        state: 'nothing',
        trail: ['held', 'cancelled', 'missed', 'held'],
        held: 2,
        itemsForYou: 3,
        unread: 0,
        lastCall: '29 Aug',
        opened: '10 Aug',
      },
    ],
    resolved: [
      {
        id: 'c7',
        title: 'Omni-Channel capacity model',
        who: PEOPLE.priya,
        closed: 'resolved',
        closedOn: '28 Aug',
        held: 4,
      },
      {
        id: 'c8',
        title: 'Einstein bot handoff',
        who: PEOPLE.marcus,
        closed: 'auto',
        closedOn: '3 Aug',
        held: 1,
      },
    ],
  };
}

const EXPERT_FIXTURE = {
  featured: {
    id: 'c1',
    title: 'CPQ discount schedule errors',
    who: ORGS.acme,
    tags: ['CPQ', 'Revenue Cloud'],
    trail: ['held', 'upcoming'],
    held: 1,
    itemsForYou: 1,
    unread: 0,
    opened: '2 Sep',
    booking: B_TODAY,
  },
  open: [
    {
      id: 'x2',
      title: 'Quote template branching',
      who: ORGS.globex,
      tags: ['CPQ'],
      state: 'proposal_pending',
      trail: ['upcoming'],
      held: 0,
      itemsForYou: 0,
      unread: 1,
      booking: B_TOMORROW,
      opened: '13 Sep',
    },
    {
      id: 'x3',
      title: 'Approval matrix for renewals',
      who: ORGS.initech,
      tags: ['Sales Cloud'],
      state: 'booked',
      trail: ['held', 'missed', 'held', 'upcoming'],
      held: 2,
      itemsForYou: 2,
      unread: 0,
      booking: B_FRI,
      opened: '19 Aug',
    },
    {
      id: 'x4',
      title: 'Data migration dry run',
      who: ORGS.acme,
      tags: ['Data Cloud'],
      state: 'booked',
      trail: ['held', 'upcoming'],
      held: 1,
      itemsForYou: 0,
      unread: 0,
      booking: B_OCT,
      opened: '21 Aug',
    },
    {
      id: 'x5',
      title: 'Territory model cleanup',
      who: ORGS.harbour,
      tags: ['Sales Cloud'],
      state: 'resolution_asked_by_you',
      trail: ['held', 'held', 'held'],
      held: 3,
      itemsForYou: 0,
      unread: 0,
      lastCall: '2 Sep',
      opened: '4 Aug',
    },
    {
      id: 'x6',
      title: 'Marketing Cloud journey stuck in a loop',
      who: ORGS.northwind,
      tags: ['Marketing Cloud'],
      state: 'nothing',
      trail: ['held'],
      held: 1,
      itemsForYou: 1,
      unread: 2,
      lastCall: '1 Sep',
      opened: '28 Aug',
    },
    {
      id: 'c5',
      title: 'Sharing rules for the partner community',
      who: ORGS.acme,
      tags: ['Experience Cloud'],
      state: 'nothing',
      trail: ['held', 'cancelled', 'missed', 'held'],
      held: 2,
      itemsForYou: 0,
      unread: 0,
      lastCall: '29 Aug',
      opened: '10 Aug',
    },
  ],
  resolved: [
    {
      id: 'x7',
      title: 'Guided selling flow',
      who: ORGS.globex,
      closed: 'resolved',
      closedOn: '21 Aug',
      held: 3,
    },
    {
      id: 'c8',
      title: 'Einstein bot handoff',
      who: ORGS.acme,
      closed: 'auto',
      closedOn: '3 Aug',
      held: 1,
    },
  ],
};

function upNextFixture(lens, second) {
  if (lens === 'expert') {
    return [
      {
        id: 'm1',
        type: 'consultation',
        title: 'CPQ discount schedule errors',
        who: ORGS.acme,
        when: 'Today',
        time: '2:30 pm',
        duration: 30,
        live: true,
      },
      {
        id: 'm5',
        type: 'kickoff',
        title: 'Revenue Cloud implementation',
        who: ORGS.globex,
        when: 'Today',
        time: '4:00 pm',
        duration: 60,
      },
      {
        id: 'm6',
        type: 'consultation',
        title: 'Quote template branching',
        who: ORGS.globex,
        when: 'Tomorrow',
        time: '10:00 am',
        duration: 45,
        note: 'Waiting on their reply',
      },
      {
        id: 'm7',
        type: 'discovery',
        title: 'Partner portal build',
        who: ORGS.initech,
        when: 'Thu 17 Sep',
        time: '2:00 pm',
        duration: 45,
      },
    ];
  }
  const rows = [
    {
      id: 'm1',
      type: 'consultation',
      title: 'CPQ discount schedule errors',
      who: PEOPLE.marcus,
      when: 'Today',
      time: '2:30 pm',
      duration: 30,
      live: true,
    },
    {
      id: 'm2',
      type: 'kickoff',
      title: 'Service Cloud migration',
      who: PEOPLE.priya,
      when: 'Tomorrow',
      time: '9:00 am',
      duration: 60,
    },
    {
      id: 'm3',
      type: 'discovery',
      title: 'Field Service rollout',
      who: PEOPLE.aisha,
      when: 'Thu 17 Sep',
      time: '3:00 pm',
      duration: 45,
    },
    {
      id: 'm4',
      type: 'intro',
      title: 'Marketing Cloud audit',
      who: PEOPLE.diego,
      when: 'Fri 18 Sep',
      time: '11:00 am',
      duration: 30,
    },
  ];
  if (second === 'none') return rows;
  const consult = {
    id: 'm8',
    type: 'consultation',
    title: 'Experience Cloud login loop',
    who: PEOPLE.aisha,
    when: 'Tomorrow',
    time: '10:00 am',
    duration: 45,
    note: second === 'proposal' ? 'New times suggested' : null,
  };
  return [rows[0], rows[1], consult, rows[2]];
}

const WORKSPACES = {
  client: { name: 'Acme Corp', sub: 'Client · Member', initials: 'AC' },
  expert: { name: 'Marcus Lee', sub: 'Expert workspace', initials: 'ML' },
};

const MEETING_TYPES = {
  consultation: { label: 'Consultation', icon: Video, fg: T.primary, bg: T.primaryLight },
  kickoff: { label: 'Project kickoff', icon: Briefcase, fg: T.violet, bg: T.violetLight },
  discovery: { label: 'Discovery call', icon: Compass, fg: T.violet, bg: T.violetLight },
  intro: { label: 'Intro call', icon: Handshake, fg: T.violet, bg: T.violetLight },
};

function joinState(clock) {
  if (clock === 'live') return { text: 'Happening now', join: true };
  if (clock === 'soon') return { text: 'Starts in 9 min', join: true };
  return { text: 'In 3 hours', join: false };
}

/* ───────────────────────────── primitives ───────────────────────────── */
function Avatar({ who, size = 24, kind = 'person' }) {
  const company = kind === 'company';
  const [bg, fg] = company ? [T.primaryLight, T.primary] : who.tint || ['#e2e8f0', T.text];
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: company ? Math.round(size * 0.28) : size / 2,
        background: bg,
        color: fg,
        boxShadow: '0 0 0 2px #fff',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: Math.max(8, Math.round(size * 0.38)),
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      {who.initials}
    </span>
  );
}

function Btn({ children, variant = 'outline', size = 'md', onClick, full, style }) {
  const variants = {
    outline: { background: '#fff', border: `1px solid ${T.border}`, color: T.text },
    solid: { background: T.primary, border: `1px solid ${T.primary}`, color: '#fff' },
    amber: { background: '#fff', border: `1px solid ${T.amberBorder}`, color: T.amber },
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={variant === 'solid' ? 'ci-cta' : 'ci-press'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        fontFamily: T.font,
        fontWeight: 600,
        fontSize: size === 'sm' ? 12.5 : 13,
        lineHeight: 1.2,
        padding: size === 'sm' ? '6px 11px' : '9px 14px',
        borderRadius: 8,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        width: full ? '100%' : undefined,
        ...variants[variant],
        ...style,
      }}
    >
      {children}
    </button>
  );
}

function LinkBtn({ children, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...plainBtn,
        border: 'none',
        fontSize: 12.5,
        fontWeight: 600,
        color: T.primary,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
      }}
    >
      {children} <ArrowRight size={12} aria-hidden="true" />
    </button>
  );
}

function LiveDot() {
  return (
    <span
      aria-hidden="true"
      className="ci-live"
      style={{
        position: 'relative',
        width: 7,
        height: 7,
        borderRadius: 4,
        background: T.greenMid,
        display: 'inline-block',
        flexShrink: 0,
      }}
    />
  );
}

/* The client lens names the expert (agency second); the expert lens names the company. */
function WhoLine({ who, lens, size = 22, showHeadline = false }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, minWidth: 0 }}>
      <Avatar who={who} size={size} kind={lens === 'expert' ? 'company' : 'person'} />
      <span style={{ minWidth: 0, display: 'block' }}>
        <span style={{ display: 'block', fontSize: 13, color: T.text2, ...ellipsis }}>
          <span style={{ color: T.text, fontWeight: 500 }}>{who.name}</span>
          {who.org ? <span>, {who.org}</span> : null}
        </span>
        {showHeadline && who.headline ? (
          <span style={{ display: 'block', fontSize: 12.5, color: T.text3, ...ellipsis }}>
            {who.headline}
          </span>
        ) : null}
      </span>
    </span>
  );
}

function Tags({ tags, max }) {
  const shown = tags.slice(0, max);
  const extra = tags.length - shown.length;
  const chip = {
    fontSize: 11.5,
    fontWeight: 500,
    color: T.text2,
    background: T.muted,
    border: `1px solid ${T.border}`,
    borderRadius: 6,
    padding: '2px 7px',
    whiteSpace: 'nowrap',
  };
  return (
    <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
      {shown.map((t) => (
        <span key={t} style={chip}>
          {t}
        </span>
      ))}
      {extra > 0 ? <span style={{ ...chip, color: T.text3 }}>+{extra}</span> : null}
    </span>
  );
}

/* One mark per consultation, oldest first: filled = held, ring = booked, dashed = cancelled,
   grey = missed. The line behind them reads as the case's timeline. */
const TRAIL_WORDS = { held: 'held', upcoming: 'booked', cancelled: 'cancelled', missed: 'missed' };

function markStyle(mark) {
  const base = {
    position: 'relative',
    width: 9,
    height: 9,
    borderRadius: 5,
    boxSizing: 'border-box',
    flexShrink: 0,
  };
  if (mark === 'held') return { ...base, background: T.primary };
  if (mark === 'upcoming') return { ...base, background: '#fff', border: `2px solid ${T.primary}` };
  if (mark === 'cancelled')
    return { ...base, background: '#fff', border: `1.5px dashed ${T.text3}` };
  return { ...base, background: T.borderStrong };
}

function Trail({ marks }) {
  if (marks.length === 0) return null;
  const counts = {};
  marks.forEach((m) => {
    counts[m] = (counts[m] || 0) + 1;
  });
  const label = Object.keys(counts)
    .map((k) => `${counts[k]} ${TRAIL_WORDS[k]}`)
    .join(', ');
  return (
    <span
      role="img"
      aria-label={`Consultations: ${label}`}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}
    >
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: 4,
          right: 4,
          top: 4,
          height: 1,
          background: T.borderStrong,
        }}
      />
      {marks.slice(-6).map((m, i) => (
        <span key={`${m}-${i}`} aria-hidden="true" style={markStyle(m)} />
      ))}
    </span>
  );
}

function Facts({ c }) {
  const fact = { display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' };
  return (
    <span
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        fontSize: 12.5,
        color: T.text2,
        minWidth: 0,
      }}
    >
      {c.held > 0 ? <span style={fact}>{c.held} held</span> : null}
      {c.itemsForYou > 0 ? (
        <span style={fact}>
          <ListChecks size={13} aria-hidden="true" />
          {c.itemsForYou} for you
        </span>
      ) : null}
      {c.unread > 0 ? (
        <span style={{ ...fact, color: T.primary, fontWeight: 600 }}>
          <MessageSquare size={13} aria-hidden="true" />
          {c.unread} new
        </span>
      ) : null}
    </span>
  );
}

function CalendarLeaf({ booking }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 44,
        flexShrink: 0,
        borderRadius: 10,
        overflow: 'hidden',
        background: '#fff',
        boxShadow: `0 0 0 1px ${T.primaryBorder}, 0 3px 6px -3px rgba(79,70,229,.35)`,
        textAlign: 'center',
        display: 'block',
      }}
    >
      <span
        style={{
          display: 'block',
          background: T.primary,
          color: '#fff',
          fontSize: 10,
          fontWeight: 600,
          lineHeight: '16px',
        }}
      >
        {booking.mon}
      </span>
      <span
        style={{
          display: 'block',
          fontSize: 18,
          fontWeight: 700,
          color: T.text,
          lineHeight: '28px',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {booking.day}
      </span>
    </span>
  );
}

function EmptyLeaf({ icon: Icon }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 44,
        height: 44,
        borderRadius: 10,
        border: `1px dashed ${T.borderStrong}`,
        color: T.text3,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <Icon size={16} />
    </span>
  );
}

function MiniStub({ booking, label, note }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
      <CalendarLeaf booking={booking} />
      <span style={{ minWidth: 0, display: 'block' }}>
        {label ? (
          <span style={{ display: 'block', fontSize: 11.5, color: T.text3 }}>{label}</span>
        ) : null}
        <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, color: T.text }}>
          {booking.dow}, {booking.time}
        </span>
        <span style={{ display: 'block', fontSize: 12.5, color: T.text2 }}>
          {booking.relative}, {booking.duration} min
        </span>
        {note ? (
          <span
            style={{
              display: 'block',
              fontSize: 12.5,
              fontWeight: 500,
              color: T.amber,
              marginTop: 2,
            }}
          >
            {note}
          </span>
        ) : null}
      </span>
    </span>
  );
}

function QuietSlot({ icon, title, sub, action, onAction }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <EmptyLeaf icon={icon} />
      <span style={{ minWidth: 0, flex: 1, display: 'block' }}>
        <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, color: T.text2 }}>
          {title}
        </span>
        {sub ? (
          <span style={{ display: 'block', fontSize: 12.5, color: T.text3 }}>{sub}</span>
        ) : null}
      </span>
      {action ? (
        <Btn size="sm" onClick={onAction}>
          {action}
        </Btn>
      ) : null}
    </span>
  );
}

function StateBand({ tone, icon: Icon, children }) {
  const tones = {
    amber: { bg: T.amberLight, fg: T.amber, line: T.amberBorder },
    violet: { bg: T.violetLight, fg: T.violet, line: T.violetBorder },
  };
  const t = tones[tone];
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 16px',
        background: t.bg,
        color: t.fg,
        fontSize: 12.5,
        fontWeight: 600,
        boxShadow: `inset 0 -1px 0 ${t.line}`,
      }}
    >
      <Icon size={14} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

function PageHead({ title, desc, action }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: 16,
        marginBottom: 22,
      }}
    >
      <div>
        <h1
          style={{
            fontSize: 28,
            fontWeight: 600,
            letterSpacing: '-.025em',
            margin: 0,
            color: T.text,
            lineHeight: 1.15,
          }}
        >
          {title}
        </h1>
        {desc ? <p style={{ margin: '6px 0 0', fontSize: 14, color: T.text2 }}>{desc}</p> : null}
      </div>
      {action}
    </div>
  );
}

function SectionHead({ title, count }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '0 0 12px' }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0, color: T.text }}>{title}</h2>
      <span style={{ fontSize: 13, color: T.text3 }}>{count}</span>
    </div>
  );
}

function EmptyState({ icon: Icon, title, body, action, onAction }) {
  return (
    <div
      style={{
        background: '#fff',
        border: `1px solid ${T.border}`,
        borderRadius: 18,
        padding: '44px 24px',
        textAlign: 'center',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 48,
          height: 48,
          borderRadius: 14,
          background: T.primaryLight,
          color: T.primary,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon size={22} />
      </span>
      <div style={{ fontSize: 16, fontWeight: 600, color: T.text, marginTop: 14 }}>{title}</div>
      <p
        style={{
          fontSize: 14,
          color: T.text2,
          margin: '6px auto 0',
          maxWidth: 420,
          lineHeight: 1.55,
        }}
      >
        {body}
      </p>
      {action ? (
        <div style={{ marginTop: 18 }}>
          <Btn variant="solid" onClick={onAction}>
            {action}
          </Btn>
        </div>
      ) : null}
    </div>
  );
}

/* ───────────────────────────── featured ticket ───────────────────────────── */
/* A ticket notch: a canvas-coloured disc over the card edge, clipped to the half inside the card,
   so the card border stops at the perforation. */
function Notch({ side }) {
  const size = 18;
  const geometry = {
    top: { top: -10, left: -8, clipPath: 'inset(9px 0 0 0)' },
    bottom: { bottom: -10, left: -8, clipPath: 'inset(0 0 9px 0)' },
    left: { left: -10, top: -8, clipPath: 'inset(0 0 0 9px)' },
    right: { right: -10, top: -8, clipPath: 'inset(0 9px 0 0)' },
  }[side];
  return (
    <span
      aria-hidden="true"
      style={{
        position: 'absolute',
        width: size,
        height: size,
        borderRadius: '50%',
        background: T.canvas,
        border: `1px solid ${T.border}`,
        boxSizing: 'border-box',
        zIndex: 1,
        ...geometry,
      }}
    />
  );
}

function StatusPill({ clock }) {
  const st = joinState(clock);
  const live = st.join;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 9px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        background: live ? T.greenPill : '#fff',
        color: live ? T.green : T.text2,
        boxShadow: live ? 'none' : `inset 0 0 0 1px ${T.primaryBorder}`,
        whiteSpace: 'nowrap',
      }}
    >
      {live ? <LiveDot /> : <Clock size={12} aria-hidden="true" />}
      {st.text}
    </span>
  );
}

function FeaturedCard({ c, lens, clock, go, mobile }) {
  const st = joinState(clock);
  const live = st.join;
  const accent = live ? T.green : T.primary;
  const stubBg = live ? T.greenLight : T.primaryLight;
  const perforation = live ? T.greenBorder : T.primaryBorder;
  const joinBtn = (
    <Btn
      variant="solid"
      full={!mobile}
      onClick={() => go('join', c)}
      style={mobile ? { padding: '9px 14px' } : { marginTop: 14 }}
    >
      <LiveDot /> Join call
    </Btn>
  );
  const hint = (
    <span style={{ display: 'block', fontSize: 12, color: T.text3, marginTop: mobile ? 2 : 12 }}>
      Join opens 15 min before
    </span>
  );

  const identity = (
    <div
      style={{
        padding: mobile ? '18px 18px 16px' : '24px 26px 20px',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <button
        type="button"
        onClick={() => go('case', c)}
        style={{ ...plainBtn, border: 'none', display: 'block', width: '100%' }}
      >
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12.5,
            fontWeight: 600,
            color: accent,
          }}
        >
          <Video size={14} aria-hidden="true" /> Your next consultation
        </span>
        <span
          style={{
            ...clamp2,
            fontSize: mobile ? 19 : 24,
            fontWeight: 600,
            letterSpacing: '-.02em',
            lineHeight: 1.2,
            color: T.text,
            marginTop: 8,
          }}
        >
          {c.title}
        </span>
        <WhoLine who={c.who} lens={lens} size={mobile ? 28 : 34} showHeadline />
        <Tags tags={c.tags} max={3} />
      </button>
      <div
        style={{
          marginTop: 'auto',
          paddingTop: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <Trail marks={c.trail} />
        <Facts c={c} />
        <span style={{ marginLeft: 'auto' }}>
          <LinkBtn onClick={() => go('case', c)}>Open case</LinkBtn>
        </span>
      </div>
    </div>
  );

  if (mobile) {
    return (
      <article
        style={{
          position: 'relative',
          background: '#fff',
          border: `1px solid ${T.border}`,
          borderRadius: 18,
          boxShadow: '0 1px 2px rgba(15,23,42,.04), 0 14px 32px -18px rgba(15,23,42,.28)',
        }}
      >
        {identity}
        <div
          style={{
            position: 'relative',
            background: stubBg,
            borderTop: `2px dashed ${perforation}`,
            borderRadius: '0 0 17px 17px',
            padding: '14px 18px 16px',
          }}
        >
          <Notch side="left" />
          <Notch side="right" />
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ textAlign: 'center', minWidth: 44 }}>
              <span style={{ display: 'block', fontSize: 11.5, fontWeight: 600, color: T.text2 }}>
                {c.booking.dow}
              </span>
              <span
                style={{
                  display: 'block',
                  fontSize: 30,
                  fontWeight: 700,
                  lineHeight: 1,
                  letterSpacing: '-.03em',
                  color: T.text,
                }}
              >
                {c.booking.day}
              </span>
              <span style={{ display: 'block', fontSize: 11.5, color: T.text2 }}>
                {c.booking.mon}
              </span>
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 16, fontWeight: 600, color: T.text }}>
                {c.booking.time}
              </span>
              <span style={{ display: 'block', fontSize: 12.5, color: T.text2, marginBottom: 6 }}>
                {c.booking.duration} minutes
              </span>
              <StatusPill clock={clock} />
            </span>
          </div>
          <div style={{ marginTop: 12 }}>
            {live ? (
              <Btn variant="solid" full onClick={() => go('join', c)}>
                <LiveDot /> Join call
              </Btn>
            ) : (
              hint
            )}
          </div>
        </div>
      </article>
    );
  }

  return (
    <article
      style={{
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr) 250px',
        background: '#fff',
        border: `1px solid ${T.border}`,
        borderRadius: 18,
        boxShadow: '0 1px 2px rgba(15,23,42,.04), 0 18px 40px -24px rgba(15,23,42,.30)',
      }}
    >
      {identity}
      <div
        style={{
          position: 'relative',
          background: stubBg,
          borderLeft: `2px dashed ${perforation}`,
          borderRadius: '0 17px 17px 0',
          padding: '22px 24px 22px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
        }}
      >
        <Notch side="top" />
        <Notch side="bottom" />
        <span style={{ fontSize: 13, fontWeight: 600, color: T.text2 }}>{c.booking.dowLong}</span>
        <span
          style={{
            fontSize: 50,
            fontWeight: 700,
            lineHeight: 1,
            letterSpacing: '-.04em',
            color: T.text,
            fontVariantNumeric: 'tabular-nums',
            margin: '4px 0 2px',
          }}
        >
          {c.booking.day}
        </span>
        <span style={{ fontSize: 13, color: T.text2 }}>{c.booking.monLong}</span>
        <span
          aria-hidden="true"
          style={{
            alignSelf: 'stretch',
            height: 1,
            background: perforation,
            margin: '14px 0 12px',
          }}
        />
        <span style={{ fontSize: 19, fontWeight: 600, color: T.text, letterSpacing: '-.01em' }}>
          {c.booking.time}
        </span>
        <span style={{ fontSize: 12.5, color: T.text2, marginBottom: 10 }}>
          {c.booking.duration} minutes
        </span>
        <StatusPill clock={clock} />
        {live ? joinBtn : hint}
      </div>
    </article>
  );
}

/* ───────────────────────────── case cards ───────────────────────────── */
function bandFor(c, lens) {
  if (lens !== 'client') return null;
  if (c.state === 'proposal')
    return {
      tone: 'amber',
      icon: CalendarClock,
      text: `${c.who.first} suggested ${c.proposalCount} new times`,
    };
  if (c.state === 'resolution_ask')
    return { tone: 'violet', icon: CircleHelp, text: `${c.who.first} asked if this is sorted` };
  return null;
}

function NextSlot({ c, lens, go }) {
  switch (c.state) {
    case 'booked':
      return <MiniStub booking={c.booking} />;
    case 'proposal':
      return (
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <MiniStub booking={c.booking} label="Booked for now" />
          <Btn size="sm" variant="amber" onClick={() => go('case', c)}>
            Choose a time
          </Btn>
        </span>
      );
    case 'proposal_pending':
      return <MiniStub booking={c.booking} note="You suggested new times" />;
    case 'resolution_ask':
      return (
        <QuietSlot
          icon={CalendarPlus}
          title="Nothing booked"
          sub={`Last call ${c.lastCall}`}
          action="Review"
          onAction={() => go('case', c)}
        />
      );
    case 'resolution_asked_by_you':
      return (
        <QuietSlot
          icon={CircleHelp}
          title="You asked if this is sorted"
          sub={`Waiting on ${c.who.name}`}
        />
      );
    case 'no_calls':
      return (
        <QuietSlot
          icon={CalendarPlus}
          title="No consultation booked"
          sub="Pick a time to get started"
          action={lens === 'client' ? 'Book a time' : null}
          onAction={() => go('book-case', c)}
        />
      );
    default:
      return (
        <QuietSlot
          icon={CalendarPlus}
          title="Nothing booked"
          sub={`Last call ${c.lastCall}`}
          action={lens === 'client' ? 'Book another' : null}
          onAction={() => go('book-case', c)}
        />
      );
  }
}

function CaseCard({ c, lens, go, dense }) {
  const band = bandFor(c, lens);
  const x = dense ? 16 : 18;
  return (
    <article
      className="ci-card"
      style={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        background: '#fff',
        border: `1px solid ${T.border}`,
        borderRadius: 16,
        overflow: 'hidden',
        boxShadow: '0 1px 2px rgba(15,23,42,.04)',
      }}
    >
      {band ? (
        <StateBand tone={band.tone} icon={band.icon}>
          {band.text}
        </StateBand>
      ) : null}
      <button
        type="button"
        onClick={() => go('case', c)}
        style={{
          ...plainBtn,
          border: 'none',
          display: 'block',
          padding: `${dense ? 14 : 16}px ${x}px 12px`,
        }}
      >
        <span
          style={{
            ...clamp2,
            fontSize: dense ? 14.5 : 16,
            fontWeight: 600,
            letterSpacing: '-.01em',
            lineHeight: 1.35,
            color: T.text,
          }}
        >
          {c.title}
        </span>
        <WhoLine who={c.who} lens={lens} size={dense ? 20 : 24} />
        <Tags tags={c.tags} max={dense ? 1 : 2} />
      </button>
      <div
        style={{
          margin: `0 ${x}px`,
          padding: '12px 0 14px',
          boxShadow: `inset 0 1px 0 ${T.border}`,
        }}
      >
        <NextSlot c={c} lens={lens} go={go} />
      </div>
      <div
        style={{
          marginTop: 'auto',
          padding: `10px ${x}px 12px`,
          background: T.muted,
          boxShadow: `inset 0 1px 0 ${T.border}`,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          minHeight: 20,
        }}
      >
        <Trail marks={c.trail} />
        <Facts c={c} />
        {dense ? null : (
          <span style={{ marginLeft: 'auto', fontSize: 12, color: T.text3, whiteSpace: 'nowrap' }}>
            Opened {c.opened}
          </span>
        )}
      </div>
    </article>
  );
}

function ResolvedSection({ items, lens, mobile, open, setOpen, go }) {
  return (
    <section style={{ marginTop: 28 }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        style={{
          ...plainBtn,
          border: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 15,
          fontWeight: 600,
          color: T.text,
        }}
      >
        <ChevronDown
          size={16}
          aria-hidden="true"
          style={{ transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform .18s ease' }}
        />
        Resolved
        <span style={{ fontSize: 13, fontWeight: 500, color: T.text3 }}>{items.length}</span>
      </button>
      {open ? (
        <div
          className="ci-reveal"
          style={{
            marginTop: 12,
            background: '#fff',
            border: `1px solid ${T.border}`,
            borderRadius: 14,
            overflow: 'hidden',
          }}
        >
          {items.map((c, i) => {
            const auto = c.closed === 'auto';
            const Icon = auto ? CircleSlash : CircleCheck;
            return (
              <div
                key={c.id}
                className="ci-row"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: mobile ? '12px 14px' : '12px 18px',
                  boxShadow: separator(i === items.length - 1),
                }}
              >
                <button
                  type="button"
                  onClick={() => go('case', c)}
                  style={{
                    ...plainBtn,
                    border: 'none',
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                  }}
                >
                  <Icon
                    size={18}
                    color={auto ? T.text3 : T.green}
                    aria-hidden="true"
                    style={{ flexShrink: 0 }}
                  />
                  <span style={{ minWidth: 0, flex: 1, display: 'block' }}>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 14,
                        fontWeight: 600,
                        color: T.text,
                        ...ellipsis,
                      }}
                    >
                      {c.title}
                    </span>
                    <span style={{ display: 'block', fontSize: 12.5, color: T.text2, ...ellipsis }}>
                      {c.who.name}
                      {c.who.org ? `, ${c.who.org}` : ''}
                    </span>
                    {mobile ? (
                      <span style={{ display: 'block', fontSize: 12, color: T.text3 }}>
                        {auto
                          ? `Closed automatically on ${c.closedOn}`
                          : `Resolved on ${c.closedOn}`}
                        , {c.held} held
                      </span>
                    ) : null}
                  </span>
                  {mobile ? null : (
                    <span style={{ textAlign: 'right', display: 'block', flexShrink: 0 }}>
                      <span style={{ display: 'block', fontSize: 12.5, color: T.text2 }}>
                        {auto
                          ? `Closed automatically on ${c.closedOn}`
                          : `Resolved on ${c.closedOn}`}
                      </span>
                      <span style={{ display: 'block', fontSize: 12, color: T.text3 }}>
                        {c.held} held
                      </span>
                    </span>
                  )}
                </button>
                {lens === 'client' ? (
                  <Btn size="sm" onClick={() => go('book')}>
                    Book again
                  </Btn>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

/* ───────────────────────────── /cases ───────────────────────────── */
function emptyFor(lens, data, go) {
  if (lens === 'expert' && data === 'setupIncomplete') {
    return (
      <EmptyState
        icon={SlidersHorizontal}
        title="Finish setup to get booked"
        body="Clients can book time with you once your expert setup is complete."
        action="Continue setup"
        onAction={() => go('setup')}
      />
    );
  }
  if (lens === 'expert') {
    return (
      <EmptyState
        icon={FolderKanban}
        title="No cases yet"
        body="When a client books time with you, their case shows up here with every call, message and file."
      />
    );
  }
  return (
    <EmptyState
      icon={FolderKanban}
      title="No cases yet"
      body="Book a consultation with an expert and your case shows up here, with every call, message and file in one place."
      action="Find an expert"
      onAction={() => go('book')}
    />
  );
}

function CasesPage({
  lens,
  data,
  clock,
  second,
  navLabel,
  mobile,
  go,
  resolvedOpen,
  setResolvedOpen,
}) {
  const noAccess = lens === 'client' && data === 'noAccess';
  const f = lens === 'client' ? clientFixture(second) : EXPERT_FIXTURE;
  const desc =
    lens === 'client'
      ? 'Everything Acme Corp has booked with experts.'
      : 'Everything clients have booked with you.';
  const showBook = lens === 'client' && !noAccess;
  const dense = lens === 'expert' && !mobile;

  let content;
  if (noAccess) {
    content = (
      <EmptyState
        icon={Lock}
        title="You can't view Acme Corp's cases"
        body="Your role in this company doesn't include cases. An owner or admin can change your role in Settings."
      />
    );
  } else if (data !== 'typical') {
    content = emptyFor(lens, data, go);
  } else {
    let columns = 'repeat(2, minmax(0,1fr))';
    if (mobile) columns = '1fr';
    if (dense) columns = 'repeat(3, minmax(0,1fr))';
    content = (
      <Fragment>
        <SectionHead title="Open" count={f.open.length + 1} />
        <FeaturedCard c={f.featured} lens={lens} clock={clock} go={go} mobile={mobile} />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: columns,
            gap: mobile ? 12 : 16,
            marginTop: mobile ? 12 : 16,
            alignItems: 'stretch',
          }}
        >
          {f.open.map((c) => (
            <CaseCard key={c.id} c={c} lens={lens} go={go} dense={dense} />
          ))}
        </div>
        <ResolvedSection
          items={f.resolved}
          lens={lens}
          mobile={mobile}
          open={resolvedOpen}
          setOpen={setResolvedOpen}
          go={go}
        />
      </Fragment>
    );
  }

  return (
    <div style={{ padding: mobile ? '14px 16px 28px' : 0 }}>
      {mobile ? (
        <p style={{ margin: '0 0 16px', fontSize: 13.5, color: T.text2 }}>{desc}</p>
      ) : (
        <PageHead
          title={navLabel}
          desc={desc}
          action={
            showBook ? (
              <Btn variant="solid" onClick={() => go('book')}>
                <Plus size={14} aria-hidden="true" /> Book a consultation
              </Btn>
            ) : null
          }
        />
      )}
      {content}
    </div>
  );
}

/* ───────────────────────────── dashboard: Up next ───────────────────────────── */
function UpNextRow({ m, lens, clock, go, last, mobile }) {
  const type = MEETING_TYPES[m.type];
  const Icon = type.icon;
  const st = m.live ? joinState(clock) : null;
  const featured = Boolean(st && st.join);
  const dated = m.when !== 'Today' && m.when !== 'Tomorrow';
  const target = m.type === 'consultation' ? 'case' : 'project-meeting';
  return (
    <div
      className={featured ? undefined : 'ci-row'}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: featured ? '12px 12px' : '12px 4px',
        margin: featured ? '0 -4px 6px' : 0,
        borderRadius: featured ? 12 : 0,
        background: featured ? T.greenLight : 'transparent',
        boxShadow: featured ? `inset 0 0 0 1px ${T.greenBorder}` : separator(last),
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          background: type.bg,
          color: type.fg,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Icon size={17} />
      </span>
      <button
        type="button"
        onClick={() => go(target, m)}
        style={{ ...plainBtn, border: 'none', flex: 1, minWidth: 0, display: 'block' }}
      >
        <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: type.fg }}>
          {type.label}
        </span>
        <span
          style={{ display: 'block', fontSize: 14, fontWeight: 600, color: T.text, ...ellipsis }}
        >
          {m.title}
        </span>
        <span style={{ display: 'block', fontSize: 12.5, color: T.text2, ...ellipsis }}>
          {m.who.name}
          {m.who.org && !mobile ? `, ${m.who.org}` : ''}
        </span>
      </button>
      <span style={{ textAlign: 'right', display: 'block', flexShrink: 0 }}>
        <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: T.text }}>
          {dated ? m.when : `${m.when}, ${m.time}`}
        </span>
        <span style={{ display: 'block', fontSize: 12, color: T.text3 }}>
          {dated ? `${m.time}, ${m.duration} min` : `${m.duration} min`}
        </span>
        {st ? (
          <span
            style={{
              display: 'block',
              fontSize: 12,
              fontWeight: 600,
              color: st.join ? T.green : T.text2,
            }}
          >
            {st.text}
          </span>
        ) : null}
        {m.note ? (
          <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: T.amber }}>
            {m.note}
          </span>
        ) : null}
      </span>
      {featured ? (
        <Btn size="sm" variant="solid" onClick={() => go('join', m)}>
          <LiveDot /> Join
        </Btn>
      ) : null}
    </div>
  );
}

function UpNextCard({ rows, lens, clock, go, mobile, navLabel }) {
  return (
    <section
      style={{
        background: '#fff',
        border: `1px solid ${T.border}`,
        borderRadius: 18,
        padding: '18px 18px 6px',
        boxShadow: '0 1px 2px rgba(15,23,42,.04), 0 14px 32px -24px rgba(15,23,42,.28)',
      }}
    >
      <h2
        style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-.01em', margin: 0, color: T.text }}
      >
        Up next
      </h2>
      <p style={{ margin: '2px 0 12px', fontSize: 13, color: T.text2 }}>
        {lens === 'client'
          ? 'Meetings across Acme Corp’s cases and projects'
          : 'Your meetings across cases and projects'}
      </p>
      {rows.length === 0 ? (
        <div style={{ padding: '10px 0 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <EmptyLeaf icon={CalendarPlus} />
          <span style={{ flex: 1 }}>
            <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: T.text }}>
              Nothing booked
            </span>
            <span style={{ display: 'block', fontSize: 13, color: T.text2 }}>
              {lens === 'client'
                ? 'Find an expert and pick a time.'
                : 'New bookings show up here and in Calendar.'}
            </span>
          </span>
          {lens === 'client' ? (
            <Btn size="sm" variant="solid" onClick={() => go('book')}>
              Find an expert
            </Btn>
          ) : null}
        </div>
      ) : (
        rows.map((m, i) => (
          <UpNextRow
            key={m.id}
            m={m}
            lens={lens}
            clock={clock}
            go={go}
            last={i === rows.length - 1}
            mobile={mobile}
          />
        ))
      )}
      <div
        style={{
          display: 'flex',
          gap: 18,
          padding: '12px 0 10px',
          boxShadow: `inset 0 1px 0 ${T.border}`,
          marginTop: 6,
        }}
      >
        {lens === 'client' ? (
          <Fragment>
            <LinkBtn onClick={() => go('cases-page')}>{navLabel}</LinkBtn>
            <LinkBtn onClick={() => go('projects')}>Projects</LinkBtn>
          </Fragment>
        ) : (
          <LinkBtn onClick={() => go('calendar')}>Open calendar</LinkBtn>
        )}
      </div>
    </section>
  );
}

function ShippedSlot({ label, height, flush }) {
  return (
    <div
      style={{
        height,
        borderRadius: 16,
        border: `1px dashed ${T.borderStrong}`,
        background: 'rgba(255,255,255,.55)',
        marginBottom: flush ? 0 : 16,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 12,
        textAlign: 'center',
        fontSize: 12,
        color: T.text3,
      }}
    >
      {label}
    </div>
  );
}

/* Replica of the shipped GhostConsultationsCard, copy verbatim. Right only while setup is incomplete. */
function GhostConsultationsCard() {
  return (
    <section
      style={{
        position: 'relative',
        overflow: 'hidden',
        border: `1px solid ${T.border}`,
        borderRadius: 16,
        background: '#fff',
        minHeight: 250,
      }}
    >
      <div style={{ padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 18 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: T.text }}>
            Upcoming Consultations
          </span>
          <span style={{ fontSize: 12, color: T.text3 }}>Today</span>
        </div>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              opacity: 0.35,
              marginBottom: 16,
            }}
          >
            <div style={{ width: 56, height: 36, borderRadius: 6, background: T.sk }} />
            <div style={{ width: 3, height: 36, borderRadius: 2, background: T.primary }} />
            <div style={{ flex: 1 }}>
              <div style={{ width: 130, height: 12, borderRadius: 4, background: T.sk }} />
              <div
                style={{ width: 90, height: 10, borderRadius: 4, background: T.sk, marginTop: 7 }}
              />
            </div>
          </div>
        ))}
      </div>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(255,255,255,.74)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          padding: 16,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            background: T.primaryLight,
            color: T.primary,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Video size={20} />
        </span>
        <div style={{ fontSize: 14, fontWeight: 600, color: T.text, marginTop: 10 }}>
          Complete setup to receive bookings
        </div>
        <div style={{ fontSize: 12.5, color: T.text2, marginTop: 3 }}>
          Your upcoming sessions will appear here
        </div>
      </div>
    </section>
  );
}

function DashboardPage({ lens, data, clock, second, navLabel, mobile, go }) {
  const noAccess = lens === 'client' && data === 'noAccess';
  const setupIncomplete = lens === 'expert' && data === 'setupIncomplete';
  const rows = data === 'typical' ? upNextFixture(lens, second) : [];
  let card = (
    <UpNextCard rows={rows} lens={lens} clock={clock} go={go} mobile={mobile} navLabel={navLabel} />
  );
  if (setupIncomplete) card = <GhostConsultationsCard />;
  if (noAccess) card = null;
  const wide = mobile ? '1fr' : 'minmax(0,2fr) minmax(0,1fr)';

  if (lens === 'client') {
    return (
      <div style={{ padding: mobile ? 16 : 0 }}>
        {mobile ? null : (
          <PageHead title="Dashboard" desc="Welcome back. Here is an overview of your activity." />
        )}
        <div style={{ display: 'grid', gridTemplateColumns: wide, gap: 16, alignItems: 'start' }}>
          {card}
          <div>
            <ShippedSlot
              label={
                card
                  ? 'Wallet card (shipped, BAL-402), moved beside the new card'
                  : 'Wallet card (shipped, BAL-402)'
              }
              height={mobile ? 96 : 150}
            />
            <ShippedSlot label="Promo code link (shipped)" height={56} flush />
          </div>
        </div>
        <div style={{ marginTop: 16 }}>
          <ShippedSlot label="Placeholder metric cards (unchanged)" height={96} flush />
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: mobile ? 16 : 0 }}>
      {mobile ? null : (
        <PageHead
          title="Welcome back, Marcus"
          desc="Here's what's happening with your expert account."
        />
      )}
      <ShippedSlot
        label={
          setupIncomplete ? 'Getting started checklist (shipped)' : 'Setup complete card (shipped)'
        }
        height={setupIncomplete ? 120 : 60}
      />
      <div style={{ display: 'grid', gridTemplateColumns: wide, gap: 16, alignItems: 'start' }}>
        {card}
        <ShippedSlot label="Clients card (shipped placeholder)" height={mobile ? 90 : 250} flush />
      </div>
      <div style={{ marginTop: 16 }}>
        <ShippedSlot label="Metric cards (shipped placeholders)" height={90} flush />
      </div>
    </div>
  );
}

/* ───────────────────────────── shell (simplified from balo-nav-explorer.jsx) ───────────────────────────── */
function navFor(lens, navLabel) {
  const cases = {
    key: 'cases',
    label: navLabel,
    short: navLabel === 'Cases' ? 'Cases' : 'Consults',
    icon: Video,
  };
  if (lens === 'client') {
    return {
      primary: [
        { key: 'dashboard', label: 'Dashboard', short: 'Home', icon: LayoutDashboard },
        { key: 'experts', label: 'Find experts', short: 'Experts', icon: Search, jump: true },
        cases,
        { key: 'projects', label: 'Projects', icon: FolderKanban },
        { key: 'messages', label: 'Messages', short: 'Messages', icon: MessageSquare },
      ],
      secondary: [
        { key: 'settings', label: 'Settings', icon: Settings },
        { key: 'account', label: 'Account', icon: User },
      ],
      tabs: ['dashboard', 'experts', 'cases', 'messages'],
    };
  }
  return {
    primary: [
      { key: 'dashboard', label: 'Dashboard', short: 'Home', icon: LayoutDashboard },
      cases,
      { key: 'projects', label: 'Projects', icon: FolderKanban },
      { key: 'calendar', label: 'Calendar', short: 'Calendar', icon: CalendarDays },
      { key: 'messages', label: 'Messages', short: 'Messages', icon: MessageSquare },
    ],
    secondary: [
      { key: 'expertSettings', label: 'Expert Settings', icon: SlidersHorizontal, setup: true },
      { key: 'account', label: 'Account', icon: User },
    ],
    tabs: ['dashboard', 'cases', 'calendar', 'messages'],
  };
}

function Logo() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div
        style={{
          width: 24,
          height: 24,
          borderRadius: 7,
          backgroundImage: T.gradient,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          fontWeight: 800,
          fontSize: 14,
        }}
      >
        b
      </div>
      <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-.02em', color: T.text }}>
        Balo
      </span>
    </div>
  );
}

function NavItem({ item, active, onClick, setupLabel }) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      className="ci-nav"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      style={{
        ...plainBtn,
        border: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        padding: '8px 10px',
        borderRadius: 8,
        background: active ? T.primaryLight : 'transparent',
        color: active ? T.primary : T.text2,
        fontSize: 13,
        fontWeight: active ? 600 : 500,
      }}
    >
      <Icon size={16} aria-hidden="true" />
      <span style={{ flex: 1 }}>{item.label}</span>
      {item.jump ? <ArrowUpRight size={12} aria-hidden="true" /> : null}
      {setupLabel ? (
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 700,
            padding: '1px 7px',
            borderRadius: 10,
            background: T.primaryLight,
            color: T.primary,
            border: `1px solid ${T.primaryBorder}`,
          }}
        >
          {setupLabel}
        </span>
      ) : null}
    </button>
  );
}

function TopBar({ crumb, lens }) {
  return (
    <header
      style={{
        height: 56,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 16px',
        background: '#fff',
        boxShadow: `inset 0 -1px 0 ${T.border}`,
      }}
    >
      <span style={iconBox}>
        <PanelLeft size={16} aria-hidden="true" />
      </span>
      <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{crumb}</span>
      <span style={{ flex: 1 }} />
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          height: 32,
          width: 220,
          padding: '0 10px',
          borderRadius: 8,
          border: `1px solid ${T.border}`,
          background: T.muted,
          color: T.text3,
          fontSize: 12.5,
        }}
      >
        <Search size={13} aria-hidden="true" /> Search
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 10.5,
            fontFamily: T.mono,
            border: `1px solid ${T.border}`,
            borderRadius: 4,
            padding: '1px 5px',
            background: '#fff',
          }}
        >
          ⌘K
        </span>
      </span>
      {lens === 'client' ? (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            height: 32,
            padding: '0 10px',
            borderRadius: 8,
            border: `1px solid ${T.border}`,
            fontSize: 12.5,
            fontWeight: 600,
            color: T.text,
          }}
        >
          <Wallet size={13} color={T.text2} aria-hidden="true" /> A$420.00
          <span style={{ color: T.primary }}>Top up</span>
        </span>
      ) : null}
      <span style={iconBox}>
        <Bell size={16} aria-hidden="true" />
      </span>
    </header>
  );
}

function DesktopShell({ lens, page, data, navLabel, onNav, children }) {
  const ws = WORKSPACES[lens];
  const nav = navFor(lens, navLabel);
  return (
    <div
      className="ci-root"
      style={{
        display: 'flex',
        width: 1280,
        height: 860,
        background: '#fff',
        fontFamily: T.font,
        color: T.text,
      }}
    >
      <aside
        style={{
          width: 240,
          flexShrink: 0,
          background: T.muted,
          boxShadow: `inset -1px 0 0 ${T.border}`,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ padding: '14px 12px 12px', boxShadow: `inset 0 -1px 0 ${T.border}` }}>
          <Logo />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              marginTop: 10,
              padding: '6px 8px',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                background: lens === 'expert' ? T.gradient : T.primaryLight,
                color: lens === 'expert' ? '#fff' : T.primary,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {ws.initials}
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: T.text }}>{ws.name}</div>
              <div style={{ fontSize: 11, color: T.text3 }}>{ws.sub}</div>
            </div>
            <ChevronsUpDown size={14} color={T.text3} aria-hidden="true" />
          </div>
        </div>
        <nav
          aria-label="Primary"
          style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 2 }}
        >
          {nav.primary.map((it) => (
            <NavItem
              key={it.key}
              item={it}
              active={page === it.key}
              onClick={() => onNav(it.key)}
            />
          ))}
        </nav>
        <div style={{ flex: 1 }} />
        <div
          style={{
            padding: 8,
            boxShadow: `inset 0 1px 0 ${T.border}`,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {nav.secondary.map((it) => (
            <NavItem
              key={it.key}
              item={it}
              active={false}
              setupLabel={it.setup && data === 'setupIncomplete' ? '4/6' : null}
              onClick={() => onNav(it.key)}
            />
          ))}
        </div>
      </aside>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <TopBar crumb={page === 'dashboard' ? 'Dashboard' : navLabel} lens={lens} />
        <main
          style={{ flex: 1, overflow: 'auto', padding: '28px 32px 36px', background: T.canvas }}
        >
          <div key={`${page}-${lens}`} className="ci-page" style={{ maxWidth: 980 }}>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

function MobileShell({ lens, page, data, navLabel, onNav, onBook, children }) {
  const nav = navFor(lens, navLabel);
  const byKey = {};
  nav.primary.forEach((it) => {
    byKey[it.key] = it;
  });
  const showBook = page === 'cases' && lens === 'client' && data !== 'noAccess';
  const tabs = [
    ...nav.tabs.map((k) => byKey[k]),
    { key: 'more', short: 'More', icon: MoreHorizontal },
  ];
  return (
    <div
      className="ci-root"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: '#fff',
        fontFamily: T.font,
        color: T.text,
      }}
    >
      <header
        style={{
          height: 52,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 10px 0 16px',
          boxShadow: `inset 0 -1px 0 ${T.border}`,
        }}
      >
        <span style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-.015em', flex: 1 }}>
          {page === 'dashboard' ? 'Dashboard' : navLabel}
        </span>
        {showBook ? (
          <Btn size="sm" variant="solid" onClick={onBook}>
            <Plus size={13} aria-hidden="true" /> Book
          </Btn>
        ) : null}
        <span style={iconBox}>
          <Bell size={18} aria-hidden="true" />
        </span>
      </header>
      <div style={{ flex: 1, overflow: 'auto', background: T.canvas }}>
        <div key={`${page}-${lens}`} className="ci-page">
          {children}
        </div>
      </div>
      <nav
        aria-label="Primary"
        style={{
          height: 74,
          flexShrink: 0,
          display: 'grid',
          gridTemplateColumns: 'repeat(5, 1fr)',
          paddingTop: 6,
          paddingBottom: 14,
          background: '#fff',
          boxShadow: `inset 0 1px 0 ${T.border}`,
        }}
      >
        {tabs.map((t) => {
          const Icon = t.icon;
          const on = t.key === page;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => onNav(t.key)}
              aria-current={on ? 'page' : undefined}
              style={{
                ...plainBtn,
                border: 'none',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 3,
                color: on ? T.primary : T.text3,
              }}
            >
              <Icon size={21} strokeWidth={on ? 2.2 : 1.8} aria-hidden="true" />
              <span style={{ fontSize: 10.5, fontWeight: on ? 600 : 500 }}>{t.short}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

/* ───────────────────────────── frames ───────────────────────────── */
function ScaledFrame({ width, height, center, children }) {
  const ref = useRef(null);
  const [scale, setScale] = useState(1);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      if (el.clientWidth) setScale(Math.min(1, el.clientWidth / width));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);
  return (
    <div ref={ref} style={{ width: '100%' }}>
      <div
        style={{
          height: Math.round(height * scale),
          position: 'relative',
          width: center ? Math.round(width * scale) : '100%',
          margin: center ? '0 auto' : 0,
        }}
      >
        <div
          style={{
            width,
            height,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
            position: 'absolute',
            top: 0,
            left: 0,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function PhoneFrame({ children }) {
  return (
    <div
      style={{
        width: 410,
        height: 860,
        borderRadius: 46,
        background: '#0f172a',
        padding: 10,
        boxShadow: '0 30px 80px rgba(15,23,42,.35)',
      }}
    >
      <div
        style={{
          width: 390,
          height: 840,
          borderRadius: 38,
          overflow: 'hidden',
          background: '#fff',
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            height: 44,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 26px',
            fontSize: 13,
            fontWeight: 600,
            color: T.text,
            fontFamily: T.font,
          }}
        >
          <span>2:21</span>
          <span
            aria-hidden="true"
            style={{ width: 24, height: 11, borderRadius: 3, border: `1.5px solid ${T.text}` }}
          />
        </div>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function Toast({ msg }) {
  return (
    <div
      role="status"
      className="ci-toast"
      style={{
        position: 'absolute',
        left: '50%',
        bottom: 22,
        transform: 'translateX(-50%)',
        background: '#0f172a',
        color: '#fff',
        fontSize: 12.5,
        fontWeight: 500,
        padding: '9px 14px',
        borderRadius: 10,
        boxShadow: '0 10px 30px rgba(15,23,42,.3)',
        zIndex: 50,
        whiteSpace: 'nowrap',
        fontFamily: T.font,
      }}
    >
      {msg}
    </div>
  );
}

/* ───────────────────────────── explorer toolbar ───────────────────────────── */
function Seg({ label, value, onChange, options }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ fontSize: 11.5, color: '#94a3b8', fontWeight: 500 }}>{label}</div>
      <div
        role="radiogroup"
        aria-label={label}
        style={{
          display: 'inline-flex',
          background: '#1e293b',
          borderRadius: 7,
          padding: 2,
          gap: 2,
        }}
      >
        {options.map((o) => {
          const on = value === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(o.value)}
              style={{
                ...plainBtn,
                border: 'none',
                fontSize: 11.5,
                fontWeight: 600,
                padding: '4px 9px',
                borderRadius: 5,
                background: on ? '#f8fafc' : 'transparent',
                color: on ? '#0f172a' : '#cbd5e1',
                whiteSpace: 'nowrap',
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function noteFor(s) {
  if (s.page === 'dashboard') {
    if (s.lens === 'expert' && s.data === 'setupIncomplete') {
      return 'Setup incomplete: the shipped ghost card stays, and only in this state. Today it shows for every expert, including ones with bookings.';
    }
    if (s.lens === 'client' && s.data === 'noAccess') {
      return 'Up next lists only meetings this member can open. With no access to the company’s cases or projects, the card is left out.';
    }
    if (s.data === 'empty') return 'Nothing booked: one line and a next step, no ghost rows.';
    const who =
      s.lens === 'client'
        ? 'Company-wide, and it now leads the client dashboard; the wallet moves beside it.'
        : 'The expert side can reuse the Calendar read with a short window.';
    return `Up next covers every meeting type in V1: consultations in indigo; project kickoffs, discovery calls and intro calls in violet. ${who} Join appears inside the 15-minute window.`;
  }
  if (s.lens === 'client' && s.data === 'noAccess') {
    return 'No access: the read check would refuse every case for this member, so the page explains instead of listing, and Book is hidden.';
  }
  if (s.data === 'setupIncomplete') return 'Setup incomplete: the only state that mentions setup.';
  if (s.data === 'empty')
    return 'No cases yet: booking is what opens a case, so the empty state points at booking.';
  const parts = [];
  if (s.clock === 'later') parts.push('Three hours out, the ticket says when Join opens.');
  else if (s.clock === 'live')
    parts.push('The call is under way, so Join stays for anyone still to arrive.');
  else parts.push('Inside the 15-minute window, the ticket turns green and Join appears.');
  if (s.lens === 'client') {
    if (s.second === 'none')
      parts.push(
        'The usual client: one booking, featured as the ticket. The violet band is the expert asking if a case is sorted.'
      );
    else if (s.second === 'booked')
      parts.push('A second booking shows inside its own card as a calendar leaf.');
    else
      parts.push(
        'New times suggested: amber band, the current booking still stands, and Choose a time opens the case.'
      );
  } else {
    parts.push(
      'Expert cards are denser: three columns, one tag, no opened date. The next slot shows the expert’s side.'
    );
  }
  parts.push(
    'Order: the ticket, then other bookings soonest first, then nothing-booked cases by recent activity. Dots are the case’s calls: filled held, ring booked, dashed cancelled, grey missed. No money anywhere.'
  );
  if (s.navLabel === 'Consultations')
    parts.push(
      'Label comparison: this page lists cases, so “Consultations” names the wrong thing.'
    );
  return parts.join(' ');
}

/* ───────────────────────────── root ───────────────────────────── */
export default function CasesIndexPrototype() {
  const [lens, setLens] = useState('client');
  const [viewport, setViewport] = useState('desktop');
  const [page, setPage] = useState('cases');
  const [data, setData] = useState('typical');
  const [clock, setClock] = useState('soon');
  const [second, setSecond] = useState('none');
  const [navLabel, setNavLabel] = useState('Cases');
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    if (lens === 'client' && data === 'setupIncomplete') setData('typical');
    if (lens === 'expert' && data === 'noAccess') setData('typical');
  }, [lens, data]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const mobile = viewport === 'mobile';

  const go = (kind, item) => {
    if (kind === 'cases-page') {
      setPage('cases');
      return;
    }
    const messages = {
      case: `Opens /cases/${item ? item.id : ''}`,
      join: 'Opens the call',
      book: "Opens Find experts. Booking starts on an expert's profile.",
      'book-case': 'Opens the case with its time picker',
      setup: 'Opens Expert Settings',
      projects: 'Opens Projects',
      calendar: 'Opens Calendar',
      'project-meeting': 'Opens the project this meeting belongs to',
    };
    if (messages[kind]) setToast(messages[kind]);
  };

  const onNav = (key) => {
    if (key === 'dashboard' || key === 'cases') {
      setPage(key);
      return;
    }
    if (key === 'experts') {
      go('book');
      return;
    }
    setToast('Outside this prototype. See balo-nav-explorer.jsx.');
  };

  const shared = { lens, data, clock, second, navLabel, mobile, go };
  const body =
    page === 'dashboard' ? (
      <DashboardPage {...shared} />
    ) : (
      <CasesPage {...shared} resolvedOpen={resolvedOpen} setResolvedOpen={setResolvedOpen} />
    );

  const dataOptions =
    lens === 'client'
      ? [
          { value: 'typical', label: 'Typical' },
          { value: 'empty', label: 'Empty' },
          { value: 'noAccess', label: 'No access' },
        ]
      : [
          { value: 'typical', label: 'Typical' },
          { value: 'empty', label: 'Empty' },
          { value: 'setupIncomplete', label: 'Setup incomplete' },
        ];

  const note = noteFor({ lens, page, data, clock, second, navLabel });

  return (
    <div
      style={{
        fontFamily: T.font,
        background: '#e9edf3',
        minHeight: '100vh',
        padding: 16,
        color: T.text,
      }}
    >
      <style>{STYLE}</style>
      <div
        className="ci-tools"
        style={{
          background: '#0f172a',
          borderRadius: 12,
          padding: '12px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>
          <Seg
            label="Workspace"
            value={lens}
            onChange={setLens}
            options={[
              { value: 'client', label: 'Acme Corp, client' },
              { value: 'expert', label: 'Marcus Lee, expert' },
            ]}
          />
          <Seg
            label="Viewport"
            value={viewport}
            onChange={setViewport}
            options={[
              { value: 'desktop', label: 'Desktop' },
              { value: 'mobile', label: 'Mobile' },
            ]}
          />
          <Seg
            label="Page"
            value={page}
            onChange={setPage}
            options={[
              { value: 'cases', label: `/cases` },
              { value: 'dashboard', label: 'Dashboard' },
            ]}
          />
          <Seg label="Data" value={data} onChange={setData} options={dataOptions} />
          <Seg
            label="Next call"
            value={clock}
            onChange={setClock}
            options={[
              { value: 'later', label: 'In 3 hours' },
              { value: 'soon', label: 'In 9 min' },
              { value: 'live', label: 'In progress' },
            ]}
          />
        </div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 16,
            alignItems: 'flex-end',
            paddingTop: 10,
            boxShadow: 'inset 0 1px 0 #1e293b',
          }}
        >
          {lens === 'client' ? (
            <Seg
              label="Client bookings"
              value={second}
              onChange={setSecond}
              options={[
                { value: 'none', label: 'One (usual)' },
                { value: 'booked', label: 'Two' },
                { value: 'proposal', label: 'Two, new times suggested' },
              ]}
            />
          ) : null}
          <Seg
            label="Nav label"
            value={navLabel}
            onChange={setNavLabel}
            options={[
              { value: 'Cases', label: 'Cases (proposed)' },
              { value: 'Consultations', label: 'Consultations' },
            ]}
          />
          <div style={{ fontSize: 12, color: '#94a3b8', maxWidth: 440, lineHeight: 1.45 }}>
            Photos render from users.avatarUrl in production; initials are the fallback. No money
            appears on these surfaces. All copy is an MJ checkpoint.
          </div>
        </div>
      </div>
      <p
        style={{
          fontSize: 12.5,
          color: '#475569',
          margin: '10px 4px 12px',
          lineHeight: 1.5,
          maxWidth: 1120,
        }}
      >
        {note}
      </p>
      {mobile ? (
        <ScaledFrame width={410} height={860} center>
          <PhoneFrame>
            <MobileShell
              lens={lens}
              page={page}
              data={data}
              navLabel={navLabel}
              onNav={onNav}
              onBook={() => go('book')}
            >
              {body}
            </MobileShell>
            {toast ? <Toast msg={toast} /> : null}
          </PhoneFrame>
        </ScaledFrame>
      ) : (
        <ScaledFrame width={1280} height={860}>
          <div
            style={{
              width: 1280,
              height: 860,
              borderRadius: 12,
              overflow: 'hidden',
              border: `1px solid ${T.border}`,
              boxShadow: '0 20px 60px rgba(15,23,42,.12)',
              position: 'relative',
              background: '#fff',
            }}
          >
            <DesktopShell lens={lens} page={page} data={data} navLabel={navLabel} onNav={onNav}>
              {body}
            </DesktopShell>
            {toast ? <Toast msg={toast} /> : null}
          </div>
        </ScaledFrame>
      )}
    </div>
  );
}
