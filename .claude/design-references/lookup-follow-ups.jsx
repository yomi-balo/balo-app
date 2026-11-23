import { useState } from 'react';

// ═══════════════════════════════════════════════════════════════════
// (unfiled) — BALO ADMIN: LOOKUP · FOLLOW-UPS TAB
// Route: /(dashboard)/admin/lookup  ·  a third drill-in tab beside Timeline
// and Money. Policy: ADR-1060 (reminder sequences). Builds on the shipped
// Lookup (BAL-551) and the admin-home.jsx reference it came from.
//
// PURPOSE — let support answer one question without opening a log:
//   "Did they get the follow-up, and if not, why?"
//
// DECISIONS THIS PROTOTYPE ENCODES
//   · A TAB, NOT TIMELINE ROWS. Timeline is the audit_events stream: every
//     row there was written by a person's action. A follow-up is a system
//     send with no actor, recorded in scheduled_notifications. Mixing the two
//     would blur what Timeline promises.
//   · WHERE IT SHOWS. Users and experts: follow-ups sent TO them. Project
//     requests and engagements: follow-ups ABOUT them. Hidden on companies,
//     agencies and credit sessions.
//   · ONE BLOCK PER WAIT. A wait is one thing waiting on one person since one
//     moment (sequence × entity × recipient × anchor — the dedupe key minus
//     the step). The block says what is waiting, on whom, and since when.
//     Ages are facts ("waiting since Mon 16 Nov"), never countdowns.
//   · COLLAPSED BY DEFAULT. A person can have several waits, so each block
//     opens on a click. Closed, it shows one mark per follow-up and the same
//     facts in words: filled circle = sent, ring = due, ring with a dash =
//     not sent, red triangle = failed. Shape carries the meaning; colour only
//     repeats it. A lone wait opens itself. Expand all is one click.
//   · THREE WAIT STATES: Waiting · Still waiting, follow-ups finished · No
//     longer waiting. The middle one is the hand-off: nothing more is sent,
//     so a person may need to step in.
//   · FOUR STEP STATES: Sent · Due · Not sent · Failed. "Not sent" is a
//     neutral fact, not an error: the stop rule or the daily limit did its
//     job. Only Failed is red.
//   · THE REASON IS A SENTENCE, THE CODE IS SMALL PRINT. Support reads the
//     sentence; engineering reads the code. The Wording view lists every
//     pair so MJ can sign the sentences off in one place.
//   · A HELD STEP SAYS SO. When a step fell due on a weekend and went out on
//     Monday, the row says it. "Why did it arrive Monday?" is a support
//     question.
//   · THE DAILY LIMIT IS VISIBLE on a person: "2 of 2 in the last 24 hours".
//     It explains a Not sent row before anyone asks. Deadline warnings are
//     marked as not counted.
//   · READ-ONLY. No resend, no pause. Open goes to the thing itself.
//   · STATES: loaded · loading · error · empty, from the control bar.
//   · COPY: gender-neutral; a person is named "@ company" on first mention.
//
// WHAT THE BUILD NEEDS (for the ticket)
//   · Sent / Not sent / Failed come from scheduled_notifications rows.
//   · Due rows are NOT stored: they are worked out from the sequence's step
//     table, so that table must be readable from apps/web (packages/shared).
//   · Times are shown in the recipient's own time zone.
//   · Rows skipped as `already_decided` are bookkeeping and stay hidden.
//
// OPEN QUESTIONS
//   · Should "Still waiting, follow-ups finished" raise a row on admin Home?
//   · How far back does Earlier go? Drawn as 90 days.
//
// NOT IN THIS PROTOTYPE: the future config page for step timings; per-sequence
// totals; any control (resend, pause, mute).
// ═══════════════════════════════════════════════════════════════════

const c = {
  bg: '#F8FAFB',
  surface: '#FFFFFF',
  surfaceSubtle: '#F1F4F8',
  border: '#E0E4EB',
  borderSubtle: '#EAEFF5',
  text: '#111827',
  textSecondary: '#4B5563',
  textTertiary: '#9CA3AF',
  primary: '#2563EB',
  primaryLight: '#EFF6FF',
  primaryBorder: '#BFDBFE',
  success: '#059669',
  successLight: '#ECFDF5',
  warning: '#D97706',
  warningLight: '#FFFBEB',
  warningBorder: '#FDE68A',
  error: '#DC2626',
  errorLight: '#FEF2F2',
  errorBorder: '#FECACA',
};

// ── Icons (Lucide paths; matches the design-reference convention) ──
const Icon = ({ d, size = 16, color = 'currentColor', style: xs }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={xs}
  >
    <path d={d} />
  </svg>
);
const Multi = ({ children, size = 16, color = 'currentColor', style: xs }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={xs}
  >
    {children}
  </svg>
);
const I = {
  check: (p) => <Icon {...p} d="M20 6L9 17l-5-5" />,
  chevRight: (p) => <Icon {...p} d="M9 18l6-6-6-6" />,
  clock: (p) => (
    <Multi {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </Multi>
  ),
  minusCircle: (p) => (
    <Multi {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M8 12h8" />
    </Multi>
  ),
  alertTriangle: (p) => (
    <Multi {...p}>
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </Multi>
  ),
  alertCircle: (p) => (
    <Multi {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4M12 16h.01" />
    </Multi>
  ),
  user: (p) => (
    <Multi {...p}>
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </Multi>
  ),
  fileText: (p) => (
    <Multi {...p}>
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
    </Multi>
  ),
  externalLink: (p) => (
    <Multi {...p}>
      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
      <path d="M15 3h6v6M10 14L21 3" />
    </Multi>
  ),
  inbox: (p) => (
    <Multi {...p}>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" />
    </Multi>
  ),
  rotate: (p) => (
    <Multi {...p}>
      <path d="M23 4v6h-6M1 20v-6h6" />
      <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
    </Multi>
  ),
};

const keyframes = `
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes shimmer { 0% { background-position: -420px 0; } 100% { background-position: 420px 0; } }
.balo-focus:focus-visible { outline: 2px solid #2563EB; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { * { animation-duration: 0.001s !important; transition-duration: 0.001s !important; } }
`;
const fadeIn = (d = 0) => ({ animation: `fadeIn 0.35s ease-out ${d}s both` });
const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

// ── Primitives. Cards are flat: a border, no shadow. ──
function Card({ children, style: xs }) {
  return (
    <div
      style={{
        background: c.surface,
        borderRadius: 16,
        border: `1px solid ${c.border}`,
        ...xs,
      }}
    >
      {children}
    </div>
  );
}
function Pill({ children, color = c.textSecondary, bg = c.surfaceSubtle, border, small }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: small ? '2px 8px' : '3px 10px',
        borderRadius: 20,
        fontSize: small ? 11 : 12,
        fontWeight: 600,
        color,
        background: bg,
        border: border ? `1px solid ${border}` : 'none',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}
const TextLink = ({ children, icon: IC, color = c.primary, onClick }) => (
  <button
    className="balo-focus"
    onClick={onClick}
    style={{
      border: 'none',
      background: 'transparent',
      cursor: 'pointer',
      fontSize: 12,
      fontWeight: 600,
      color,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: 0,
    }}
  >
    {IC && <IC size={12} color={color} />}
    {children}
  </button>
);
function SectionLabel({ children, right }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        margin: '0 0 10px',
      }}
    >
      <p
        style={{
          fontSize: 12,
          fontWeight: 700,
          color: c.textTertiary,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          margin: 0,
        }}
      >
        {children}
      </p>
      {right}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// THE WORDING — what staff read for each state and reason. The code is the
// value stored in scheduled_notifications.skip_reason (or the row's status).
// ═══════════════════════════════════════════════════════════════════
const STEP_STATE = {
  sent: { label: 'Sent', icon: I.check, color: c.success, bg: c.successLight },
  due: { label: 'Due', icon: I.clock, color: c.textSecondary, bg: c.surfaceSubtle },
  not_sent: { label: 'Not sent', icon: I.minusCircle, color: c.textSecondary, bg: c.surfaceSubtle },
  failed: { label: 'Failed', icon: I.alertTriangle, color: c.error, bg: c.errorLight },
};
const WAIT_STATE = {
  waiting: { label: 'Waiting', color: c.primary, bg: c.primaryLight, border: c.primaryBorder },
  finished: {
    label: 'Still waiting · follow-ups finished',
    color: c.warning,
    bg: c.warningLight,
    border: c.warningBorder,
  },
  stopped: { label: 'No longer waiting', color: c.textSecondary, bg: c.surfaceSubtle },
};
// `who` is the recipient's first name. Each sentence must stand alone.
const REASON = {
  no_longer_waiting: {
    state: 'not_sent',
    say: () => 'It was no longer waiting by then.',
    when: 'The thing was dealt with before this step came due.',
  },
  over_daily_limit: {
    state: 'not_sent',
    say: (who) => `${who} had already had two follow-up emails in 24 hours.`,
    when: 'The daily limit was reached. The step is skipped, not queued.',
  },
  recipient_gone: {
    state: 'not_sent',
    say: (who) => `${who} was no longer the person this was waiting on.`,
    when: 'They left the company, or the request changed hands.',
  },
  anchor_moved: {
    state: 'not_sent',
    say: () => 'The wait started again, so a new series began.',
    when: 'For example, a proposal was resubmitted.',
  },
  send_failed: {
    state: 'failed',
    // Not a skip reason: the row's status is `failed` and last_error holds the cause.
    code: 'status = failed',
    say: () => 'It could not be sent after 3 attempts.',
    when: 'A terminal failure. It is also raised on admin Home.',
  },
};

// ═══════════════════════════════════════════════════════════════════
// MOCK DATA — "now" is Mon 23 Nov 2026, 2:15 pm.
// ═══════════════════════════════════════════════════════════════════
const sent = (n, offset, when, extra = {}) => ({ n, offset, status: 'sent', when, ...extra });
const due = (n, offset, when, extra = {}) => ({ n, offset, status: 'due', when, ...extra });
const skip = (n, offset, when, reason, extra = {}) => ({
  n,
  offset,
  status: REASON[reason].state,
  when,
  reason,
  ...extra,
});

const W = {
  cpq: {
    id: 'cpq',
    title: 'Proposals to review',
    about: 'Salesforce CPQ rollout',
    aboutType: 'Project request',
    who: 'Dana Whitfield',
    first: 'Dana',
    party: 'Northwind Industrial',
    fact: '2 proposals',
    since: 'waiting since Mon 16 Nov',
    state: 'waiting',
    steps: [
      sent(1, '2 days after', 'Wed 18 Nov, 9:00 am'),
      sent(2, '5 days after', 'Mon 23 Nov, 9:00 am', {
        held: 'Fell due on Saturday. Held to Monday morning.',
      }),
      due(3, '9 days after', 'Wed 25 Nov, 9:00 am'),
    ],
  },
  health: {
    id: 'health',
    title: 'Proposals to review',
    about: 'Service Cloud health check',
    aboutType: 'Project request',
    who: 'Dana Whitfield',
    first: 'Dana',
    party: 'Northwind Industrial',
    fact: '1 proposal',
    since: 'waiting since Thu 19 Nov',
    state: 'waiting',
    steps: [
      sent(1, '2 days after', 'Mon 23 Nov, 9:00 am', {
        held: 'Fell due on Saturday. Held to Monday morning.',
      }),
      due(2, '5 days after', 'Tue 24 Nov, 9:00 am'),
      due(3, '9 days after', 'Mon 30 Nov, 9:00 am'),
    ],
  },
  audit: {
    id: 'audit',
    title: 'Proposals to review',
    about: 'Marketing Cloud audit',
    aboutType: 'Project request',
    who: 'Dana Whitfield',
    first: 'Dana',
    party: 'Northwind Industrial',
    fact: '3 proposals',
    since: 'waiting since Fri 20 Nov',
    state: 'waiting',
    steps: [
      skip(1, '2 days after', 'Mon 23 Nov, 9:00 am', 'over_daily_limit'),
      due(2, '5 days after', 'Wed 25 Nov, 9:00 am'),
      due(3, '9 days after', 'Mon 30 Nov, 9:00 am'),
    ],
  },
  delivery: {
    id: 'delivery',
    title: 'Work to review',
    about: 'Data migration, phase 1',
    aboutType: 'Engagement',
    who: 'Dana Whitfield',
    first: 'Dana',
    party: 'Northwind Industrial',
    fact: 'Auto-accepts Wed 25 Nov',
    since: 'marked complete Wed 18 Nov',
    state: 'waiting',
    exempt: true,
    steps: [
      sent(1, '5 days after, exact time', 'Mon 23 Nov, 10:42 am', {
        channel: 'Email and in-app',
      }),
    ],
  },
  pardot: {
    id: 'pardot',
    title: 'Proposals to review',
    about: 'Pardot migration',
    aboutType: 'Project request',
    who: 'Dana Whitfield',
    first: 'Dana',
    party: 'Northwind Industrial',
    fact: '1 proposal',
    since: 'waited Mon 2 Nov to Fri 6 Nov',
    state: 'stopped',
    steps: [
      sent(1, '2 days after', 'Wed 4 Nov, 9:00 am'),
      skip(2, '5 days after', 'Mon 9 Nov, 9:00 am', 'no_longer_waiting'),
    ],
  },
  field: {
    id: 'field',
    title: 'Invitation to answer',
    about: 'Field Service rollout',
    aboutType: 'Project request',
    who: 'Tom Okafor',
    first: 'Tom',
    party: 'CloudPeak',
    fact: 'From Bright Foods',
    since: 'invited Tue 17 Nov',
    state: 'finished',
    steps: [
      sent(1, '1 day after', 'Wed 18 Nov, 9:00 am'),
      sent(2, '3 days after', 'Fri 20 Nov, 9:00 am'),
    ],
  },
  portal: {
    id: 'portal',
    title: 'Invitation to answer',
    about: 'Experience Cloud portal',
    aboutType: 'Project request',
    who: 'Tom Okafor',
    first: 'Tom',
    party: 'CloudPeak',
    fact: 'From Harbour Health',
    since: 'waited Mon 9 Nov to Wed 11 Nov',
    state: 'stopped',
    steps: [
      sent(1, '1 day after', 'Tue 10 Nov, 9:00 am'),
      skip(2, '3 days after', 'Thu 12 Nov, 9:00 am', 'no_longer_waiting'),
    ],
  },
  priya: {
    id: 'priya',
    title: 'Invitation to answer',
    about: 'Salesforce CPQ rollout',
    aboutType: 'Project request',
    who: 'Priya Nair',
    first: 'Priya',
    party: null,
    fact: 'Independent expert',
    since: 'invited Tue 10 Nov',
    state: 'finished',
    steps: [
      sent(1, '1 day after', 'Wed 11 Nov, 9:00 am'),
      sent(2, '3 days after', 'Fri 13 Nov, 9:00 am'),
    ],
  },
  marcus: {
    id: 'marcus',
    title: 'Invitation to answer',
    about: 'Salesforce CPQ rollout',
    aboutType: 'Project request',
    who: 'Marcus Lee',
    first: 'Marcus',
    party: 'Vertex Consulting',
    fact: null,
    since: 'invited Tue 10 Nov',
    state: 'finished',
    steps: [
      skip(1, '1 day after', 'Wed 11 Nov, 9:00 am', 'send_failed', {
        detail: 'Brevo rejected the address (550 mailbox unavailable).',
      }),
      sent(2, '3 days after', 'Fri 13 Nov, 9:00 am'),
    ],
  },
};

const ENTITIES = {
  person: {
    key: 'person',
    lens: 'person',
    type: 'User',
    icon: I.user,
    title: 'Dana Whitfield',
    sub: 'Owner @ Northwind Industrial · client',
    first: 'Dana',
    limit: { used: 2, of: 2 },
    now: ['cpq', 'health', 'audit', 'delivery'],
    earlier: ['pardot'],
    timeline: [
      ['user.welcome', 'Signed up via Google · WorkOS', '3 Mar'],
      [
        'company_member.role_changed',
        'member → owner, by Alex Chen @ Northwind Industrial',
        '9 Mar',
      ],
    ],
  },
  expert: {
    key: 'expert',
    lens: 'person',
    type: 'Expert',
    icon: I.user,
    title: 'Tom Okafor',
    sub: 'Expert @ CloudPeak · approved',
    first: 'Tom',
    limit: { used: 0, of: 2 },
    now: ['field'],
    earlier: ['portal'],
    timeline: [['expert.application_approved', 'Approved by Adeeb Rahman @ Balo', '14 Jul']],
  },
  request: {
    key: 'request',
    lens: 'entity',
    type: 'Project request',
    icon: I.fileText,
    title: 'Salesforce CPQ rollout',
    sub: 'Northwind Industrial · 2 proposals in · 4 experts invited',
    limit: null,
    now: ['cpq', 'priya', 'marcus'],
    earlier: [],
    timeline: [
      ['project_request.submitted', 'By Dana Whitfield @ Northwind Industrial', '9 Nov'],
      ['relationship.invited', '4 experts invited by Adeeb Rahman @ Balo', '10 Nov'],
    ],
  },
};

// ═══════════════════════════════════════════════════════════════════
// FOLLOW-UPS TAB
// ═══════════════════════════════════════════════════════════════════
const ORDINAL = ['', '1st', '2nd', '3rd'];

function StepRow({ step, wait, last, mobile }) {
  const st = STEP_STATE[step.status];
  const SI = st.icon;
  const reason = step.reason ? REASON[step.reason] : null;
  const channel = step.channel ?? 'Email';
  // A skipped step shows when it would have gone, so it never reads as a send time.
  const whenLabel = step.status === 'not_sent' ? `Was due ${step.when}` : step.when;

  const statusCell = (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: st.color }}>{st.label}</span>
        {step.status !== 'due' && reason === null && (
          <span style={{ fontSize: 12, color: c.textTertiary }}>{channel}</span>
        )}
      </div>
      {reason && (
        <p style={{ fontSize: 12.5, color: c.textSecondary, margin: '2px 0 0', lineHeight: 1.45 }}>
          {reason.say(wait.first)}{' '}
          <span style={{ fontFamily: mono, fontSize: 11, color: c.textTertiary }}>
            {reason.code ?? step.reason}
          </span>
        </p>
      )}
      {step.detail && (
        <p style={{ fontSize: 12, color: c.textTertiary, margin: '2px 0 0', lineHeight: 1.45 }}>
          {step.detail} Also on admin Home.
        </p>
      )}
      {step.held && (
        <p style={{ fontSize: 12, color: c.textTertiary, margin: '2px 0 0', lineHeight: 1.45 }}>
          {step.held}
        </p>
      )}
    </div>
  );

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: mobile ? '26px 1fr' : '26px 150px 1fr auto',
        columnGap: 12,
        rowGap: 4,
        alignItems: 'start',
        padding: '11px 0',
        borderBottom: last ? 'none' : `1px solid ${c.borderSubtle}`,
      }}
    >
      <span
        style={{
          width: 26,
          height: 26,
          borderRadius: 8,
          background: st.bg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <SI size={13} color={st.color} />
      </span>
      <div>
        <p style={{ fontSize: 13, fontWeight: 650, color: c.text, margin: 0 }}>
          {ORDINAL[step.n]} follow-up
        </p>
        <p style={{ fontSize: 12, color: c.textTertiary, margin: '1px 0 0' }}>{step.offset}</p>
        {mobile && (
          <div style={{ marginTop: 8 }}>
            {statusCell}
            <p
              style={{
                fontSize: 12,
                color: c.textSecondary,
                margin: '6px 0 0',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {whenLabel}
            </p>
          </div>
        )}
      </div>
      {!mobile && statusCell}
      {!mobile && (
        <span
          style={{
            fontSize: 12,
            color: step.status === 'due' ? c.textSecondary : c.textTertiary,
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums',
            paddingTop: 1,
          }}
        >
          {whenLabel}
        </span>
      )}
    </div>
  );
}

// ── The closed block: one mark per follow-up, then the same facts in words.
// Shape carries the meaning; colour only repeats it.
function StepMark({ status }) {
  if (status === 'failed') {
    return (
      <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden="true">
        <path d="M6 1.2L11.2 10.6H0.8z" fill={c.error} />
      </svg>
    );
  }
  const sentMark = status === 'sent';
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden="true">
      <circle
        cx="6"
        cy="6"
        r="4.6"
        fill={sentMark ? c.success : 'none'}
        stroke={sentMark ? c.success : status === 'not_sent' ? c.textSecondary : c.textTertiary}
        strokeWidth="1.4"
      />
      {status === 'not_sent' && (
        <path d="M3.7 6h4.6" stroke={c.textSecondary} strokeWidth="1.4" strokeLinecap="round" />
      )}
    </svg>
  );
}
function summarise(steps) {
  const count = (status) => steps.filter((s) => s.status === status).length;
  const parts = [`${count('sent')} of ${steps.length} sent`];
  if (count('not_sent') > 0) parts.push(`${count('not_sent')} not sent`);
  if (count('failed') > 0) parts.push(`${count('failed')} failed`);
  const next = steps.find((s) => s.status === 'due');
  if (next) parts.push(`next ${next.when}`);
  return parts.join(' · ');
}

function WaitBlock({ wait, lens, mobile, index, open, onToggle }) {
  const ws = WAIT_STATE[wait.state];
  const muted = wait.state === 'stopped';
  const anyFailed = wait.steps.some((s) => s.status === 'failed');
  // On a person, the block names the thing. On a thing, it names the person.
  const headline =
    lens === 'person' ? wait.about : wait.who + (wait.party ? ` @ ${wait.party}` : '');
  const context =
    lens === 'person' ? [wait.aboutType, wait.fact, wait.since] : [wait.fact, wait.since];
  return (
    <div
      style={{
        border: `1px solid ${c.border}`,
        borderRadius: 12,
        background: muted ? c.bg : c.surface,
        ...fadeIn(index * 0.04),
      }}
    >
      <button
        className="balo-focus"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          width: '100%',
          padding: '12px 14px',
          border: 'none',
          borderRadius: 12,
          background: 'transparent',
          cursor: 'pointer',
          textAlign: 'left',
          font: 'inherit',
          color: 'inherit',
        }}
      >
        <I.chevRight
          size={15}
          color={c.textTertiary}
          style={{
            flexShrink: 0,
            marginTop: 15,
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform 0.18s',
          }}
        />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ display: 'block', minWidth: 0, flex: '1 1 260px' }}>
            <span
              style={{
                display: 'block',
                fontSize: 11,
                fontWeight: 700,
                color: c.textTertiary,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              {wait.title}
              {lens === 'entity' ? ' · waiting on' : ''}
            </span>
            <span
              style={{
                display: 'block',
                fontSize: 14,
                fontWeight: 700,
                color: c.text,
                marginTop: 3,
              }}
            >
              {headline}
            </span>
            <span
              style={{
                display: 'block',
                fontSize: 12.5,
                color: c.textSecondary,
                marginTop: 3,
                lineHeight: 1.45,
              }}
            >
              {context.filter(Boolean).join(' · ')}
            </span>
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginTop: 8,
                flexWrap: 'wrap',
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {wait.steps.map((s) => (
                  <StepMark key={s.n} status={s.status} />
                ))}
              </span>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: anyFailed ? c.error : c.textSecondary,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {summarise(wait.steps)}
              </span>
            </span>
          </span>
          <Pill small color={ws.color} bg={ws.bg} border={ws.border}>
            {ws.label}
          </Pill>
        </span>
      </button>
      {open && (
        <div style={{ borderTop: `1px solid ${c.borderSubtle}` }}>
          {wait.exempt && (
            <p
              style={{
                fontSize: 12,
                color: c.textTertiary,
                margin: 0,
                padding: '9px 14px 0',
                lineHeight: 1.45,
              }}
            >
              A deadline warning. Sent at its exact time and not counted in the daily limit.
            </p>
          )}
          <div style={{ padding: '2px 14px 4px' }}>
            {wait.steps.map((s, i) => (
              <StepRow
                key={s.n}
                step={s}
                wait={wait}
                last={i === wait.steps.length - 1}
                mobile={mobile}
              />
            ))}
          </div>
          {wait.state === 'finished' && (
            <p
              style={{
                fontSize: 12,
                color: c.textSecondary,
                margin: 0,
                padding: '9px 14px',
                borderTop: `1px solid ${c.borderSubtle}`,
                background: c.warningLight,
                borderRadius: '0 0 11px 11px',
                lineHeight: 1.45,
              }}
            >
              Nothing more will be sent. If this still matters, a person needs to step in.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function LimitStrip({ entity }) {
  const { used, of } = entity.limit;
  const full = used >= of;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        padding: '10px 12px',
        borderRadius: 10,
        background: full ? c.warningLight : c.surfaceSubtle,
        border: `1px solid ${full ? c.warningBorder : c.borderSubtle}`,
        marginBottom: 16,
      }}
    >
      <span style={{ display: 'inline-flex', gap: 4 }} aria-hidden="true">
        {Array.from({ length: of }).map((_, i) => (
          <span
            key={i}
            style={{
              width: 14,
              height: 6,
              borderRadius: 3,
              background: i < used ? (full ? c.warning : c.primary) : c.border,
            }}
          />
        ))}
      </span>
      <span style={{ fontSize: 12.5, fontWeight: 650, color: c.text }}>
        {used} of {of} follow-up emails in the last 24 hours
      </span>
      <span style={{ fontSize: 12, color: c.textSecondary }}>
        {full
          ? `The next one due for ${entity.first} is skipped. Deadline warnings do not count.`
          : 'Deadline warnings do not count.'}
      </span>
    </div>
  );
}

function FollowUpsTab({ entity, state, mobile }) {
  // Collapsed by default. A lone wait opens itself: there is nothing to scan.
  const [open, setOpen] = useState(() => new Set(entity.now.length === 1 ? entity.now : []));
  const toggle = (id) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  if (state === 'loading') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} aria-busy="true">
        {[64, 132, 132].map((h, i) => (
          <div
            key={i}
            style={{
              height: h,
              borderRadius: 12,
              background: `linear-gradient(90deg, ${c.surfaceSubtle} 0%, ${c.borderSubtle} 50%, ${c.surfaceSubtle} 100%)`,
              backgroundSize: '840px 100%',
              animation: 'shimmer 1.4s linear infinite',
            }}
          />
        ))}
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div style={{ padding: '26px 12px', textAlign: 'center' }}>
        <I.alertCircle size={22} color={c.error} />
        <p style={{ fontSize: 14, fontWeight: 700, color: c.text, margin: '10px 0 0' }}>
          Follow-ups could not be loaded
        </p>
        <p
          style={{ fontSize: 12.5, color: c.textSecondary, margin: '4px 0 14px', lineHeight: 1.5 }}
        >
          Something went wrong on our side. Nothing was changed, and nothing was sent by opening
          this tab.
        </p>
        <button
          className="balo-focus"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            padding: '7px 13px',
            borderRadius: 10,
            fontSize: 12.5,
            fontWeight: 650,
            cursor: 'pointer',
            background: 'transparent',
            color: c.textSecondary,
            border: `1px solid ${c.border}`,
          }}
        >
          <I.rotate size={13} color={c.textSecondary} />
          Retry
        </button>
      </div>
    );
  }
  if (state === 'empty') {
    return (
      <div style={{ padding: '26px 12px', textAlign: 'center' }}>
        <I.inbox size={22} color={c.textTertiary} />
        <p style={{ fontSize: 14, fontWeight: 700, color: c.text, margin: '10px 0 0' }}>
          {entity.lens === 'person'
            ? `Nothing is waiting on ${entity.first}`
            : 'Nothing here is waiting on anyone'}
        </p>
        <p style={{ fontSize: 12.5, color: c.textSecondary, margin: '4px 0 0', lineHeight: 1.5 }}>
          No follow-ups were sent or skipped in the last 90 days. When something waits on a person,
          each follow-up shows here with what happened to it.
        </p>
      </div>
    );
  }

  const now = entity.now.map((id) => W[id]);
  const earlier = entity.earlier.map((id) => W[id]);
  const all = [...entity.now, ...entity.earlier];
  const allOpen = all.every((id) => open.has(id));
  return (
    <div>
      {entity.limit && <LimitStrip entity={entity} />}
      <SectionLabel
        right={
          all.length > 1 && (
            <TextLink onClick={() => setOpen(new Set(allOpen ? [] : all))}>
              {allOpen ? 'Collapse all' : 'Expand all'}
            </TextLink>
          )
        }
      >
        Waiting now · {now.length}
      </SectionLabel>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {now.map((w, i) => (
          <WaitBlock
            key={w.id}
            wait={w}
            lens={entity.lens}
            mobile={mobile}
            index={i}
            open={open.has(w.id)}
            onToggle={() => toggle(w.id)}
          />
        ))}
      </div>
      {earlier.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <SectionLabel>Earlier · last 90 days</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {earlier.map((w, i) => (
              <WaitBlock
                key={w.id}
                wait={w}
                lens={entity.lens}
                mobile={mobile}
                index={i}
                open={open.has(w.id)}
                onToggle={() => toggle(w.id)}
              />
            ))}
          </div>
        </div>
      )}
      <p style={{ fontSize: 11, color: c.textTertiary, margin: '14px 0 0', lineHeight: 1.5 }}>
        A Due follow-up is sent only if it is still waiting at that time. Times are in the
        recipient’s own time zone. From scheduled_notifications; opening this tab writes nothing.
      </p>
    </div>
  );
}

// ── Timeline: shipped (BAL-551). A stand-in, here only so the tabs read true.
function TimelineStandIn({ entity }) {
  return (
    <div>
      {entity.timeline.map(([action, what, when], i) => (
        <div
          key={action}
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto',
            gap: 10,
            paddingBottom: i === entity.timeline.length - 1 ? 0 : 12,
          }}
        >
          <div>
            <p
              style={{ fontSize: 12, fontWeight: 700, color: c.text, margin: 0, fontFamily: mono }}
            >
              {action}
            </p>
            <p style={{ fontSize: 12.5, color: c.textSecondary, margin: '2px 0 0' }}>{what}</p>
          </div>
          <span style={{ fontSize: 11.5, color: c.textTertiary, whiteSpace: 'nowrap' }}>
            {when}
          </span>
        </div>
      ))}
      <p style={{ fontSize: 11, color: c.textTertiary, margin: '14px 0 0', lineHeight: 1.5 }}>
        From audit_events. Unchanged by this prototype.
      </p>
    </div>
  );
}

function DrillIn({ entity, state, mobile }) {
  const [tab, setTab] = useState('followups');
  const EI = entity.icon;
  const tabs = [
    ['timeline', 'Timeline'],
    ['followups', 'Follow-ups'],
  ];
  return (
    <Card style={{ overflow: 'hidden' }}>
      <div style={{ padding: '14px 16px', borderBottom: `1px solid ${c.borderSubtle}` }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <span
              style={{
                width: 32,
                height: 32,
                borderRadius: 9,
                background: c.surfaceSubtle,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <EI size={15} color={c.textSecondary} />
            </span>
            <div style={{ minWidth: 0 }}>
              <p
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: c.textTertiary,
                  margin: 0,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                {entity.type}
              </p>
              <p style={{ fontSize: 14.5, fontWeight: 750, color: c.text, margin: '2px 0 0' }}>
                {entity.title}
              </p>
              <p style={{ fontSize: 12, color: c.textSecondary, margin: '1px 0 0' }}>
                {entity.sub}
              </p>
            </div>
          </div>
          <TextLink icon={I.externalLink}>Open</TextLink>
        </div>
        <div role="tablist" style={{ display: 'flex', gap: 4, marginTop: 12 }}>
          {tabs.map(([key, label]) => {
            const on = tab === key;
            return (
              <button
                key={key}
                role="tab"
                aria-selected={on}
                className="balo-focus"
                onClick={() => setTab(key)}
                style={{
                  padding: '6px 12px',
                  borderRadius: 8,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 12.5,
                  fontWeight: on ? 650 : 500,
                  background: on ? c.primaryLight : 'transparent',
                  color: on ? c.primary : c.textSecondary,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ padding: 16 }}>
        {tab === 'timeline' && <TimelineStandIn entity={entity} />}
        {tab === 'followups' && <FollowUpsTab entity={entity} state={state} mobile={mobile} />}
      </div>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════
// WORDING — every state and reason in one place, for sign-off.
// ═══════════════════════════════════════════════════════════════════
function WordingPanel() {
  const rowStyle = (last) => ({
    display: 'grid',
    gridTemplateColumns: '250px 1fr',
    gap: 14,
    padding: '11px 0',
    borderBottom: last ? 'none' : `1px solid ${c.borderSubtle}`,
    alignItems: 'start',
  });
  const waits = [
    ['waiting', 'Follow-ups are still to come.'],
    ['finished', 'Every follow-up has gone and it is still waiting. Nothing more is sent.'],
    ['stopped', 'It was dealt with. Any follow-ups left were not sent.'],
  ];
  const steps = [
    ['sent', 'Handed to the email provider. Shows the channel.'],
    ['due', 'Not sent yet. Worked out from the step table; sent only if still waiting.'],
    ['not_sent', 'Deliberately skipped. Always shown with one of the reasons below.'],
    ['failed', 'Tried and could not be sent. The only red state.'],
  ];
  const reasons = Object.entries(REASON);
  return (
    <Card style={{ padding: 16 }}>
      <SectionLabel>A wait is one of</SectionLabel>
      {waits.map(([key, note], i) => {
        const ws = WAIT_STATE[key];
        return (
          <div key={key} style={rowStyle(i === waits.length - 1)}>
            <div>
              <Pill small color={ws.color} bg={ws.bg} border={ws.border}>
                {ws.label}
              </Pill>
            </div>
            <p style={{ fontSize: 12.5, color: c.textSecondary, margin: 0, lineHeight: 1.5 }}>
              {note}
            </p>
          </div>
        );
      })}
      <div style={{ height: 18 }} />
      <SectionLabel>A follow-up is one of</SectionLabel>
      {steps.map(([key, note], i) => {
        const st = STEP_STATE[key];
        return (
          <div key={key} style={rowStyle(i === steps.length - 1)}>
            <span style={{ fontSize: 13, fontWeight: 700, color: st.color }}>{st.label}</span>
            <p style={{ fontSize: 12.5, color: c.textSecondary, margin: 0, lineHeight: 1.5 }}>
              {note}
            </p>
          </div>
        );
      })}
      <div style={{ height: 18 }} />
      <SectionLabel>Reasons, as staff read them</SectionLabel>
      {reasons.map(([code, r], i) => (
        <div key={code} style={rowStyle(i === reasons.length - 1)}>
          <span style={{ fontFamily: mono, fontSize: 11.5, color: c.textSecondary }}>
            {r.code ?? code}
          </span>
          <div>
            <p
              style={{ fontSize: 13, fontWeight: 650, color: c.text, margin: 0, lineHeight: 1.45 }}
            >
              {STEP_STATE[r.state].label}. {r.say('Dana')}
            </p>
            <p style={{ fontSize: 12, color: c.textTertiary, margin: '2px 0 0', lineHeight: 1.45 }}>
              {r.when}
            </p>
          </div>
        </div>
      ))}
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════
// CONTROL BAR + PAGE
// ═══════════════════════════════════════════════════════════════════
function Seg({ items, value, onPick }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        gap: 3,
        padding: 3,
        borderRadius: 10,
        background: c.surfaceSubtle,
      }}
    >
      {items.map(([key, label]) => {
        const on = value === key;
        return (
          <button
            key={key}
            className="balo-focus"
            onClick={() => onPick(key)}
            style={{
              padding: '7px 12px',
              borderRadius: 7,
              fontSize: 12.5,
              fontWeight: on ? 650 : 500,
              border: on ? `1px solid ${c.border}` : '1px solid transparent',
              cursor: 'pointer',
              background: on ? c.surface : 'transparent',
              color: on ? c.text : c.textSecondary,
              whiteSpace: 'nowrap',
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
const CtlLabel = ({ children }) => (
  <span
    style={{
      fontSize: 11,
      fontWeight: 700,
      color: c.textTertiary,
      textTransform: 'uppercase',
      letterSpacing: '0.06em',
    }}
  >
    {children}
  </span>
);

export default function BaloLookupFollowUps() {
  const [view, setView] = useState('tab');
  const [entityKey, setEntityKey] = useState('person');
  const [state, setState] = useState('loaded');
  const [mobile, setMobile] = useState(false);
  const entity = ENTITIES[entityKey];

  return (
    <div
      style={{
        minHeight: '100vh',
        background: c.bg,
        color: c.text,
        fontFamily:
          'Geist, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <style>{keyframes}</style>
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 30,
          background: c.surface,
          borderBottom: `1px solid ${c.border}`,
          padding: '12px 24px',
          display: 'flex',
          alignItems: 'center',
          gap: 18,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <CtlLabel>View</CtlLabel>
          <Seg
            items={[
              ['tab', 'Follow-ups tab'],
              ['wording', 'Wording'],
            ]}
            value={view}
            onPick={setView}
          />
        </div>
        {view === 'tab' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <CtlLabel>Looking up</CtlLabel>
              <Seg
                items={[
                  ['person', 'A client'],
                  ['expert', 'An expert'],
                  ['request', 'A request'],
                ]}
                value={entityKey}
                onPick={setEntityKey}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <CtlLabel>State</CtlLabel>
              <Seg
                items={[
                  ['loaded', 'Loaded'],
                  ['loading', 'Loading'],
                  ['error', 'Error'],
                  ['empty', 'Empty'],
                ]}
                value={state}
                onPick={setState}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <CtlLabel>Width</CtlLabel>
              <Seg
                items={[
                  [false, 'Desktop'],
                  [true, 'Mobile'],
                ]}
                value={mobile}
                onPick={setMobile}
              />
            </div>
          </>
        )}
      </div>

      <div
        style={{
          maxWidth: view === 'tab' && mobile ? 390 : 760,
          margin: '0 auto',
          padding: mobile ? '20px 12px 48px' : '28px 24px 64px',
        }}
      >
        <h1 style={{ fontSize: 22, fontWeight: 800, color: c.text, margin: 0 }}>
          {view === 'tab' ? 'Lookup' : 'Follow-ups wording'}
        </h1>
        <p style={{ fontSize: 13, color: c.textTertiary, margin: '3px 0 18px' }}>
          {view === 'tab'
            ? 'The drill-in, with the new Follow-ups tab open.'
            : 'Every state and reason staff can see, with its stored code.'}
        </p>
        {view === 'tab' ? (
          <DrillIn key={entityKey} entity={entity} state={state} mobile={mobile} />
        ) : (
          <WordingPanel />
        )}
      </div>
    </div>
  );
}
