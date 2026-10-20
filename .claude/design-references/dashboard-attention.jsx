/**
 * dashboard-attention.jsx — design reference (Claude web → CC). Supersedes the earlier
 * list draft of the same name; only this version is committed.
 *
 *   1. "Your move" — a horizontal rail of type-specific cards instead of rows. Each card
 *      carries the context needed to decide before clicking (the brief, the client's change
 *      note, the kickoff gates, the suggested times). Chips filter the rail by type.
 *   2. "Where your projects stand" — every live project on one track, marked by whose move
 *      it is. The rail is what needs you; the track is everything else, so an empty rail
 *      still tells the expert where things are.
 *   3. The "You're live" card shows ONCE; from then on a live status badge under the sidebar
 *      workspace switcher carries the status.
 *
 * ⚠ ONE DEFINITION OF "NEEDS YOU". Project-side cards and every track token come from the
 * Projects inbox loaders (`loadExpertPortfolio` / `loadClientPortfolio`) and its rule table
 * (`needsYouForExpert`, `needsYouFor('client')`, `deriveEngagementRow` in
 * `lib/projects-inbox/portfolio-row.ts`). The dashboard never re-derives it, so the dashboard
 * and the Projects inbox can never disagree about whose move it is.
 *
 * Toolbar: Lens · Scenario · Viewport · Build notes. Colours stand in for repo tokens
 * (primary, violet, success, warning); CC uses the tokens, never these hex values.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Briefcase,
  Calendar,
  CalendarClock,
  CalendarPlus,
  CalendarX2,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Clock,
  Compass,
  CreditCard,
  ExternalLink,
  FileText,
  FolderKanban,
  Handshake,
  LayoutGrid,
  LifeBuoy,
  ListChecks,
  Mail,
  Menu,
  MessageSquare,
  PanelLeftClose,
  PenLine,
  Settings,
  Square,
  User,
  UserPlus,
  Users,
  Video,
  Wallet,
  Zap,
} from 'lucide-react';

// ─── Tokens (stand-ins) ──────────────────────────────────────────────────────────────

const T = {
  page: '#E9ECF1',
  bg: '#F7F8FA',
  card: '#FFFFFF',
  border: '#E6E8EC',
  fg: '#0F172A',
  muted: '#64748B',
  subtle: '#94A3B8',
  sidebar: '#F3F4F7',
  panel: '#EEF0FE', // primary at ~5% on white: the one tinted surface on the page
  panelBorder: 'rgba(79,70,229,0.16)',
  primary: '#4F46E5',
  primarySoft: 'rgba(79,70,229,0.10)',
  violet: '#7C3AED',
  violetSoft: 'rgba(124,58,237,0.10)',
  violetWash: 'rgba(124,58,237,0.06)',
  success: '#059669',
  successText: '#047857',
  successSoft: 'rgba(5,150,105,0.10)',
  warning: '#D97706',
  warningText: '#B45309',
  warningSoft: 'rgba(217,119,6,0.10)',
  warningRing: 'rgba(217,119,6,0.35)',
  slate: '#475569',
  slateSoft: 'rgba(71,85,105,0.10)',
  font: "'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
};

const TONES = {
  primary: { tile: T.primarySoft, fg: T.primary },
  violet: { tile: T.violetSoft, fg: T.violet },
  warning: { tile: T.warningSoft, fg: T.warningText },
  slate: { tile: T.slateSoft, fg: T.slate },
};

// ─── Row kinds ──────────────────────────────────────────────────────────────────────
// tier 0 = blocks bookings or money; tier 1 = someone is waiting on the viewer's reply;
// tier 2 = work owed with nobody blocked. `chip` is the filter group each kind files under.

export const KINDS = {
  calendar_reconnect: {
    lens: 'expert',
    tier: 0,
    label: 'Calendar',
    chip: 'Calendar',
    icon: CalendarX2,
    tone: 'warning',
    action: 'Reconnect calendar',
  },
  invitation: {
    lens: 'expert',
    tier: 1,
    label: 'Project invitation',
    chip: 'Invitations',
    icon: Mail,
    tone: 'violet',
    action: 'Review invitation',
  },
  eoi_followup: {
    lens: 'expert',
    tier: 1,
    label: 'Interest sent',
    chip: 'Interest',
    icon: Handshake,
    tone: 'violet',
    action: 'Propose times',
  },
  proposal_requested: {
    lens: 'expert',
    tier: 1,
    label: 'Proposal requested',
    chip: 'Proposals',
    icon: PenLine,
    tone: 'violet',
    action: 'Write proposal',
  },
  changes_requested: {
    lens: 'expert',
    tier: 1,
    label: 'Proposal changes',
    chip: 'Proposals',
    icon: PenLine,
    tone: 'violet',
    action: 'Revise proposal',
  },
  kickoff_terms: {
    lens: 'expert',
    tier: 1,
    label: 'Kickoff',
    chip: 'Kickoff',
    icon: Handshake,
    tone: 'violet',
    action: 'Confirm terms',
  },
  delivery_changes: {
    lens: 'expert',
    tier: 1,
    label: 'Delivery changes',
    chip: 'Delivery',
    icon: Briefcase,
    tone: 'violet',
    action: 'Open project',
  },
  receivable: {
    lens: 'client',
    tier: 0,
    label: 'Billing',
    chip: 'Billing',
    icon: CreditCard,
    tone: 'warning',
    action: 'Settle balance',
  },
  reschedule: {
    lens: 'client',
    tier: 1,
    label: 'New times suggested',
    chip: 'New times',
    icon: CalendarClock,
    tone: 'primary',
    action: 'Choose a time',
  },
  completion: {
    lens: 'client',
    tier: 1,
    label: 'Work to review',
    chip: 'Work to review',
    icon: CheckCircle2,
    tone: 'violet',
    action: 'Review work',
  },
  kickoff_billing: {
    lens: 'client',
    tier: 1,
    label: 'Kickoff',
    chip: 'Kickoff',
    icon: Handshake,
    tone: 'violet',
    action: 'Confirm billing',
  },
  exploratory_call: {
    lens: 'client',
    tier: 1,
    label: 'Exploratory call',
    chip: 'Calls',
    icon: Compass,
    tone: 'violet',
    action: 'Book a call',
  },
  eoi_reply: {
    lens: 'client',
    tier: 1,
    label: 'In conversation',
    chip: 'Replies',
    icon: Users,
    tone: 'violet',
    action: 'Reply',
  },
  proposal_review: {
    lens: 'client',
    tier: 1,
    label: 'Proposal to review',
    chip: 'Proposals',
    icon: FileText,
    tone: 'violet',
    action: 'Review proposal',
  },
  join_requests: {
    lens: 'client',
    tier: 1,
    label: 'Team',
    chip: 'Team',
    icon: UserPlus,
    tone: 'slate',
    action: 'Review requests',
  },
  action_items: {
    lens: 'both',
    tier: 2,
    label: 'Action items',
    chip: 'Action items',
    icon: ListChecks,
    tone: null,
    action: 'View items',
  },
  messages: {
    lens: 'both',
    tier: 2,
    label: 'Messages',
    chip: 'Messages',
    icon: MessageSquare,
    tone: 'slate',
    action: 'Open messages',
  },
};

/** Ordering: tier ASC → cards WITH a deadline first, soonest first → oldest waiting → id ASC. */
export function sortAttentionRows(rows) {
  return [...rows].sort((a, b) => {
    const tierA = KINDS[a.kind].tier;
    const tierB = KINDS[b.kind].tier;
    if (tierA !== tierB) return tierA - tierB;
    const hasA = a.deadline ? 0 : 1;
    const hasB = b.deadline ? 0 : 1;
    if (hasA !== hasB) return hasA - hasB;
    if (a.deadline && b.deadline && a.deadline !== b.deadline)
      return a.deadline < b.deadline ? -1 : 1;
    if (a.waitingSince !== b.waitingSince) return a.waitingSince < b.waitingSince ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

/** Project-side kinds: each must have a matching "Your move" token on the track. */
export const PROJECT_KINDS = {
  expert: [
    'invitation',
    'eoi_followup',
    'proposal_requested',
    'changes_requested',
    'kickoff_terms',
    'delivery_changes',
  ],
  client: ['exploratory_call', 'eoi_reply', 'proposal_review', 'kickoff_billing', 'completion'],
};

// ─── Fixtures (now = Tue 20 Oct 2026, 11:00 am) ─────────────────────────────────────
// Expert lens: the counterparty is ALWAYS the client company, never a person.
// Client lens: the expert, with the agency as the org line. No money anywhere.

const ER = {
  invitationNorthwind: {
    id: 'e-inv-1',
    kind: 'invitation',
    title: 'Marketing Cloud journey rebuild',
    counterparty: 'Northwind Logistics',
    fact: 'Invited 2 days ago',
    waitingSince: '2026-10-18T09:20',
    href: '/projects/req_northwind',
    ctx: {
      excerpt:
        'Rebuild our onboarding and win-back journeys, with Data Cloud segments driving entry and exit rules.',
      tags: ['Marketing Cloud', 'Data Cloud'],
      timeline: 'Target go-live: early December',
    },
  },
  invitationHarbour: {
    id: 'e-inv-2',
    kind: 'invitation',
    title: 'CPQ quote template cleanup',
    counterparty: 'Harbour Health',
    fact: 'Invited 5 hours ago',
    waitingSince: '2026-10-20T06:00',
    href: '/projects/req_harbour',
    ctx: {
      excerpt:
        'Our quote templates have drifted across three regions. We need one maintainable set and the legacy price rules cleaned up.',
      tags: ['CPQ'],
      timeline: null,
    },
  },
  eoiOrbit: {
    id: 'e-eoi-1',
    kind: 'eoi_followup',
    title: 'Experience Cloud partner portal',
    counterparty: 'Orbit Media',
    fact: 'Interest sent Fri 16 Oct',
    waitingSince: '2026-10-16T11:10',
    href: '/projects/req_orbit',
    ctx: { body: 'Share your availability so Orbit Media can book an intro call.' },
  },
  deliveryCoastal: {
    id: 'e-del-1',
    kind: 'delivery_changes',
    title: 'Revenue Cloud migration',
    counterparty: 'Coastal Water',
    fact: null,
    waitingSince: '2026-10-19T15:00',
    href: '/engagements/eng_coastal?from=inbox',
    ctx: {
      note: 'Can we move the quote-to-cash cutover after month-end close? Finance needs one more cycle on the old process.',
      done: 3,
      total: 5,
    },
  },
  proposalRequested: {
    id: 'e-prq-1',
    kind: 'proposal_requested',
    title: 'Service Cloud omni-channel setup',
    counterparty: 'Kestrel Energy',
    fact: 'Requested yesterday',
    actionLabel: 'Finish proposal',
    waitingSince: '2026-10-19T10:05',
    href: '/projects/req_kestrel',
    ctx: { draft: 'Draft saved yesterday, 4:12 pm' },
  },
  changesRequested: {
    id: 'e-chg-1',
    kind: 'changes_requested',
    title: 'Data Cloud identity resolution',
    counterparty: 'Atlas Retail Group',
    fact: 'Asked today',
    waitingSince: '2026-10-20T08:15',
    href: '/projects/req_atlas',
    ctx: {
      note: 'Could you split milestone 2 so the identity rules ship before the reporting work? We would also like a shorter overall timeline.',
      sections: ['Milestones', 'Timeline'],
    },
  },
  kickoffTerms: {
    id: 'e-kick-1',
    kind: 'kickoff_terms',
    title: 'Sales Cloud territory model',
    counterparty: 'Brightwater Bank',
    fact: 'Accepted Fri 16 Oct',
    waitingSince: '2026-10-16T15:30',
    href: '/projects/req_brightwater',
    ctx: {
      gates: [
        { label: 'Client billing', state: 'done' },
        { label: 'Your terms', state: 'yours' },
        { label: 'Balo approval', state: 'pending' },
      ],
    },
  },
  actionItems: {
    id: 'e-act-1',
    kind: 'action_items',
    tone: 'primary',
    title: 'Experience Cloud portal audit',
    counterparty: 'Meridian Insurance',
    fact: '1 overdue',
    factTone: 'warning',
    waitingSince: '2026-10-14T13:00',
    href: '/cases/eng_meridian',
    ctx: {
      items: [
        { text: 'Share the guest-user permission audit', overdue: true },
        { text: 'Draft sharing-set recommendations', overdue: false },
      ],
      more: 1,
    },
  },
  messages: {
    id: 'e-msg-1',
    kind: 'messages',
    title: '4 unread in 2 conversations',
    counterparty: 'Northwind Logistics and Kestrel Energy',
    fact: 'Since yesterday',
    waitingSince: '2026-10-19T16:40',
    href: '/messages',
    ctx: {
      from: 'Northwind Logistics',
      at: 'Yesterday, 4:40 pm',
      snippet: 'Thursday works for the intro call. Should we bring our CRM lead along?',
    },
  },
  calendarPaused: {
    id: 'e-cal-1',
    kind: 'calendar_reconnect',
    title: 'Reconnect your calendar',
    counterparty: 'Bookings are paused',
    fact: null,
    waitingSince: '2026-10-20T08:40',
    href: '/expert/settings?tab=schedule',
    ctx: {
      body: "Clients can still find you in search, but they can't book you until it's reconnected.",
    },
  },
  calendarDelisted: {
    id: 'e-cal-2',
    kind: 'calendar_reconnect',
    title: 'Reconnect your calendar',
    counterparty: 'Out of search',
    fact: null,
    waitingSince: '2026-10-19T07:10',
    href: '/expert/settings?tab=schedule',
    ctx: { body: "Clients can't find you in search until it's reconnected." },
  },
};

const CR = {
  receivable: {
    id: 'c-bill-1',
    kind: 'receivable',
    title: 'Outstanding balance',
    counterparty: 'New bookings are on hold',
    fact: 'Since Sat 17 Oct',
    waitingSince: '2026-10-17T12:00',
    href: '/settings/billing',
    ctx: { body: 'Settling it lifts the hold on new bookings.' },
  },
  reschedule: {
    id: 'c-rs-1',
    kind: 'reschedule',
    title: 'Flow error triage',
    counterparty: 'Jordan Lee, Summit Labs',
    fact: 'Reply by Thu 22 Oct',
    factTone: 'warning',
    deadline: '2026-10-22T17:00',
    waitingSince: '2026-10-20T07:45',
    href: '/cases/eng_flow',
    ctx: {
      was: 'Was Wed 21 Oct, 10:00 am',
      options: ['Thu 22 Oct, 9:00 am', 'Fri 23 Oct, 2:30 pm'],
    },
  },
  completion: {
    id: 'c-done-1',
    kind: 'completion',
    title: 'CPQ quote template cleanup',
    counterparty: 'Charles Akintunde, Cloudwise Partners',
    fact: 'Marked complete Thu 15 Oct',
    waitingSince: '2026-10-15T16:00',
    href: '/engagements/eng_cpq?from=inbox',
    ctx: { done: 4, total: 4, autoAccept: 'Accepted automatically on Thu 29 Oct' },
  },
  kickoffBilling: {
    id: 'c-kick-1',
    kind: 'kickoff_billing',
    title: 'Sales Cloud territory model',
    counterparty: 'Maya Patel, Brightline Advisory',
    fact: 'Accepted Fri 16 Oct',
    waitingSince: '2026-10-16T15:30',
    href: '/projects/req_territory',
    ctx: {
      gates: [
        { label: 'Your billing', state: 'yours' },
        { label: 'Expert terms', state: 'done' },
        { label: 'Balo approval', state: 'pending' },
      ],
    },
  },
  exploratoryCall: {
    id: 'c-exp-1',
    kind: 'exploratory_call',
    title: 'Commerce Cloud audit',
    counterparty: 'Balo',
    fact: 'Asked Fri 16 Oct',
    waitingSince: '2026-10-16T10:00',
    href: '/projects/req_commerce',
    ctx: { body: 'Book a short call with Balo so we can find the right experts for this brief.' },
  },
  eoiReply: {
    id: 'c-eoi-1',
    kind: 'eoi_reply',
    title: 'Marketing Cloud journey rebuild',
    counterparty: 'Sam Rivera, Altitude Consulting',
    fact: 'Yesterday',
    waitingSince: '2026-10-19T17:30',
    href: '/projects/req_journey',
    ctx: {
      from: 'Sam Rivera',
      at: 'Yesterday, 5:30 pm',
      snippet: 'Happy to start with a 30-minute call. Is Thursday morning good for your team?',
    },
  },
  proposalReview: {
    id: 'c-prop-1',
    kind: 'proposal_review',
    title: 'Data Cloud identity resolution',
    counterparty: 'Alex Chen, Cirrus Partners',
    fact: 'Sent yesterday',
    waitingSince: '2026-10-19T14:20',
    href: '/projects/req_identity',
    ctx: {
      stats: [
        { label: 'Version', value: '2' },
        { label: 'Timeframe', value: 'About 6 weeks' },
        { label: 'Milestones', value: '5' },
      ],
    },
  },
  joinRequests: {
    id: 'c-join-1',
    kind: 'join_requests',
    title: '2 people asked to join',
    counterparty: 'Northwind Logistics',
    fact: 'Since yesterday',
    waitingSince: '2026-10-19T11:30',
    href: '/settings/team',
    ctx: {
      people: [
        { initials: 'RM', name: 'Riley Morgan', org: 'riley@northwind.example' },
        { initials: 'DK', name: 'Dana Kim', org: 'dana@northwind.example' },
      ],
    },
  },
  actionItems: {
    id: 'c-act-1',
    kind: 'action_items',
    tone: 'primary',
    title: 'Flow error triage',
    counterparty: 'Jordan Lee, Summit Labs',
    fact: '2 open',
    waitingSince: '2026-10-13T10:00',
    href: '/cases/eng_flow',
    ctx: {
      items: [
        { text: 'Export the failing flow interviews', overdue: false },
        { text: 'Confirm the sandbox refresh date', overdue: false },
      ],
      more: 0,
    },
  },
  messages: {
    id: 'c-msg-1',
    kind: 'messages',
    title: '3 unread in 2 conversations',
    counterparty: 'Cirrus Partners and Summit Labs',
    fact: 'Since today',
    waitingSince: '2026-10-20T09:05',
    href: '/messages',
    ctx: {
      from: 'Alex Chen, Cirrus Partners',
      at: 'Today, 9:05 am',
      snippet: "I've attached the identity rules draft. Happy to walk through it on Friday.",
    },
  },
};

// Pipeline tokens. turn: 'you' | 'waiting' | 'progress'. Expert tokens name the company;
// client tokens name the project. A 'you' token links to the same page as its card.
const tok = (label, title, turn, href) => ({ label, title, turn, href });

const EXPERT_STAGES = ['Invited', 'Interest sent', 'Proposal', 'Kickoff', 'Delivery'];
const CLIENT_STAGES = ['Matching', 'Interest', 'Proposals', 'Kickoff', 'Delivery'];

const P = {
  northwind: tok(
    'Northwind Logistics',
    'Marketing Cloud journey rebuild',
    'you',
    '/projects/req_northwind'
  ),
  harbour: tok('Harbour Health', 'CPQ quote template cleanup', 'you', '/projects/req_harbour'),
  orbit: tok('Orbit Media', 'Experience Cloud partner portal', 'you', '/projects/req_orbit'),
  kestrel: tok(
    'Kestrel Energy',
    'Service Cloud omni-channel setup',
    'you',
    '/projects/req_kestrel'
  ),
  atlas: tok('Atlas Retail Group', 'Data Cloud identity resolution', 'you', '/projects/req_atlas'),
  pacific: tok('Pacific Rail', 'Field Service scheduling', 'waiting', '/projects/req_pacific'),
  brightwater: tok(
    'Brightwater Bank',
    'Sales Cloud territory model',
    'you',
    '/projects/req_brightwater'
  ),
  coastal: tok(
    'Coastal Water',
    'Revenue Cloud migration',
    'progress',
    '/engagements/eng_coastal?from=inbox'
  ),
  coastalChanges: tok(
    'Coastal Water',
    'Revenue Cloud migration',
    'you',
    '/engagements/eng_coastal?from=inbox'
  ),
  lumen: tok(
    'Lumen Retail',
    'Commerce Cloud B2B storefront',
    'waiting',
    '/engagements/eng_lumen?from=inbox'
  ),
  seaview: tok(
    'Seaview Hotels',
    'Service Cloud knowledge base',
    'waiting',
    '/projects/req_seaview'
  ),
  // client lens
  commerce: tok('Commerce Cloud audit', 'Commerce Cloud audit', 'you', '/projects/req_commerce'),
  tableau: tok(
    'Tableau dashboard refresh',
    'Tableau dashboard refresh',
    'waiting',
    '/projects/req_tableau'
  ),
  journey: tok(
    'Marketing Cloud journey rebuild',
    'Marketing Cloud journey rebuild',
    'you',
    '/projects/req_journey'
  ),
  journeyQuiet: tok(
    'Marketing Cloud journey rebuild',
    'Marketing Cloud journey rebuild',
    'waiting',
    '/projects/req_journey'
  ),
  identity: tok(
    'Data Cloud identity resolution',
    'Data Cloud identity resolution',
    'you',
    '/projects/req_identity'
  ),
  fieldService: tok(
    'Field Service scheduling',
    'Field Service scheduling',
    'waiting',
    '/projects/req_fieldservice'
  ),
  territory: tok(
    'Sales Cloud territory model',
    'Sales Cloud territory model',
    'you',
    '/projects/req_territory'
  ),
  cpq: tok(
    'CPQ quote template cleanup',
    'CPQ quote template cleanup',
    'you',
    '/engagements/eng_cpq?from=inbox'
  ),
  revenue: tok(
    'Revenue Cloud migration',
    'Revenue Cloud migration',
    'progress',
    '/engagements/eng_revenue?from=inbox'
  ),
};

const stagesOf = (labels, buckets) =>
  labels.map((label, i) => ({ id: label, label, items: buckets[i] ?? [] }));

const UP_NEXT = {
  expert: [
    {
      id: 'u1',
      type: 'Consultation',
      icon: Video,
      tone: 'primary',
      title: 'Experience Cloud portal audit',
      who: 'Meridian Insurance',
      when: 'Today, 2:30 pm',
      sub: '45 min',
    },
    {
      id: 'u2',
      type: 'Intro call',
      icon: Handshake,
      tone: 'violet',
      title: 'Marketing Cloud journey rebuild',
      who: 'Northwind Logistics',
      when: 'Thu 22 Oct',
      sub: '10:00 am, 30 min',
    },
  ],
  client: [
    {
      id: 'u3',
      type: 'Consultation',
      icon: Video,
      tone: 'primary',
      title: 'Flow error triage',
      who: 'Jordan Lee, Summit Labs',
      when: 'Tomorrow, 9:00 am',
      sub: '30 min',
      note: 'New times suggested',
    },
    {
      id: 'u4',
      type: 'Discovery call',
      icon: Compass,
      tone: 'violet',
      title: 'Data Cloud identity resolution',
      who: 'Alex Chen, Cirrus Partners',
      when: 'Fri 23 Oct',
      sub: '3:00 pm, 45 min',
    },
  ],
};

export const SCENARIOS = {
  expert: [
    { id: 'busy', label: 'Busy week' },
    { id: 'first_live', label: 'Just went live' },
    { id: 'caught_up', label: 'All caught up' },
    { id: 'paused', label: 'Bookings paused' },
    { id: 'not_listed', label: 'Not listed' },
    { id: 'away', label: 'Not taking work' },
  ],
  client: [
    { id: 'busy', label: 'Busy week' },
    { id: 'caught_up', label: 'All caught up' },
  ],
};

export function scenarioData(lens, scenario) {
  if (lens === 'client') {
    if (scenario === 'caught_up') {
      return {
        live: null,
        celebrate: false,
        rows: [],
        upNext: [],
        pipeline: stagesOf(CLIENT_STAGES, [
          [P.tableau],
          [P.journeyQuiet],
          [P.fieldService],
          [],
          [P.revenue],
        ]),
      };
    }
    return {
      live: null,
      celebrate: false,
      rows: [
        CR.messages,
        CR.proposalReview,
        CR.eoiReply,
        CR.actionItems,
        CR.joinRequests,
        CR.reschedule,
        CR.kickoffBilling,
        CR.receivable,
        CR.completion,
        CR.exploratoryCall,
      ],
      upNext: UP_NEXT.client,
      pipeline: stagesOf(CLIENT_STAGES, [
        [P.commerce, P.tableau],
        [P.journey],
        [P.identity, P.fieldService],
        [P.territory],
        [P.cpq, P.revenue],
      ]),
    };
  }
  switch (scenario) {
    case 'first_live':
      return {
        live: 'live',
        celebrate: true,
        upNext: [],
        earnings: 'zero',
        rows: [
          {
            ...ER.invitationNorthwind,
            fact: 'Invited 3 hours ago',
            waitingSince: '2026-10-20T08:00',
          },
        ],
        pipeline: stagesOf(EXPERT_STAGES, [[P.northwind]]),
      };
    case 'caught_up':
      return {
        live: 'live',
        celebrate: false,
        rows: [],
        upNext: UP_NEXT.expert,
        earnings: 'some',
        pipeline: stagesOf(EXPERT_STAGES, [[], [], [P.pacific], [P.seaview], [P.coastal, P.lumen]]),
      };
    case 'paused':
      return {
        live: 'paused',
        celebrate: false,
        upNext: UP_NEXT.expert,
        earnings: 'some',
        rows: [ER.invitationNorthwind, ER.calendarPaused, ER.proposalRequested],
        pipeline: stagesOf(EXPERT_STAGES, [
          [P.northwind],
          [],
          [P.kestrel, P.pacific],
          [],
          [P.coastal],
        ]),
      };
    case 'not_listed':
      return {
        live: 'not_listed',
        celebrate: false,
        upNext: [],
        earnings: 'some',
        rows: [ER.invitationHarbour, ER.calendarDelisted],
        pipeline: stagesOf(EXPERT_STAGES, [[P.harbour], [], [], [], [P.coastal]]),
      };
    case 'away':
      return {
        live: 'away',
        celebrate: false,
        upNext: UP_NEXT.expert,
        earnings: 'some',
        rows: [ER.invitationHarbour, ER.actionItems],
        pipeline: stagesOf(EXPERT_STAGES, [[P.harbour], [], [P.pacific], [], [P.coastal]]),
      };
    default:
      return {
        live: 'live',
        celebrate: false,
        upNext: UP_NEXT.expert,
        earnings: 'some',
        // Deliberately shuffled: the rail sorts with sortAttentionRows.
        rows: [
          ER.messages,
          ER.invitationHarbour,
          ER.deliveryCoastal,
          ER.actionItems,
          ER.changesRequested,
          ER.kickoffTerms,
          ER.eoiOrbit,
          ER.proposalRequested,
          ER.invitationNorthwind,
        ],
        pipeline: stagesOf(EXPERT_STAGES, [
          [P.northwind, P.harbour],
          [P.orbit],
          [P.kestrel, P.atlas, P.pacific],
          [P.brightwater],
          [P.coastalChanges, P.lumen],
        ]),
      };
  }
}

// ─── Copy ────────────────────────────────────────────────────────────────────────────

const COPY = {
  expert: {
    firstName: 'Charles',
    switcherTitle: 'Charles Akintunde',
    switcherSub: 'Expert workspace',
    initials: 'CA',
    headerSub: "Here's what's happening with your expert account.",
    upNextSub: 'Your meetings across cases and projects',
    pipelineTitle: 'Where your projects stand',
    pipelineSub: 'Every live project, and whose move it is.',
    waiting: 'Waiting on client',
  },
  client: {
    firstName: 'Priya',
    switcherTitle: 'Northwind Logistics',
    switcherSub: 'Company workspace',
    initials: 'NL',
    headerSub: "Here's what's happening across Northwind Logistics.",
    upNextSub: "Meetings across your company's cases and projects",
    pipelineTitle: 'Where your projects stand',
    pipelineSub: 'Every open request and project, and whose move it is.',
    waiting: 'Waiting on others',
  },
};

const YOUR_MOVE_TITLE = 'Your move';
const SETTLED_TITLE = "Nothing's waiting on you";
const SETTLED_SUB = "Everything below is in someone else's hands or underway.";

function countSentence(n) {
  return n === 1 ? '1 thing is waiting on you' : `${n} things are waiting on you`;
}

export const LIVE_STATES = {
  live: {
    pill: 'Live',
    dot: T.success,
    pillBg: T.successSoft,
    pillFg: T.successText,
    title: "You're live on the marketplace",
    body: 'Clients can find you in search and book you.',
    primary: null,
  },
  paused: {
    pill: 'Bookings paused',
    dot: T.warning,
    pillBg: T.warningSoft,
    pillFg: T.warningText,
    title: 'Bookings are paused',
    body: "You still appear in search, but clients can't book you until your calendar is reconnected.",
    primary: 'Reconnect calendar',
  },
  away: {
    pill: 'Not taking work',
    dot: '#CBD5E1',
    pillBg: T.slateSoft,
    pillFg: T.slate,
    title: "You're not taking on new work",
    body: 'You still appear in search, but clients are offered a similar expert instead of booking you.',
    primary: 'Change availability',
  },
  not_listed: {
    pill: 'Not listed',
    dot: T.subtle,
    pillBg: T.slateSoft,
    pillFg: T.slate,
    title: "You're not in search right now",
    body: "Clients can't find you until your calendar is reconnected.",
    primary: 'Reconnect calendar',
  },
};

// ─── Shared bits ─────────────────────────────────────────────────────────────────────

const card = {
  background: T.card,
  border: `1px solid ${T.border}`,
  borderRadius: 16,
  boxShadow: '0 1px 2px rgba(15,23,42,0.05)',
  padding: '18px 18px 6px',
};
const cardTitle = {
  margin: 0,
  fontSize: 17,
  fontWeight: 600,
  letterSpacing: '-0.01em',
  color: T.fg,
};
const cardSub = { margin: '2px 0 12px', fontSize: 13, color: T.muted };
const footerLink = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 12.5,
  fontWeight: 600,
  color: T.primary,
  textDecoration: 'none',
};
const clamp = (lines) => ({
  display: '-webkit-box',
  WebkitLineClamp: lines,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
});
const preventNav = (e) => e.preventDefault();

function Tile({ icon: Icon, tone, size = 36, iconSize = 17 }) {
  const t = TONES[tone];
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: size > 30 ? 10 : 8,
        background: t.tile,
        color: t.fg,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon size={iconSize} />
    </span>
  );
}

function ButtonLink({ href, children, variant = 'outline', onClick }) {
  const solid = variant === 'solid';
  return (
    <a
      href={href}
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 36,
        padding: '0 14px',
        borderRadius: 8,
        fontSize: 13,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        textDecoration: 'none',
        background: solid ? T.primary : T.card,
        color: solid ? '#fff' : T.fg,
        border: solid ? `1px solid ${T.primary}` : `1px solid ${T.border}`,
      }}
    >
      {children}
    </a>
  );
}

function Chip({ children }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 22,
        padding: '0 8px',
        borderRadius: 6,
        background: T.slateSoft,
        color: T.slate,
        fontSize: 11.5,
        fontWeight: 600,
      }}
    >
      {children}
    </span>
  );
}

// ─── Card context, one shape per kind (read-only: actions live on the owning page) ───

function Gates({ gates }) {
  return (
    <ol
      aria-label="Kickoff gates"
      style={{ display: 'flex', listStyle: 'none', margin: '2px 0 0', padding: 0 }}
    >
      {gates.map((g, i) => {
        const done = g.state === 'done';
        const yours = g.state === 'yours';
        return (
          <li key={g.label} style={{ flex: 1, position: 'relative', textAlign: 'center' }}>
            {i > 0 && (
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  top: 11,
                  right: '50%',
                  width: '100%',
                  height: 2,
                  background: gates[i - 1].state === 'done' ? T.success : T.border,
                }}
              />
            )}
            <span
              style={{
                position: 'relative',
                zIndex: 1,
                width: 24,
                height: 24,
                borderRadius: '50%',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: done ? T.success : T.card,
                color: '#fff',
                border: done ? 'none' : `2px solid ${yours ? T.primary : T.border}`,
              }}
            >
              {done && <Check size={14} aria-hidden="true" />}
              {yours && (
                <span
                  aria-hidden="true"
                  style={{ width: 8, height: 8, borderRadius: '50%', background: T.primary }}
                />
              )}
            </span>
            <span
              style={{
                display: 'block',
                marginTop: 5,
                fontSize: 11.5,
                fontWeight: yours ? 600 : 500,
                color: yours ? T.primary : T.muted,
              }}
            >
              {g.label}
              <span
                style={{
                  position: 'absolute',
                  width: 1,
                  height: 1,
                  overflow: 'hidden',
                  clip: 'rect(0 0 0 0)',
                }}
              >
                {done ? ', done' : yours ? ', waiting on you' : ', not yet'}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function People({ people }) {
  return (
    <ul
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {people.map((p) => (
        <li key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          <span
            aria-hidden="true"
            style={{
              width: 28,
              height: 28,
              flexShrink: 0,
              borderRadius: '50%',
              background: '#DDD6FE',
              color: '#4C1D95',
              fontSize: 11,
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {p.initials}
          </span>
          <span style={{ minWidth: 0 }}>
            <span
              style={{
                display: 'block',
                fontSize: 13,
                fontWeight: 600,
                color: T.fg,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {p.name}
            </span>
            <span
              style={{
                display: 'block',
                fontSize: 12,
                color: T.muted,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {p.org}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function CardContext({ row }) {
  const c = row.ctx ?? {};
  switch (row.kind) {
    case 'invitation':
      return (
        <div>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: '#334155', ...clamp(3) }}>
            {c.excerpt}
          </p>
          {c.tags?.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
              {c.tags.map((tag) => (
                <Chip key={tag}>{tag}</Chip>
              ))}
            </div>
          )}
          {c.timeline && (
            <p
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                margin: '10px 0 0',
                fontSize: 12,
                color: T.muted,
              }}
            >
              <Clock size={13} aria-hidden="true" />
              {c.timeline}
            </p>
          )}
        </div>
      );
    case 'proposal_requested':
      return (
        <p
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            margin: 0,
            padding: '9px 11px',
            borderRadius: 10,
            background: T.violetWash,
            fontSize: 12.5,
            color: T.violet,
            fontWeight: 600,
          }}
        >
          <PenLine size={14} aria-hidden="true" />
          {c.draft ?? 'Not started yet'}
        </p>
      );
    case 'changes_requested':
      return (
        <div>
          <blockquote
            style={{
              margin: 0,
              padding: '8px 11px',
              borderLeft: `3px solid ${T.violet}`,
              background: T.violetWash,
              borderRadius: '0 8px 8px 0',
              fontSize: 13,
              lineHeight: 1.5,
              color: '#334155',
              ...clamp(3),
            }}
          >
            {c.note}
          </blockquote>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
            {c.sections.map((s) => (
              <Chip key={s}>{s}</Chip>
            ))}
          </div>
        </div>
      );
    case 'kickoff_terms':
    case 'kickoff_billing':
      return <Gates gates={c.gates} />;
    case 'action_items':
      return (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 7,
          }}
        >
          {c.items.map((it) => (
            <li
              key={it.text}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                fontSize: 13,
                color: T.fg,
              }}
            >
              {it.overdue ? (
                <AlertCircle
                  size={15}
                  color={T.warningText}
                  aria-hidden="true"
                  style={{ flexShrink: 0, marginTop: 2 }}
                />
              ) : (
                <Square
                  size={15}
                  color={T.subtle}
                  aria-hidden="true"
                  style={{ flexShrink: 0, marginTop: 2 }}
                />
              )}
              <span style={{ minWidth: 0 }}>
                {it.text}
                {it.overdue && (
                  <span
                    style={{ marginLeft: 6, fontSize: 11.5, fontWeight: 600, color: T.warningText }}
                  >
                    Overdue
                  </span>
                )}
              </span>
            </li>
          ))}
          {c.more > 0 && (
            <li style={{ fontSize: 12.5, color: T.muted, paddingLeft: 23 }}>{c.more} more</li>
          )}
        </ul>
      );
    case 'messages':
    case 'eoi_reply':
      return (
        <div
          style={{
            padding: '10px 12px',
            borderRadius: '4px 12px 12px 12px',
            background: T.bg,
            border: `1px solid ${T.border}`,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12 }}>
            <span
              style={{
                fontWeight: 600,
                color: T.fg,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {c.from}
            </span>
            <span style={{ color: T.muted, whiteSpace: 'nowrap' }}>{c.at}</span>
          </div>
          <p
            style={{
              margin: '4px 0 0',
              fontSize: 13,
              lineHeight: 1.45,
              color: '#334155',
              ...clamp(2),
            }}
          >
            {c.snippet}
          </p>
        </div>
      );
    case 'eoi_followup':
    case 'exploratory_call':
    case 'calendar_reconnect':
    case 'receivable':
      return <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: '#334155' }}>{c.body}</p>;
    case 'reschedule':
      return (
        <div>
          <p
            style={{
              margin: '0 0 8px',
              fontSize: 12.5,
              color: T.muted,
              textDecoration: 'line-through',
            }}
          >
            {c.was}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {c.options.map((o) => (
              <a
                key={o}
                href={row.href}
                onClick={preventNav}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  height: 34,
                  padding: '0 11px',
                  borderRadius: 8,
                  background: T.primarySoft,
                  color: T.primary,
                  fontSize: 13,
                  fontWeight: 600,
                  textDecoration: 'none',
                }}
              >
                {o}
                <ChevronRight size={15} aria-hidden="true" />
              </a>
            ))}
          </div>
        </div>
      );
    case 'delivery_changes': {
      const pct = Math.round((c.done / c.total) * 100);
      return (
        <div>
          <blockquote
            style={{
              margin: 0,
              padding: '8px 11px',
              borderLeft: `3px solid ${T.violet}`,
              background: T.violetWash,
              borderRadius: '0 8px 8px 0',
              fontSize: 13,
              lineHeight: 1.5,
              color: '#334155',
              ...clamp(3),
            }}
          >
            {c.note}
          </blockquote>
          <div
            aria-hidden="true"
            style={{
              height: 6,
              marginTop: 12,
              borderRadius: 999,
              background: T.slateSoft,
              overflow: 'hidden',
            }}
          >
            <div style={{ width: `${pct}%`, height: '100%', background: T.violet }} />
          </div>
          <p style={{ margin: '6px 0 0', fontSize: 12.5, color: T.muted }}>
            {c.done} of {c.total} milestones
          </p>
        </div>
      );
    }
    case 'completion': {
      const pct = Math.round((c.done / c.total) * 100);
      return (
        <div>
          <div
            aria-hidden="true"
            style={{ height: 6, borderRadius: 999, background: T.slateSoft, overflow: 'hidden' }}
          >
            <div style={{ width: `${pct}%`, height: '100%', background: T.success }} />
          </div>
          <p style={{ margin: '8px 0 0', fontSize: 13, fontWeight: 600, color: T.fg }}>
            {c.done} of {c.total} milestones complete
          </p>
          <p style={{ margin: '2px 0 0', fontSize: 12.5, color: T.muted }}>{c.autoAccept}</p>
        </div>
      );
    }
    case 'join_requests':
      return <People people={c.people} />;
    case 'proposal_review':
      return (
        <dl
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0,1fr))',
            gap: 8,
            margin: 0,
          }}
        >
          {c.stats.map((s) => (
            <div
              key={s.label}
              style={{ padding: '8px 9px', borderRadius: 10, background: T.violetWash }}
            >
              <dt style={{ fontSize: 11.5, color: T.muted }}>{s.label}</dt>
              <dd style={{ margin: '2px 0 0', fontSize: 13.5, fontWeight: 600, color: T.fg }}>
                {s.value}
              </dd>
            </div>
          ))}
        </dl>
      );
    default:
      return null;
  }
}

// ─── Your move ───────────────────────────────────────────────────────────────────────

function TicketNotches() {
  const notch = {
    position: 'absolute',
    top: -9,
    width: 16,
    height: 16,
    borderRadius: '50%',
    background: T.panel,
    border: `1px solid ${T.panelBorder}`,
  };
  return (
    <>
      <span aria-hidden="true" style={{ ...notch, left: -9 }} />
      <span aria-hidden="true" style={{ ...notch, right: -9 }} />
    </>
  );
}

function MoveCard({ row, featured, mobile }) {
  const kind = KINDS[row.kind];
  const tone = kind.tone ?? row.tone;
  const t = TONES[tone];
  const blocker = kind.tier === 0;
  const action = row.actionLabel ?? kind.action;
  const width = mobile ? 292 : featured ? 384 : 300;
  const factColor = row.factTone === 'warning' ? T.warningText : T.muted;
  const ticket = row.kind === 'invitation';

  return (
    <article
      role="listitem"
      aria-label={`${kind.label}: ${row.title}`}
      data-kind={row.kind}
      data-featured={featured ? 'true' : undefined}
      style={{
        position: 'relative',
        flex: `0 0 ${width}px`,
        scrollSnapAlign: 'start',
        display: 'flex',
        flexDirection: 'column',
        background: T.card,
        borderRadius: 14,
        overflow: 'hidden',
        border: `1px solid ${blocker ? T.warningRing : T.border}`,
        boxShadow: featured ? '0 6px 20px rgba(79,70,229,0.12)' : '0 1px 2px rgba(15,23,42,0.05)',
      }}
    >
      <span
        aria-hidden="true"
        style={{ height: 4, flexShrink: 0, background: blocker ? T.warning : t.fg }}
      />
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          padding: '14px 16px 0',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Tile icon={kind.icon} tone={tone} size={28} iconSize={15} />
          <span style={{ fontSize: 12, fontWeight: 600, color: t.fg }}>{kind.label}</span>
        </div>
        <div>
          <h3
            style={{
              margin: 0,
              fontSize: featured ? 17 : 15.5,
              fontWeight: 600,
              lineHeight: 1.3,
              letterSpacing: '-0.01em',
              color: T.fg,
              ...clamp(2),
            }}
          >
            {row.title}
          </h3>
          <p
            style={{
              margin: '3px 0 0',
              fontSize: 13,
              color: T.muted,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {row.counterparty}
          </p>
        </div>
        <CardContext row={row} />
      </div>
      <div
        style={{
          position: 'relative',
          marginTop: 14,
          padding: '12px 16px 14px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          borderTop: ticket ? `1.5px dashed ${T.border}` : `1px solid ${T.border}`,
        }}
      >
        {ticket && <TicketNotches />}
        <span
          style={{
            fontSize: 12,
            fontWeight: row.factTone === 'warning' ? 600 : 500,
            color: factColor,
            minWidth: 0,
          }}
        >
          {row.fact ?? ''}
        </span>
        <ButtonLink
          href={row.href}
          onClick={preventNav}
          variant={blocker || featured ? 'solid' : 'outline'}
        >
          {action}
        </ButtonLink>
      </div>
    </article>
  );
}

function IconButton({ label, onClick, children }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      style={{
        width: 36,
        height: 36,
        borderRadius: '50%',
        border: `1px solid ${T.panelBorder}`,
        background: T.card,
        color: T.fg,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

export function YourMove({ rows, mobile }) {
  const [filter, setFilter] = useState('all');
  const railRef = useRef(null);
  const sorted = sortAttentionRows(rows);

  const panel = {
    background: T.panel,
    border: `1px solid ${T.panelBorder}`,
    borderRadius: 18,
    padding: mobile ? '18px 0 6px 16px' : '22px 0 10px 22px',
  };

  if (sorted.length === 0) {
    return (
      <section
        aria-label={SETTLED_TITLE}
        data-attention="empty"
        style={{
          ...panel,
          padding: mobile ? '16px' : '18px 22px',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 40,
            height: 40,
            flexShrink: 0,
            borderRadius: '50%',
            background: T.successSoft,
            color: T.success,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <CheckCircle2 size={20} />
        </span>
        <span>
          <span style={{ display: 'block', fontSize: 16, fontWeight: 600, color: T.fg }}>
            {SETTLED_TITLE}
          </span>
          <span style={{ display: 'block', fontSize: 13, color: T.muted }}>{SETTLED_SUB}</span>
        </span>
      </section>
    );
  }

  const groups = [];
  for (const r of sorted) {
    const chip = KINDS[r.kind].chip;
    const g = groups.find((x) => x.chip === chip);
    if (g) g.count += 1;
    else groups.push({ chip, count: 1 });
  }
  const visible = filter === 'all' ? sorted : sorted.filter((r) => KINDS[r.kind].chip === filter);
  const scroll = (dir) => railRef.current?.scrollBy({ left: dir * 314, behavior: 'smooth' });

  const chipStyle = (on) => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    height: 32,
    padding: '0 12px',
    flexShrink: 0,
    borderRadius: 999,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 13,
    fontWeight: 600,
    border: `1px solid ${on ? T.fg : T.panelBorder}`,
    background: on ? T.fg : T.card,
    color: on ? '#fff' : T.fg,
  });

  return (
    <section aria-labelledby="your-move-heading" data-attention="rail" style={panel}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 12,
          paddingRight: mobile ? 16 : 22,
        }}
      >
        <div>
          <h2
            id="your-move-heading"
            style={{
              margin: 0,
              fontSize: mobile ? 20 : 22,
              fontWeight: 600,
              letterSpacing: '-0.02em',
              color: T.fg,
            }}
          >
            {YOUR_MOVE_TITLE}
          </h2>
          <p style={{ margin: '3px 0 0', fontSize: 13.5, color: T.muted }}>
            {countSentence(sorted.length)}
          </p>
        </div>
        {!mobile && (
          <div style={{ display: 'flex', gap: 8 }}>
            <IconButton label="Scroll back" onClick={() => scroll(-1)}>
              <ChevronLeft size={18} />
            </IconButton>
            <IconButton label="Scroll forward" onClick={() => scroll(1)}>
              <ChevronRight size={18} />
            </IconButton>
          </div>
        )}
      </div>

      {groups.length > 1 && (
        <div
          role="group"
          aria-label="Filter by type"
          style={{
            display: 'flex',
            flexWrap: mobile ? 'nowrap' : 'wrap',
            overflowX: mobile ? 'auto' : 'visible',
            gap: 8,
            margin: '14px 0 14px',
            paddingRight: mobile ? 16 : 22,
          }}
        >
          <button
            type="button"
            aria-pressed={filter === 'all'}
            onClick={() => setFilter('all')}
            style={chipStyle(filter === 'all')}
          >
            All <span style={{ opacity: 0.65 }}>{sorted.length}</span>
          </button>
          {groups.map((g) => (
            <button
              key={g.chip}
              type="button"
              aria-pressed={filter === g.chip}
              onClick={() => setFilter(g.chip)}
              style={chipStyle(filter === g.chip)}
            >
              {g.chip} <span style={{ opacity: 0.65 }}>{g.count}</span>
            </button>
          ))}
        </div>
      )}

      <div
        ref={railRef}
        role="list"
        aria-label="Waiting on you"
        style={{
          display: 'flex',
          alignItems: 'stretch',
          gap: 14,
          overflowX: 'auto',
          scrollSnapType: 'x mandatory',
          scrollPaddingLeft: 0,
          padding: groups.length > 1 ? '0 22px 14px 0' : '16px 22px 14px 0',
          scrollbarWidth: 'thin',
        }}
      >
        {visible.map((row, i) => (
          <MoveCard
            key={row.id}
            row={row}
            featured={!mobile && filter === 'all' && i === 0}
            mobile={mobile}
          />
        ))}
      </div>
    </section>
  );
}

// ─── Where your projects stand ───────────────────────────────────────────────────────

const TURN_STYLE = {
  you: {
    bg: T.primarySoft,
    fg: T.primary,
    border: `1px solid transparent`,
    dot: { background: T.primary },
  },
  waiting: {
    bg: T.card,
    fg: T.muted,
    border: `1px dashed ${T.subtle}`,
    dot: { background: 'transparent', boxShadow: `inset 0 0 0 1.5px ${T.subtle}` },
  },
  progress: {
    bg: T.slateSoft,
    fg: T.slate,
    border: `1px solid transparent`,
    dot: { background: T.slate },
  },
};

function Token({ item, lens }) {
  const s = TURN_STYLE[item.turn];
  const turnText =
    item.turn === 'you'
      ? 'your move'
      : item.turn === 'waiting'
        ? COPY[lens].waiting.toLowerCase()
        : 'in progress';
  return (
    <a
      href={item.href}
      onClick={preventNav}
      data-turn={item.turn}
      data-href={item.href}
      title={`${item.title}: ${turnText}`}
      aria-label={`${item.label}, ${item.title}: ${turnText}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        maxWidth: '100%',
        height: 28,
        padding: '0 10px',
        borderRadius: 999,
        background: s.bg,
        color: s.fg,
        border: s.border,
        fontSize: 12.5,
        fontWeight: item.turn === 'you' ? 600 : 500,
        textDecoration: 'none',
      }}
    >
      <span
        aria-hidden="true"
        style={{ width: 8, height: 8, flexShrink: 0, borderRadius: '50%', ...s.dot }}
      />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {item.label}
      </span>
    </a>
  );
}

function StageNode({ stage }) {
  const yours = stage.items.some((x) => x.turn === 'you');
  const empty = stage.items.length === 0;
  return (
    <span
      aria-hidden="true"
      style={{
        position: 'relative',
        zIndex: 1,
        width: 30,
        height: 30,
        flexShrink: 0,
        borderRadius: '50%',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12.5,
        fontWeight: 700,
        background: yours ? T.primary : T.card,
        color: yours ? '#fff' : empty ? T.subtle : T.fg,
        border: yours
          ? 'none'
          : `1.5px ${empty ? 'dashed' : 'solid'} ${empty ? T.border : T.subtle}`,
      }}
    >
      {stage.items.length}
    </span>
  );
}

export function Pipeline({ lens, stages, mobile }) {
  const c = COPY[lens];
  const legend = [
    { turn: 'you', label: 'Your move' },
    { turn: 'waiting', label: c.waiting },
    { turn: 'progress', label: 'In progress' },
  ];
  return (
    <section
      aria-labelledby="pipeline-heading"
      data-pipeline={lens}
      style={{ ...card, padding: mobile ? '18px 16px 18px' : '20px 22px 22px' }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 18,
        }}
      >
        <div>
          <h2 id="pipeline-heading" style={cardTitle}>
            {c.pipelineTitle}
          </h2>
          <p style={{ ...cardSub, margin: '2px 0 0' }}>{c.pipelineSub}</p>
        </div>
        <ul
          aria-label="Legend"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 14,
            listStyle: 'none',
            margin: 0,
            padding: 0,
          }}
        >
          {legend.map((l) => (
            <li
              key={l.turn}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                color: T.muted,
              }}
            >
              <span
                aria-hidden="true"
                style={{ width: 8, height: 8, borderRadius: '50%', ...TURN_STYLE[l.turn].dot }}
              />
              {l.label}
            </li>
          ))}
        </ul>
      </div>

      {mobile ? (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {stages.map((s, i) => (
            <li
              key={s.id}
              style={{
                position: 'relative',
                display: 'grid',
                gridTemplateColumns: '30px minmax(0,1fr)',
                columnGap: 12,
                paddingBottom: i === stages.length - 1 ? 0 : 16,
              }}
            >
              {i < stages.length - 1 && (
                <span
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    left: 14,
                    top: 30,
                    bottom: 0,
                    width: 2,
                    background: T.border,
                  }}
                />
              )}
              <StageNode stage={s} />
              <div style={{ minWidth: 0, paddingTop: 5 }}>
                <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, color: T.fg }}>
                  {s.label}
                </span>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 6,
                    marginTop: s.items.length ? 8 : 0,
                  }}
                >
                  {s.items.map((it) => (
                    <Token key={it.href} item={it} lens={lens} />
                  ))}
                </div>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <ol
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${stages.length}, minmax(0,1fr))`,
            listStyle: 'none',
            margin: 0,
            padding: 0,
          }}
        >
          {stages.map((s, i) => (
            <li key={s.id} style={{ position: 'relative', minWidth: 0, paddingRight: 12 }}>
              {i < stages.length - 1 && (
                <span
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    top: 14,
                    left: 30,
                    right: 0,
                    height: 2,
                    background: T.border,
                  }}
                />
              )}
              <StageNode stage={s} />
              <span
                style={{
                  display: 'block',
                  marginTop: 10,
                  fontSize: 13.5,
                  fontWeight: 600,
                  color: T.fg,
                }}
              >
                {s.label}
              </span>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 6,
                  marginTop: 10,
                }}
              >
                {s.items.length === 0 && (
                  <span style={{ fontSize: 12.5, color: T.subtle }}>None</span>
                )}
                {s.items.map((it) => (
                  <Token key={it.href} item={it} lens={lens} />
                ))}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// ─── Up next (shipped, BAL-566 — context only) ───────────────────────────────────────

function UpNextCard({ lens, rows }) {
  const links =
    lens === 'expert'
      ? [{ label: 'Open calendar', href: '/expert/calendar' }]
      : [
          { label: 'Cases', href: '/cases' },
          { label: 'Projects', href: '/projects' },
        ];
  return (
    <section aria-labelledby="up-next-heading" style={card}>
      <h2 id="up-next-heading" style={cardTitle}>
        Up next
      </h2>
      <p style={cardSub}>{COPY[lens].upNextSub}</p>
      {rows.length === 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0 16px' }}>
          <span
            aria-hidden="true"
            style={{
              width: 44,
              height: 44,
              borderRadius: 10,
              border: `1px dashed ${T.border}`,
              color: T.muted,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <CalendarPlus size={20} />
          </span>
          <span>
            <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: T.fg }}>
              Nothing booked
            </span>
            <span style={{ display: 'block', fontSize: 13, color: T.muted }}>
              {lens === 'expert'
                ? 'New bookings show up here and in Calendar.'
                : 'Book an expert to get started.'}
            </span>
          </span>
        </div>
      ) : (
        rows.map((r, i) => (
          <div
            key={r.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '12px 4px',
              borderBottom: i === rows.length - 1 ? 'none' : `1px solid ${T.border}`,
            }}
          >
            <Tile icon={r.icon} tone={r.tone} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span
                style={{ display: 'block', fontSize: 12, fontWeight: 600, color: TONES[r.tone].fg }}
              >
                {r.type}
              </span>
              <span
                style={{
                  display: 'block',
                  fontSize: 14,
                  fontWeight: 600,
                  color: T.fg,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {r.title}
              </span>
              <span
                style={{
                  display: 'block',
                  fontSize: 12.5,
                  color: T.muted,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {r.who}
              </span>
            </span>
            <span style={{ flexShrink: 0, textAlign: 'right' }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: T.fg }}>
                {r.when}
              </span>
              <span style={{ display: 'block', fontSize: 12, color: T.muted }}>{r.sub}</span>
              {r.note && (
                <span
                  style={{ display: 'block', fontSize: 12, fontWeight: 600, color: T.warningText }}
                >
                  {r.note}
                </span>
              )}
            </span>
          </div>
        ))
      )}
      <div
        style={{
          borderTop: `1px solid ${T.border}`,
          marginTop: 6,
          padding: '12px 0 10px',
          display: 'flex',
          gap: 18,
        }}
      >
        {links.map((l) => (
          <a key={l.label} href={l.href} onClick={preventNav} style={footerLink}>
            {l.label}
            <ArrowRight size={12} aria-hidden="true" />
          </a>
        ))}
      </div>
    </section>
  );
}

// ─── Side cards ──────────────────────────────────────────────────────────────────────

function EarningsCard({ earnings }) {
  const zero = earnings === 'zero';
  const lines = [
    { label: 'Pending transfer', value: zero ? 'A$0.00' : 'A$1,240.00' },
    { label: 'This payout cycle', value: zero ? 'A$0.00' : 'A$3,610.00' },
    { label: 'Total earnings', value: zero ? 'A$0.00' : 'A$18,450.00' },
  ];
  return (
    <section aria-labelledby="earnings-heading" style={card}>
      <h2 id="earnings-heading" style={{ ...cardTitle, fontSize: 15 }}>
        Earnings
      </h2>
      <dl style={{ margin: '10px 0 0' }}>
        {lines.map((l) => (
          <div
            key={l.label}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              padding: '9px 0',
              borderBottom: `1px solid ${T.border}`,
            }}
          >
            <dt style={{ fontSize: 13, color: T.muted }}>{l.label}</dt>
            <dd
              style={{
                margin: 0,
                fontSize: 14,
                fontWeight: 600,
                color: T.fg,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {l.value}
            </dd>
          </div>
        ))}
      </dl>
      <div style={{ padding: '12px 0 10px' }}>
        <a href="/expert/settings?tab=payouts" onClick={preventNav} style={footerLink}>
          View payouts
          <ArrowRight size={12} aria-hidden="true" />
        </a>
      </div>
    </section>
  );
}

function TopClientsCard() {
  return (
    <section aria-labelledby="top-clients-heading" style={{ ...card, paddingBottom: 18 }}>
      <h2 id="top-clients-heading" style={{ ...cardTitle, fontSize: 15 }}>
        Top clients
      </h2>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
        <span
          aria-hidden="true"
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            background: T.violetSoft,
            color: T.violet,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Users size={17} />
        </span>
        <span style={{ fontSize: 13, color: T.muted }}>Will appear after your first session</span>
      </div>
    </section>
  );
}

function WalletCard() {
  return (
    <section aria-labelledby="wallet-heading" style={{ ...card, paddingBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Wallet size={16} color={T.muted} aria-hidden="true" />
        <h2 id="wallet-heading" style={{ ...cardTitle, fontSize: 15 }}>
          Credit balance
        </h2>
      </div>
      <p
        style={{
          margin: '10px 0 2px',
          fontSize: 26,
          fontWeight: 600,
          color: T.fg,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        A$1,250.00
      </p>
      <p style={{ margin: '0 0 14px', fontSize: 12.5, color: T.muted }}>
        Shipped wallet card, unchanged.
      </p>
      <ButtonLink href="/settings/billing" onClick={preventNav}>
        Top up
      </ButtonLink>
    </section>
  );
}

// ─── One-time go-live card + live status badge ───────────────────────────────────────

function CelebrationCard({ mobile }) {
  const dots = ['#2563EB', '#7C3AED', '#059669', '#D97706', '#DB2777', '#0891B2'];
  return (
    <section
      aria-label="You're live on the marketplace"
      style={{
        ...card,
        position: 'relative',
        overflow: 'hidden',
        textAlign: 'center',
        padding: mobile ? '32px 20px' : '40px 32px',
      }}
    >
      {dots.map((c, i) => (
        <span
          key={c}
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: `${12 + i * 14}%`,
            top: `${18 + (i % 3) * 14}%`,
            width: 7,
            height: 7,
            borderRadius: i % 2 ? 2 : '50%',
            background: c,
            opacity: 0.7,
          }}
        />
      ))}
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <span
          aria-hidden="true"
          style={{
            width: 68,
            height: 68,
            borderRadius: '50%',
            background: 'linear-gradient(90deg,#10B981,#06B6D4)',
            boxShadow: '0 8px 32px rgba(5,150,105,0.3)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
          }}
        >
          <Zap size={28} />
        </span>
      </div>
      <h3 style={{ margin: '18px 0 0', fontSize: 20, fontWeight: 600, color: T.fg }}>
        You're live on the marketplace!
      </h3>
      <p style={{ margin: '8px 0 0', fontSize: 14, color: T.muted }}>
        Clients can now find and book you. Time to land your first consultation.
      </p>
      <div style={{ marginTop: 22 }}>
        <a
          href="/experts/charles-akintunde"
          onClick={preventNav}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 38,
            padding: '0 16px',
            borderRadius: 8,
            color: '#fff',
            fontSize: 14,
            fontWeight: 600,
            textDecoration: 'none',
            background: 'linear-gradient(135deg,#059669,#0891B2)',
          }}
        >
          View your public profile
          <ExternalLink size={14} aria-hidden="true" />
        </a>
      </div>
      <p style={{ margin: '14px 0 0', fontSize: 12, color: T.subtle }}>
        From now on, your status lives in the sidebar.
      </p>
    </section>
  );
}

function Avatar({ initials, status }) {
  return (
    <span style={{ position: 'relative', width: 36, height: 36, flexShrink: 0 }}>
      <span
        style={{
          width: 36,
          height: 36,
          borderRadius: '50%',
          background: '#CBD5E1',
          color: T.fg,
          fontSize: 12.5,
          fontWeight: 600,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {initials}
      </span>
      {status && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            right: -1,
            bottom: -1,
            width: 11,
            height: 11,
            borderRadius: '50%',
            background: LIVE_STATES[status].dot,
            boxShadow: `0 0 0 2px ${T.sidebar}`,
          }}
        />
      )}
    </span>
  );
}

function LiveStatus({ state }) {
  const [open, setOpen] = useState(false);
  const s = LIVE_STATES[state];
  return (
    <div style={{ position: 'relative', margin: '4px 0 0 46px' }}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-live-state={state}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 24,
          padding: '0 9px',
          borderRadius: 999,
          border: 'none',
          background: s.pillBg,
          color: s.pillFg,
          fontSize: 12,
          fontWeight: 600,
          fontFamily: 'inherit',
          cursor: 'pointer',
        }}
      >
        <span
          aria-hidden="true"
          style={{ width: 7, height: 7, borderRadius: '50%', background: s.dot }}
        />
        {s.pill}
      </button>
      {open && (
        <>
          <div
            aria-hidden="true"
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 20 }}
          />
          <div
            role="dialog"
            aria-label={s.title}
            style={{
              position: 'absolute',
              top: 30,
              left: 0,
              zIndex: 21,
              width: 272,
              background: T.card,
              border: `1px solid ${T.border}`,
              borderRadius: 12,
              boxShadow: '0 12px 32px rgba(15,23,42,0.14)',
              padding: 14,
            }}
          >
            <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: T.fg }}>{s.title}</p>
            <p style={{ margin: '4px 0 12px', fontSize: 13, lineHeight: 1.45, color: T.muted }}>
              {s.body}
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {s.primary && (
                <ButtonLink
                  href="/expert/settings?tab=schedule"
                  onClick={preventNav}
                  variant="solid"
                >
                  {s.primary}
                </ButtonLink>
              )}
              {state !== 'not_listed' && (
                <ButtonLink href="/experts/charles-akintunde" onClick={preventNav}>
                  View public profile
                  <ExternalLink size={13} aria-hidden="true" />
                </ButtonLink>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Shell ───────────────────────────────────────────────────────────────────────────

const NAV = {
  expert: {
    top: [
      { label: 'Dashboard', icon: LayoutGrid, active: true },
      { label: 'Cases', icon: Video },
      { label: 'Projects', icon: FolderKanban },
      { label: 'Calendar', icon: Calendar },
      { label: 'Messages', icon: MessageSquare },
    ],
    bottom: [
      { label: 'Expert Settings', icon: Settings },
      { label: 'Account', icon: User },
      { label: 'Help', icon: LifeBuoy },
    ],
  },
  client: {
    top: [
      { label: 'Dashboard', icon: LayoutGrid, active: true },
      { label: 'Cases', icon: Video },
      { label: 'Projects', icon: Briefcase },
      { label: 'Messages', icon: MessageSquare },
    ],
    bottom: [
      { label: 'Settings', icon: Settings },
      { label: 'Account', icon: User },
      { label: 'Help', icon: LifeBuoy },
    ],
  },
};

function NavItem({ item }) {
  const Icon = item.icon;
  return (
    <a
      href="#"
      onClick={preventNav}
      aria-current={item.active ? 'page' : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        height: 40,
        padding: '0 12px',
        borderRadius: 10,
        fontSize: 14,
        fontWeight: item.active ? 600 : 500,
        textDecoration: 'none',
        color: item.active ? T.primary : T.fg,
        background: item.active ? T.primarySoft : 'transparent',
      }}
    >
      <Icon size={18} aria-hidden="true" />
      {item.label}
    </a>
  );
}

function Sidebar({ lens, live }) {
  const c = COPY[lens];
  return (
    <aside
      style={{
        width: 248,
        flexShrink: 0,
        background: T.sidebar,
        borderRight: `1px solid ${T.border}`,
        display: 'flex',
        flexDirection: 'column',
        padding: '18px 12px 12px',
      }}
    >
      <div
        style={{
          fontSize: 26,
          fontWeight: 700,
          letterSpacing: '-0.04em',
          color: '#3730A3',
          padding: '0 8px 16px',
        }}
      >
        balo
      </div>
      <div
        style={{ borderBottom: `1px solid ${T.border}`, padding: '0 4px 14px', marginBottom: 12 }}
      >
        <button
          type="button"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            width: '100%',
            background: 'none',
            border: 'none',
            padding: 4,
            borderRadius: 8,
            cursor: 'pointer',
            textAlign: 'left',
            fontFamily: 'inherit',
          }}
        >
          <Avatar initials={c.initials} status={lens === 'expert' ? live : null} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: T.fg }}>
              {c.switcherTitle}
            </span>
            <span style={{ display: 'block', fontSize: 12.5, color: T.muted }}>
              {c.switcherSub}
            </span>
          </span>
          <ChevronsUpDown size={15} color={T.muted} aria-hidden="true" />
        </button>
        {lens === 'expert' && live && <LiveStatus key={live} state={live} />}
      </div>
      <nav aria-label="Main" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {NAV[lens].top.map((item) => (
          <NavItem key={item.label} item={item} />
        ))}
      </nav>
      <div
        style={{
          marginTop: 'auto',
          borderTop: `1px solid ${T.border}`,
          paddingTop: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        {NAV[lens].bottom.map((item) => (
          <NavItem key={item.label} item={item} />
        ))}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 12px 0',
            fontSize: 13,
            color: T.muted,
          }}
        >
          <PanelLeftClose size={16} aria-hidden="true" />
          Collapse
        </div>
      </div>
    </aside>
  );
}

function MobileTopBar({ lens, live }) {
  return (
    <header
      style={{
        height: 56,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 14px',
        background: T.card,
        borderBottom: `1px solid ${T.border}`,
      }}
    >
      <button
        type="button"
        aria-label="Open menu"
        style={{
          width: 40,
          height: 40,
          border: 'none',
          background: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: T.fg,
        }}
      >
        <Menu size={20} />
      </button>
      <span
        style={{
          flex: 1,
          fontSize: 22,
          fontWeight: 700,
          letterSpacing: '-0.04em',
          color: '#3730A3',
        }}
      >
        balo
      </span>
      <Avatar initials={COPY[lens].initials} status={lens === 'expert' ? live : null} />
    </header>
  );
}

// ─── Dashboard ───────────────────────────────────────────────────────────────────────

export function DashboardPreview({ lens, scenario, viewport }) {
  const data = scenarioData(lens, scenario);
  const mobile = viewport === 'mobile';
  const c = COPY[lens];
  const side =
    lens === 'expert' ? (
      <>
        <EarningsCard earnings={data.earnings} />
        <TopClientsCard />
      </>
    ) : (
      <WalletCard />
    );

  return (
    <div
      style={{
        fontFamily: T.font,
        color: T.fg,
        background: T.bg,
        display: 'flex',
        flexDirection: mobile ? 'column' : 'row',
        width: mobile ? 390 : '100%',
        maxWidth: mobile ? 390 : 1280,
        minHeight: 760,
        margin: '0 auto',
        border: `1px solid ${T.border}`,
        borderRadius: mobile ? 28 : 14,
        overflow: 'hidden',
        boxShadow: '0 10px 40px rgba(15,23,42,0.10)',
      }}
    >
      {mobile ? (
        <MobileTopBar lens={lens} live={data.live} />
      ) : (
        <Sidebar lens={lens} live={data.live} />
      )}
      <main style={{ flex: 1, minWidth: 0, padding: mobile ? '20px 14px 28px' : '28px 32px 40px' }}>
        {!mobile && (
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: T.fg,
              borderBottom: `1px solid ${T.border}`,
              margin: '-28px -32px 24px',
              padding: '16px 32px',
            }}
          >
            Dashboard
          </div>
        )}
        <div
          style={{
            maxWidth: 1040,
            margin: '0 auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <div style={{ marginBottom: 4 }}>
            <h1
              style={{
                margin: 0,
                fontSize: mobile ? 21 : 24,
                fontWeight: 600,
                color: T.fg,
                letterSpacing: '-0.01em',
              }}
            >
              Welcome back, {c.firstName}
            </h1>
            <p style={{ margin: '4px 0 0', fontSize: 14, color: T.muted }}>{c.headerSub}</p>
          </div>
          {data.celebrate && <CelebrationCard mobile={mobile} />}
          <YourMove key={`${lens}-${scenario}`} rows={data.rows} mobile={mobile} />
          <Pipeline lens={lens} stages={data.pipeline} mobile={mobile} />
          {mobile ? (
            <>
              <UpNextCard lens={lens} rows={data.upNext} />
              {side}
            </>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)',
                gap: 16,
                alignItems: 'start',
              }}
            >
              <UpNextCard lens={lens} rows={data.upNext} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>{side}</div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// ─── Build notes ─────────────────────────────────────────────────────────────────────

const ROW_SPECS = {
  expert: [
    [
      'Calendar',
      '`checklistStatus.calendarNeedsReconnect`',
      'Connection healthy again',
      'Reconnect calendar → expert calendar settings',
    ],
    [
      'Project cards (all six below)',
      'A `loadExpertPortfolio` row with `needsYou = true`. The branch of `needsYouForExpert` / `deriveEngagementRow` that fired picks the card kind',
      'The rule stops returning `needsYou`',
      'The row’s own `href`',
    ],
    [
      'Project invitation',
      'Relationship `invited`',
      'EOI submitted, track declined, or expert removed',
      'Review invitation',
    ],
    [
      'Interest sent',
      'Relationship `eoi_submitted` (the inbox’s “Propose times” / “Reply to client”). Action becomes “Reply” when a reply is owed',
      'Proposal requested or track declined',
      'Propose times',
    ],
    [
      'Proposal requested',
      'Relationship `proposal_requested`. A current `draft` proposal makes the action “Finish proposal”',
      'Proposal submitted',
      'Write proposal',
    ],
    [
      'Proposal changes',
      'NEW RULE BRANCH: relationship `proposal_submitted` and current proposal `changes_requested`',
      'New version submitted',
      'Revise proposal',
    ],
    [
      'Kickoff',
      'Relationship and request `accepted`, AND (rule fix) `expert_terms_confirmed_at IS NULL`',
      'Terms confirmed',
      'Confirm terms',
    ],
    [
      'Delivery changes',
      'Engagement `active` with a change request (`deriveEngagementRow`)',
      'Change request cleared',
      'Open project',
    ],
    [
      'Action items',
      'Open, live `action_items` with `assignee_party = expert` on the expert’s own engagements; ONE card per engagement. Overdue when `due_at < now`',
      'All done',
      'View items → owning case or project',
    ],
    [
      'Messages',
      'Unread conversations for the viewer, EXCLUDING threads whose project already has a card; ONE aggregate card',
      'All read',
      'Open messages → /messages',
    ],
  ],
  client: [
    [
      'Billing',
      'Open `credit_receivables` for the company; billing capability only',
      'Cleared',
      'Settle balance → /settings/billing',
    ],
    [
      'New times suggested',
      '`reschedule_proposals` pending and not lazily expired (`deriveRescheduleProposalState`) on the company’s cases. Deadline from `expires_at`',
      'Accepted, declined, withdrawn or expired',
      'Choose a time → case page',
    ],
    [
      'Project cards (all five below)',
      'A `loadClientPortfolio` row with `needsYou = true` (`needsYouFor`, client lens, and `deriveEngagementRow`)',
      'The rule stops returning `needsYou`',
      'The row’s own `href`',
    ],
    ['Exploratory call', 'Request `exploratory_meeting_requested`', 'Call booked', 'Book a call'],
    [
      'In conversation',
      'Request `eoi_submitted` with an unread or unanswered thread',
      'Replied and read',
      'Reply',
    ],
    [
      'Proposal to review',
      'Request `proposal_submitted` (“Review N proposals” when more than one)',
      'Accepted, declined or changes requested',
      'Review proposal',
    ],
    [
      'Kickoff',
      'Request `accepted`, `client_billing_confirmed_at IS NULL`',
      'Billing confirmed',
      'Confirm billing',
    ],
    [
      'Work to review',
      'Engagement `pending_acceptance`; the auto-accept date is a fact, not a countdown',
      'Accepted by the client or the auto-accept sweep',
      'Review work',
    ],
    [
      'Team',
      'Pending `party_join_requests` for the company; membership-admin capability only',
      'Approved, declined or withdrawn',
      'Review requests → team settings',
    ],
    [
      'Action items',
      'As expert, with `assignee_party = client`',
      'All done',
      'View items → owning case or project',
    ],
    [
      'Messages',
      'As expert, excluding threads already on a project card',
      'All read',
      'Open messages → /messages',
    ],
  ],
};

const BADGE_RULES = [
  'State, first match wins: Not listed (`expert_profiles.searchable = false`; the public profile 404s, so the popover offers no profile link) → Not taking work (`available_for_work = false`, BAL-591; still searchable) → Bookings paused (searchable, `calendarNeedsReconnect`, AND the broken connection is conflict-checked: the same `checkedForBusyTime` branch the calendar settings notice uses) → Live. Read through `expertSearchabilityRepository.loadInputs`; never a second derivation.',
  '“Not taking work” reuses BAL-591’s vocabulary and slate motif (`expert-availability-paused.jsx`). Its action opens the Schedule tab, where the switch lives.',
  'Hidden until the setup checklist is complete; the checklist owns that period.',
  'Desktop: a pill under the workspace switcher, outside it (the switcher is a button). Collapsed sidebar and mobile top bar: the dot on the avatar. The mobile drawer shows the pill.',
  'The popover is the permanent home for “View public profile”. The shipped celebration card renders that button `disabled`, so this is its first working link.',
];

const CELEBRATION_RULES = [
  'Renders while `checklistStatus.allComplete` and a new nullable `expert_profiles.live_celebration_seen_at` is NULL.',
  'Stamped by a server action fired from a client effect after the card mounts, only if NULL. Never stamped during server render: a Link prefetch of /dashboard renders the RSC payload and would retire the card unseen.',
  'Copy unchanged. The button is enabled and opens the public profile. One added line points to the sidebar status.',
];

const CONTEXT_SPECS = {
  expert: [
    [
      'All project cards',
      'The row’s `PortfolioRowView` fields (title, company, stage, `updatedRelative`, `progressLabel`, `signal`) plus ONE batched enrichment read over the needs-you request ids only. No per-card query.',
    ],
    [
      'Project invitation',
      'Plain-text excerpt of `project_requests.description` (sanitised HTML → text, 3 lines); tags from `project_request_products` and `project_request_tags`; the free-text `timeline`. NO budget: the expert lens must never see a client-side money figure (fee concealment).',
    ],
    [
      'Proposal requested',
      '`updated_at` of the current `draft` proposal as “Draft saved …”, else “Not started yet”.',
    ],
    [
      'Interest sent',
      'One sentence prompting the expert to share availability; when a reply is owed, the row’s `signal` preview instead.',
    ],
    [
      'Proposal changes',
      'Latest `proposal_change_requests.note` (plain text, 3 lines) and the `section`s raised against the current version.',
    ],
    [
      'Kickoff',
      'Three gates: `client_billing_confirmed_at`, `expert_terms_confirmed_at`, and Balo approval (done ⟺ request `kickoff_approved`). The viewer’s gate is the highlighted one.',
    ],
    [
      'Action items',
      'First two open items’ `body`, overdue first (`due_at < now`); “N more” for the rest.',
    ],
    [
      'Delivery changes',
      'The engagement’s `change_request_note` (plain text, 3 lines) and `progressLabel`.',
    ],
    [
      'Messages',
      'Latest unread message excerpt. The sender shows as the counterparty label: the company on the expert lens.',
    ],
    ['Calendar', 'One sentence of consequence, matching the live status badge’s state.'],
  ],
  client: [
    ['Billing', 'One sentence of consequence. No amount.'],
    [
      'New times suggested',
      'The original time (struck through) and the proposal’s options. Each option opens the case page; choosing happens there.',
    ],
    [
      'Work to review',
      'Completed vs total `engagement_milestones`, plus the auto-accept date as a fact.',
    ],
    ['Kickoff', 'Same three gates, from the client’s side.'],
    ['Exploratory call', 'One sentence explaining why Balo wants the call.'],
    ['In conversation', 'The row’s `signal` preview (sender and message).'],
    [
      'Proposal to review',
      '`version`, `timeframe_weeks` as “About N weeks”, milestone count. No price on the card.',
    ],
    ['Team', 'Each requester’s name and email.'],
    ['Action items, Messages', 'As expert lens.'],
  ],
};

const TURN_RULE =
  'Every token is a Projects inbox row (`loadExpertPortfolio` / `loadClientPortfolio`), grouped by its `stage`. Turn: `needsYou` → Your move; an engagement row with nudge “In delivery” → In progress; anything else → Waiting. Closed requests (`closedRows`) and completed or cancelled engagements are not on the track.';

const TURN_SPECS = {
  expert: [
    ['Invited', '`invited`'],
    ['Interest sent', '`eoi`'],
    ['Proposal', '`prop_req`, `prop_in`'],
    ['Kickoff', '`accepted`'],
    ['Delivery', 'engagement rows (`kind = engagement`)'],
  ],
  client: [
    ['Matching', '`requested`, `exploratory`, `invited`'],
    ['Interest', '`eoi`'],
    ['Proposals', '`prop_req`, `prop_in`'],
    ['Kickoff', '`accepted`'],
    ['Delivery', 'engagement rows (`kind = engagement`)'],
  ],
};

const RULES_V2 = [
  'A card exists while someone is waiting on the viewer. Cards come from record state, never from `user_notifications`: reading or clearing a notification never removes a card.',
  'One read model, one arm per card kind. Each arm starts from parent records the viewer can already open, gates with `hasCapability`, and only then joins children. A card never links to a page the viewer can’t open.',
  'Order: `sortAttentionRows`. Tier first (blocks bookings or money, then replies owed, then work owed); inside a tier, cards with a deadline first, soonest first; then oldest waiting first; ties by id.',
  'The Calendar card replaces `CalendarDisconnectedBanner` on the dashboard, so there is one place to act.',
  'Every card is in the rail; nothing hides behind a cap. Chips filter by type and only appear when there is more than one type. Desktop arrows scroll one card; mobile swipes with snap.',
  'In “All”, the first card is wider and carries the solid button. Blockers always have a solid button and a warning band. Every other card’s button is outline.',
  'Card context is read-only. No Accept, Decline or Confirm on a card: the action opens the owning page.',
  'No money anywhere in the rail or the track, either lens: no budget, no price, no balance.',
  'Counterparty: expert lens shows the client company, never a person; client lens shows the expert with the agency as the org line.',
  'The track is the Projects inbox, grouped by stage: no new repository read. Projects only; cases live in Up next and on Cases.',
  'The rail and the track must agree: every project card has a “Your move” token linking to the same page, and every “Your move” token has a card. Pinned by a test against this reference.',
  'Empty rail: one line, “Nothing’s waiting on you”, and the track stays, so the expert still sees whose move everything else is.',
];

function NotesPanel({ lens }) {
  const th = {
    textAlign: 'left',
    fontSize: 12,
    fontWeight: 600,
    color: T.muted,
    padding: '8px 10px',
    borderBottom: `1px solid ${T.border}`,
  };
  const td = {
    fontSize: 12.5,
    lineHeight: 1.45,
    color: T.fg,
    padding: '9px 10px',
    borderBottom: `1px solid ${T.border}`,
    verticalAlign: 'top',
  };
  return (
    <section
      aria-label="Build notes"
      style={{
        maxWidth: 1280,
        margin: '24px auto 0',
        background: T.card,
        border: `1px solid ${T.border}`,
        borderRadius: 14,
        padding: '18px 20px 22px',
        fontFamily: T.font,
        color: T.fg,
      }}
    >
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Build notes, {lens} lens</h2>
      <ul style={{ margin: '12px 0 0', paddingLeft: 18 }}>
        {RULES_V2.map((r) => (
          <li key={r} style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 4 }}>
            {r}
          </li>
        ))}
      </ul>
      <h3 style={{ margin: '20px 0 8px', fontSize: 14, fontWeight: 600 }}>Cards</h3>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
          <thead>
            <tr>
              <th style={th}>Card</th>
              <th style={th}>Shows while</th>
              <th style={th}>Leaves when</th>
              <th style={th}>Action</th>
            </tr>
          </thead>
          <tbody>
            {ROW_SPECS[lens].map(([k, when, leaves, action]) => (
              <tr key={k}>
                <td style={{ ...td, fontWeight: 600, whiteSpace: 'nowrap' }}>{k}</td>
                <td style={td}>{when}</td>
                <td style={td}>{leaves}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 style={{ margin: '20px 0 8px', fontSize: 14, fontWeight: 600 }}>Card context</h3>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
          <thead>
            <tr>
              <th style={th}>Card</th>
              <th style={th}>Shows</th>
            </tr>
          </thead>
          <tbody>
            {CONTEXT_SPECS[lens].map(([k, v]) => (
              <tr key={k}>
                <td style={{ ...td, fontWeight: 600, whiteSpace: 'nowrap' }}>{k}</td>
                <td style={td}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 style={{ margin: '20px 0 8px', fontSize: 14, fontWeight: 600 }}>Whose move, by stage</h3>
      <p style={{ margin: '0 0 8px', fontSize: 13, lineHeight: 1.5 }}>{TURN_RULE}</p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 480 }}>
          <thead>
            <tr>
              <th style={th}>Track stage</th>
              <th style={th}>Inbox `StageKey`s</th>
            </tr>
          </thead>
          <tbody>
            {TURN_SPECS[lens].map(([stage, keys]) => (
              <tr key={stage}>
                <td style={{ ...td, fontWeight: 600, whiteSpace: 'nowrap' }}>{stage}</td>
                <td style={td}>{keys}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {lens === 'expert' && (
        <>
          <h3 style={{ margin: '20px 0 8px', fontSize: 14, fontWeight: 600 }}>Live status badge</h3>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {BADGE_RULES.map((r) => (
              <li key={r} style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 4 }}>
                {r}
              </li>
            ))}
          </ul>
          <h3 style={{ margin: '20px 0 8px', fontSize: 14, fontWeight: 600 }}>
            One-time go-live card
          </h3>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {CELEBRATION_RULES.map((r) => (
              <li key={r} style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 4 }}>
                {r}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// ─── Toolbar + app ───────────────────────────────────────────────────────────────────

function Segmented({ label, value, options, onChange }) {
  return (
    <div
      role="group"
      aria-label={label}
      style={{
        display: 'inline-flex',
        background: '#fff',
        border: `1px solid ${T.border}`,
        borderRadius: 10,
        padding: 3,
        gap: 2,
      }}
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          style={{
            height: 30,
            padding: '0 12px',
            borderRadius: 7,
            border: 'none',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 13,
            fontWeight: 600,
            background: value === o.id ? T.fg : 'transparent',
            color: value === o.id ? '#fff' : T.muted,
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function DashboardAttentionReference() {
  const [lens, setLens] = useState('expert');
  const [scenario, setScenario] = useState('busy');
  const [viewport, setViewport] = useState('desktop');
  const [notes, setNotes] = useState(true);

  useEffect(() => {
    const id = 'geist-font';
    if (document.getElementById(id)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap';
    document.head.appendChild(link);
  }, []);

  return (
    <div
      style={{ minHeight: '100vh', background: T.page, padding: '0 16px 40px', fontFamily: T.font }}
    >
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 30,
          background: T.page,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 10,
          padding: '14px 0',
          maxWidth: 1280,
          margin: '0 auto',
        }}
      >
        <Segmented
          label="Lens"
          value={lens}
          onChange={(next) => {
            setLens(next);
            setScenario('busy');
          }}
          options={[
            { id: 'expert', label: 'Expert' },
            { id: 'client', label: 'Client' },
          ]}
        />
        <Segmented
          label="Scenario"
          value={scenario}
          onChange={setScenario}
          options={SCENARIOS[lens]}
        />
        <Segmented
          label="Viewport"
          value={viewport}
          onChange={setViewport}
          options={[
            { id: 'desktop', label: 'Desktop' },
            { id: 'mobile', label: 'Mobile' },
          ]}
        />
        <button
          type="button"
          aria-pressed={notes}
          onClick={() => setNotes((v) => !v)}
          style={{
            height: 36,
            padding: '0 12px',
            borderRadius: 10,
            border: `1px solid ${T.border}`,
            background: notes ? T.fg : '#fff',
            color: notes ? '#fff' : T.muted,
            fontFamily: 'inherit',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Build notes
        </button>
      </div>
      <DashboardPreview
        key={`${lens}-${scenario}-${viewport}`}
        lens={lens}
        scenario={scenario}
        viewport={viewport}
      />
      {notes && <NotesPanel lens={lens} />}
    </div>
  );
}
