import { useState } from 'react';

// ══════════════════════════════════════════════════════════════════
// BAL-540 + BAL-541 — REQUEST CLOSE · DECLINE A TRACK · CLOSED STATE ·
// BALO OWNER + NOTES  —  route /(dashboard)/projects/[requestId]
// Decision record: ADR-1025 Amendment 1 (2026-09-05). Tracker: 3.2.
//
// The page chrome drawn here (header, track cards, proposal card) is a COMPACT
// STAND-IN for project-request-detail.jsx — CC implements against the real
// page. The decisions in this file are the NEW elements only:
//
//   1. THE CLOSE SHEET. Two variants of one sheet. Client: no reason picker —
//      a client's only reason is "withdrawn", so it is stated, not chosen.
//      Balo: a three-way reason (declined · unfilled · superseded) and a
//      REQUIRED note that is Balo-only and never shown to a member. Both
//      variants lead with a per-track CONSEQUENCE LIST — named people, named
//      parties, what each one is told — because that list is the decision the
//      person is making. "Close request" is the verb on the control, the sheet
//      and the toast. Terminal: "a changed mind is a new request".
//   2. DECLINE A TRACK. One control per live track, both lenses. The verb
//      follows the stage: "Decline" for an EOI or a proposal, "Withdraw invite"
//      for an invitation that was never answered. The confirm names the expert,
//      the party that will be told, and that files stay as they were
//      (ADR-1048 historical-read). Declining a proposal IS declining the track.
//      No free-text message to the expert in v1 — a moderation surface we do
//      not need yet. Balo's proxy carries "on {company}'s behalf" attribution.
//   3. THE CLOSED STATE. A banner replaces the actions: when, who "@ company",
//      the reason label — and for Balo, the note behind a lock. Tracks freeze
//      with their final chip. ONE emphasised action: the client is offered
//      "Raise a new request"; Balo and the expert get quiet links only.
//   4. THE EXPERT'S "NOT PROCEEDING" STATE. Every decline and every closure
//      tells the expert. Two copies, one shape: "isn't proceeding with your
//      proposal" (declined track) vs "closed this request" (closure). What
//      happens to their files is stated; nothing further is asked of them.
//   5. THE BALO PANEL (BAL-541). Admin lens only: owner picker (staff users,
//      clearable), notes newest-first with "@ Balo" attribution, a composer,
//      and an empty state that asks a question rather than announcing absence.
//      A side panel earns no gradient button. Kanban cards carry the owner's
//      initials; the admin portfolio gains a "Mine" filter.
//
// COPY RULES: gender-neutral; prospective copy names the party ("CloudPeak is
// told"), retrospective names the person "@ company" ("Withdrawn by Dana
// Whitfield @ Northwind Industrial"). Ages and dates are facts. Errors say
// what happened and that nothing changed. `pending-MJ` on every string.
// MOTION: only the sheet answers an action (slide up); no ambient entrances.
// STATES: live · closing · closed per viewer; notes populated / none.
// FEE CONCEALMENT: the proposal figure renders per lens — client all-in,
// expert earnings, Balo both — and the closed state never widens it.
// ══════════════════════════════════════════════════════════════════

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
  primaryDark: '#1D4ED8',
  primaryLight: '#EFF6FF',
  primaryBorder: '#BFDBFE',
  primaryGlow: 'rgba(37,99,235,0.12)',
  accent: '#7C3AED',
  accentLight: '#F5F3FF',
  accentBorder: '#DDD6FE',
  success: '#059669',
  successLight: '#ECFDF5',
  successBorder: '#A7F3D0',
  warning: '#D97706',
  warningLight: '#FFFBEB',
  warningBorder: '#FDE68A',
  error: '#DC2626',
  errorLight: '#FEF2F2',
  errorBorder: '#FECACA',
  gradient: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
};

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
  x: (p) => <Icon {...p} d="M18 6L6 18M6 6l12 12" />,
  chevRight: (p) => <Icon {...p} d="M9 18l6-6-6-6" />,
  chevDown: (p) => <Icon {...p} d="M6 9l6 6 6-6" />,
  chevLeft: (p) => <Icon {...p} d="M15 18l-6-6 6-6" />,
  arrowRight: (p) => <Icon {...p} d="M5 12h14M12 5l7 7-7 7" />,
  shield: (p) => <Icon {...p} d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  briefcase: (p) => (
    <Icon
      {...p}
      d="M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2zM16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"
    />
  ),
  dollar: (p) => <Icon {...p} d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />,
  user: (p) => (
    <Multi {...p}>
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </Multi>
  ),
  building: (p) => (
    <Multi {...p}>
      <path d="M3 21h18M6 21V5a2 2 0 012-2h8a2 2 0 012 2v16" />
      <path d="M9 8h.01M15 8h.01M9 12h.01M15 12h.01M9 16h.01M15 16h.01" />
    </Multi>
  ),
  calendar: (p) => (
    <Multi {...p}>
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </Multi>
  ),
  fileText: (p) => (
    <Multi {...p}>
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
    </Multi>
  ),
  lock: (p) => (
    <Multi {...p}>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0110 0v4" />
    </Multi>
  ),
  xCircle: (p) => (
    <Multi {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M15 9l-6 6M9 9l6 6" />
    </Multi>
  ),
  checkCircle: (p) => (
    <Multi {...p}>
      <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
      <path d="M22 4L12 14.01l-3-3" />
    </Multi>
  ),
  mail: (p) => (
    <Multi {...p}>
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
      <path d="M22 6l-10 7L2 6" />
    </Multi>
  ),
  message: (p) => <Icon {...p} d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />,
  filter: (p) => <Icon {...p} d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />,
  edit: (p) => (
    <Multi {...p}>
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
      <path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
    </Multi>
  ),
  trash: (p) => (
    <Multi {...p}>
      <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
    </Multi>
  ),
  send: (p) => <Icon {...p} d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />,
  plus: (p) => <Icon {...p} d="M12 5v14M5 12h14" />,
};

const keyframes = `
@keyframes sheetUp { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: translateY(0); } }
@keyframes toastIn { from { opacity: 0; transform: translate(-50%, 10px); } to { opacity: 1; transform: translate(-50%, 0); } }
.balo-focus:focus-visible { outline: 2px solid #2563EB; outline-offset: 2px; }
.balo-xscroll { overflow-x: auto; scrollbar-width: none; }
.balo-xscroll::-webkit-scrollbar { display: none; }
@media (prefers-reduced-motion: reduce) { * { animation-duration: 0.001s !important; transition-duration: 0.001s !important; } }
`;

// ── Primitives (the shipped admin-lens idiom) ──────────────────────
function Card({ children, style: xs, dim }) {
  return (
    <div
      style={{
        background: c.surface,
        borderRadius: 16,
        border: `1px solid ${c.border}`,
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        opacity: dim ? 0.62 : 1,
        transition: 'opacity 0.2s',
        ...xs,
      }}
    >
      {children}
    </div>
  );
}
function Pill({
  children,
  color = c.textSecondary,
  bg = c.surfaceSubtle,
  border,
  icon: IC,
  small,
}) {
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
      {IC && <IC size={small ? 10 : 11} color={color} />}
      {children}
    </span>
  );
}
function Btn({
  children,
  icon: IC,
  variant = 'primary',
  onClick,
  style: xs,
  full,
  small,
  disabled,
  title,
}) {
  const [h, setH] = useState(false);
  const hover = h && !disabled;
  const styles = {
    primary: {
      background: hover ? c.primaryDark : c.primary,
      color: 'white',
      boxShadow: `0 2px 10px ${c.primaryGlow}`,
    },
    danger: {
      background: hover ? '#B91C1C' : c.error,
      color: 'white',
      boxShadow: '0 2px 10px rgba(220,38,38,0.18)',
    },
    ghost: {
      background: hover ? c.surfaceSubtle : 'transparent',
      color: c.textSecondary,
      border: `1px solid ${c.border}`,
    },
    quiet: {
      background: hover ? c.surfaceSubtle : 'transparent',
      color: c.textSecondary,
      border: 'none',
    },
  };
  const iconColor = variant === 'ghost' || variant === 'quiet' ? c.textSecondary : 'white';
  return (
    <button
      className="balo-focus"
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      disabled={disabled}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
        padding: small ? '7px 13px' : '9px 16px',
        borderRadius: 10,
        fontSize: small ? 12.5 : 13,
        fontWeight: 650,
        cursor: disabled ? 'not-allowed' : 'pointer',
        border: 'none',
        transition: 'all 0.2s',
        width: full ? '100%' : undefined,
        opacity: disabled ? 0.45 : 1,
        ...styles[variant],
        ...xs,
      }}
    >
      {IC && <IC size={14} color={iconColor} />}
      {children}
    </button>
  );
}
const TextLink = ({ children, onClick, icon: IC, color = c.primary }) => (
  <button
    className="balo-focus"
    onClick={onClick}
    style={{
      border: 'none',
      background: 'transparent',
      cursor: 'pointer',
      fontSize: 12.5,
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
const Avatar = ({ name, size = 30, tone = 'neutral' }) => {
  const initials = name
    .split(' ')
    .map((s) => s[0])
    .slice(0, 2)
    .join('');
  const bg = tone === 'balo' ? c.accentLight : c.surfaceSubtle;
  const color = tone === 'balo' ? c.accent : c.textSecondary;
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: bg,
        color,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.38,
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      {initials}
    </span>
  );
};

// ══════════════════════════════════════════════════════════════════
// WORKED DATA — one request, three tracks, three people
// ══════════════════════════════════════════════════════════════════
const REQUEST = {
  title: 'CPQ implementation — replace legacy quoting tool',
  company: 'Northwind Industrial',
  raised: '25 Aug 2026',
  raisedBy: 'Dana Whitfield',
  budget: 'A$20,000 – A$30,000',
  timeline: 'Go-live before end of Q4',
  discovery: { when: '9 Sep, 11:00 AEST', with: 'Priya Nair' },
};
const VIEWERS = [
  {
    key: 'client',
    name: 'Dana Whitfield',
    party: 'Northwind Industrial',
    label: 'Dana · client owner',
  },
  { key: 'admin', name: 'Adeeb', party: 'Balo', label: 'Adeeb · Balo admin' },
  { key: 'expert', name: 'Priya Nair', party: 'CloudPeak', label: 'Priya · expert' },
];
const STAFF = ['Unassigned', 'Adeeb', 'Yomi', 'MJ', 'Luke'];

// Track stage → how it reads and what "no" is called at that stage.
const STAGES = {
  invited: { label: 'Invited', tone: 'neutral', noVerb: 'Withdraw invite', noun: 'invitation' },
  eoi_submitted: {
    label: 'Interested',
    tone: 'primary',
    noVerb: 'Decline',
    noun: 'expression of interest',
  },
  proposal_submitted: { label: 'Proposal in', tone: 'accent', noVerb: 'Decline', noun: 'proposal' },
};
const TRACKS = [
  {
    id: 't-priya',
    expert: 'Priya Nair',
    party: 'CloudPeak',
    stage: 'proposal_submitted',
    when: 'Proposal submitted 3 Sep',
    proposal: {
      client: 'A$24,000',
      expert: 'A$19,200',
      fee: '20%',
      method: 'Fixed price · 3 milestones',
    },
  },
  {
    id: 't-marcus',
    expert: 'Marcus Lee',
    party: 'Northstar Consulting',
    stage: 'eoi_submitted',
    when: 'Expressed interest 30 Aug',
  },
  {
    id: 't-aisha',
    expert: 'Aisha Bello',
    party: 'CloudPeak',
    stage: 'invited',
    when: 'Invited 28 Aug · no reply yet',
  },
];
const NOTES_SEED = [
  {
    id: 'n2',
    author: 'Adeeb',
    when: '3 Sep',
    body: 'Dana wants fixed price. Priya\u2019s proposal is fixed but front-loads milestone 1 \u2014 worth a nudge before Dana reviews it.',
  },
  {
    id: 'n1',
    author: 'Yomi',
    when: '1 Sep',
    body: 'Marcus is a maybe \u2014 mid-engagement with Vector until October. Don\u2019t push him for a proposal before then.',
  },
];
const TONE = {
  neutral: { color: c.textTertiary, bg: c.surfaceSubtle, border: c.border },
  primary: { color: c.primary, bg: c.primaryLight, border: c.primaryBorder },
  accent: { color: c.accent, bg: c.accentLight, border: c.accentBorder },
  success: { color: c.success, bg: c.successLight, border: c.successBorder },
  warning: { color: c.warning, bg: c.warningLight, border: c.warningBorder },
  error: { color: c.error, bg: c.errorLight, border: c.errorBorder },
};

// The per-track consequence sentence. This is the sheet's load-bearing copy:
// prospective, names the party that will be told, states what happens to work.
function consequenceFor(t) {
  if (t.stage === 'proposal_submitted')
    return `${t.expert}\u2019s proposal is withdrawn, and ${t.party} is told you\u2019re not proceeding.`;
  if (t.stage === 'eoi_submitted')
    return `${t.expert}\u2019s expression of interest ends, and ${t.party} is told.`;
  return `${t.expert}\u2019s invitation is withdrawn. ${t.party} is told.`;
}
const CLOSE_REASONS = [
  {
    key: 'declined',
    label: 'Balo declined',
    hint: 'Not a fit for the marketplace, or outside what we can staff.',
  },
  { key: 'unfilled', label: 'Unfilled', hint: 'We could not find an expert in time.' },
  {
    key: 'superseded',
    label: 'Superseded',
    hint: 'Replaced by another request from the same company.',
  },
];

// ══════════════════════════════════════════════════════════════════
// TRACK CARD — one expert relationship, per lens, with its "no"
// ══════════════════════════════════════════════════════════════════
function TrackCard({ t, state, viewer, onNo, frozen }) {
  const st = STAGES[t.stage];
  const tone = TONE[st.tone];
  const declined = state?.kind === 'declined';
  const ended = state?.kind === 'ended';
  const inert = declined || ended || frozen;
  const showMoney = t.proposal && (viewer === 'client' || viewer === 'admin');

  let chip;
  if (declined)
    chip = (
      <Pill color={c.textSecondary} bg={c.surfaceSubtle} border={c.border} icon={I.xCircle} small>
        {t.stage === 'invited' ? 'Invite withdrawn' : 'Declined'}
      </Pill>
    );
  else if (ended)
    chip = (
      <Pill color={c.textSecondary} bg={c.surfaceSubtle} border={c.border} icon={I.xCircle} small>
        Ended — request closed
      </Pill>
    );
  else
    chip = (
      <Pill color={tone.color} bg={tone.bg} border={tone.border} small>
        {st.label}
      </Pill>
    );

  return (
    <Card dim={inert} style={{ padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <Avatar name={t.expert} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: c.text }}>{t.expert}</span>
            <span style={{ fontSize: 12.5, color: c.textTertiary }}>@ {t.party}</span>
            {chip}
          </div>
          <p style={{ fontSize: 12.5, color: c.textSecondary, margin: '4px 0 0' }}>
            {declined
              ? `${state.byLabel} · ${state.when}`
              : ended
                ? 'Ended when the request closed · files as they were'
                : t.when}
          </p>
          {showMoney && !ended && (
            <div
              style={{
                marginTop: 10,
                padding: '10px 12px',
                borderRadius: 10,
                background: c.surfaceSubtle,
                display: 'flex',
                gap: 18,
                flexWrap: 'wrap',
              }}
            >
              <Money
                label={viewer === 'admin' ? 'Client all-in' : 'Total'}
                value={t.proposal.client}
              />
              {viewer === 'admin' && <Money label="Expert earnings" value={t.proposal.expert} />}
              {viewer === 'admin' && <Money label="Balo fee" value={t.proposal.fee} />}
              <Money label="Method" value={t.proposal.method} plain />
            </div>
          )}
        </div>
        {!inert && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              alignItems: 'flex-end',
              flexShrink: 0,
            }}
          >
            {t.stage === 'proposal_submitted' && viewer === 'client' && (
              <Btn variant="primary" small>
                Review proposal
              </Btn>
            )}
            <Btn variant="ghost" small icon={I.x} onClick={() => onNo(t)}>
              {st.noVerb}
            </Btn>
            {viewer === 'admin' && (
              <span style={{ fontSize: 10.5, color: c.textTertiary }}>
                on {REQUEST.company}\u2019s behalf
              </span>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
const Money = ({ label, value, plain }) => (
  <div>
    <p style={{ fontSize: 10.5, fontWeight: 700, color: c.textTertiary, margin: 0 }}>{label}</p>
    <p
      style={{
        fontSize: plain ? 12.5 : 13.5,
        fontWeight: plain ? 500 : 700,
        color: c.text,
        margin: '2px 0 0',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {value}
    </p>
  </div>
);

// ══════════════════════════════════════════════════════════════════
// DECLINE CONFIRM — names the expert, the party told, and the files rule
// ══════════════════════════════════════════════════════════════════
function DeclineConfirm({ t, viewer, onCancel, onConfirm, inset }) {
  const st = STAGES[t.stage];
  const title =
    t.stage === 'invited'
      ? `Withdraw ${t.expert}\u2019s invitation?`
      : `Decline ${t.expert}\u2019s ${st.noun}?`;
  const body =
    t.stage === 'invited'
      ? `${t.party} is told the invitation was withdrawn. Nothing was shared with them beyond the brief.`
      : t.stage === 'proposal_submitted'
        ? `${t.party} is told you\u2019re not proceeding. Their proposal is declined, and the files they had access to stay exactly as they were \u2014 nothing new is shared.`
        : `${t.party} is told you\u2019re not proceeding. The files they had access to stay exactly as they were.`;
  return (
    <Overlay onClose={onCancel} inset={inset}>
      <h3 style={{ fontSize: 17, fontWeight: 750, color: c.text, margin: 0 }}>{title}</h3>
      <p style={{ fontSize: 13.5, color: c.textSecondary, margin: '8px 0 0', lineHeight: 1.6 }}>
        {body}
      </p>
      {viewer === 'admin' && (
        <p
          style={{
            fontSize: 12,
            color: c.textTertiary,
            margin: '10px 0 0',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <I.shield size={12} color={c.accent} />
          Recorded as Adeeb @ Balo, on {REQUEST.company}\u2019s behalf.
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
        <Btn variant="ghost" onClick={onCancel}>
          Keep
        </Btn>
        <Btn variant="primary" icon={I.x} onClick={onConfirm}>
          {st.noVerb}
        </Btn>
      </div>
    </Overlay>
  );
}

function Overlay({ children, onClose, inset, wide }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: inset ? 'absolute' : 'fixed',
        inset: 0,
        background: 'rgba(17,24,39,0.45)',
        display: 'flex',
        alignItems: inset ? 'flex-end' : 'center',
        justifyContent: 'center',
        zIndex: 60,
        padding: inset ? 0 : 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: c.surface,
          borderRadius: inset ? '18px 18px 0 0' : 18,
          padding: 22,
          width: wide ? 560 : 460,
          maxWidth: '100%',
          maxHeight: inset ? '92%' : '90vh',
          overflowY: 'auto',
          boxShadow: '0 24px 60px rgba(0,0,0,0.25)',
          animation: 'sheetUp 0.25s ease-out both',
        }}
      >
        {inset && (
          <div
            style={{
              width: 36,
              height: 4,
              borderRadius: 2,
              background: c.border,
              margin: '-6px auto 14px',
            }}
          />
        )}
        {children}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// CLOSE SHEET — one sheet, two variants; the consequence list is the point
// ══════════════════════════════════════════════════════════════════
function CloseSheet({ viewer, liveTracks, onCancel, onConfirm, inset }) {
  const [reason, setReason] = useState(null);
  const [note, setNote] = useState('');
  const isAdmin = viewer === 'admin';
  const canConfirm = !isAdmin || (reason !== null && note.trim().length >= 8);

  const items = [
    ...liveTracks.map((t) => ({ icon: I.user, text: consequenceFor(t) })),
    {
      icon: I.calendar,
      text: `The discovery call on ${REQUEST.discovery.when} with ${REQUEST.discovery.with} is cancelled, and both sides are told.`,
    },
    {
      icon: I.fileText,
      text: 'Files stay exactly as they are. Nothing is shared further, and nothing already shared is taken back.',
    },
    ...(isAdmin
      ? [
          {
            icon: I.mail,
            text: `${REQUEST.raisedBy} @ ${REQUEST.company} is told the request was closed and why \u2014 the reason, never this note.`,
          },
        ]
      : []),
  ];

  return (
    <Overlay onClose={onCancel} inset={inset} wide>
      <h3 style={{ fontSize: 18, fontWeight: 750, color: c.text, margin: 0 }}>
        Close this request?
      </h3>
      <p style={{ fontSize: 13.5, color: c.textSecondary, margin: '6px 0 0', lineHeight: 1.6 }}>
        {isAdmin
          ? `${REQUEST.company} stops looking for an expert for`
          : 'You stop looking for an expert for'}{' '}
        <strong style={{ color: c.text, fontWeight: 650 }}>{REQUEST.title}</strong>. Here is what
        happens:
      </p>

      <ul
        style={{
          listStyle: 'none',
          padding: 0,
          margin: '14px 0 0',
          display: 'flex',
          flexDirection: 'column',
          gap: 9,
        }}
      >
        {items.map((it, i) => (
          <li key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span
              style={{
                width: 24,
                height: 24,
                borderRadius: 7,
                background: c.surfaceSubtle,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                marginTop: 1,
              }}
            >
              <it.icon size={12} color={c.textSecondary} />
            </span>
            <span style={{ fontSize: 13, color: c.text, lineHeight: 1.55 }}>{it.text}</span>
          </li>
        ))}
      </ul>

      {isAdmin ? (
        <div style={{ marginTop: 18 }}>
          <p style={{ fontSize: 12.5, fontWeight: 700, color: c.text, margin: '0 0 8px' }}>
            Why is Balo closing it?
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: inset ? '1fr' : 'repeat(3, 1fr)',
              gap: 8,
            }}
          >
            {CLOSE_REASONS.map((r) => {
              const on = reason === r.key;
              return (
                <button
                  key={r.key}
                  className="balo-focus"
                  onClick={() => setReason(r.key)}
                  style={{
                    textAlign: 'left',
                    padding: '10px 12px',
                    borderRadius: 12,
                    cursor: 'pointer',
                    border: `1.5px solid ${on ? c.primaryBorder : c.border}`,
                    background: on ? c.primaryLight : c.surface,
                    boxShadow: on ? `0 0 0 3px ${c.primaryGlow}` : 'none',
                  }}
                >
                  <p
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: on ? c.primary : c.text,
                      margin: 0,
                    }}
                  >
                    {r.label}
                  </p>
                  <p
                    style={{
                      fontSize: 11.5,
                      color: c.textSecondary,
                      margin: '3px 0 0',
                      lineHeight: 1.45,
                    }}
                  >
                    {r.hint}
                  </p>
                </button>
              );
            })}
          </div>
          <p
            style={{
              fontSize: 12.5,
              fontWeight: 700,
              color: c.text,
              margin: '14px 0 6px',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <I.lock size={12} color={c.textTertiary} />
            Balo-only note
          </p>
          <textarea
            className="balo-focus"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="What the next person at Balo should know \u2014 never shown to Northwind Industrial or the experts"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              borderRadius: 10,
              border: `1px solid ${c.border}`,
              padding: '9px 12px',
              fontSize: 13,
              fontFamily: 'inherit',
              resize: 'vertical',
              color: c.text,
            }}
          />
        </div>
      ) : (
        <p style={{ fontSize: 12.5, color: c.textSecondary, margin: '16px 0 0', lineHeight: 1.55 }}>
          This is recorded as withdrawn by {REQUEST.company}. It can\u2019t be undone \u2014 if you
          change your mind, you raise a new request.
        </p>
      )}

      <div
        style={{
          display: 'flex',
          gap: 8,
          justifyContent: 'flex-end',
          marginTop: 18,
          alignItems: 'center',
        }}
      >
        {isAdmin && !canConfirm && (
          <span style={{ fontSize: 11.5, color: c.textTertiary, marginRight: 'auto' }}>
            Pick a reason and leave a note to close.
          </span>
        )}
        <Btn variant="ghost" onClick={onCancel}>
          Keep open
        </Btn>
        <Btn
          variant="primary"
          icon={I.xCircle}
          disabled={!canConfirm}
          onClick={() => onConfirm({ reason: isAdmin ? reason : 'withdrawn', note })}
        >
          Close request
        </Btn>
      </div>
    </Overlay>
  );
}

// ══════════════════════════════════════════════════════════════════
// CLOSED BANNER — when, who @ company, why; the note behind a lock for Balo
// ══════════════════════════════════════════════════════════════════
const REASON_LABEL = {
  withdrawn: 'Withdrawn',
  declined: 'Balo declined',
  unfilled: 'Unfilled',
  superseded: 'Superseded',
};
function ClosedBanner({ closed, viewer, counts, onNewRequest }) {
  const byLabel =
    closed.byViewer === 'admin' ? 'Adeeb @ Balo' : `${REQUEST.raisedBy} @ ${REQUEST.company}`;
  return (
    <Card style={{ padding: '16px 18px', borderColor: c.border, background: c.surfaceSubtle }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <span
          style={{
            width: 34,
            height: 34,
            borderRadius: 10,
            background: c.surface,
            border: `1px solid ${c.border}`,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <I.xCircle size={16} color={c.textSecondary} />
        </span>
        <div style={{ flex: 1, minWidth: 220 }}>
          <p style={{ fontSize: 15, fontWeight: 750, color: c.text, margin: 0 }}>
            Closed on 5 Sep 2026 · {REASON_LABEL[closed.reason]}
          </p>
          <p style={{ fontSize: 12.5, color: c.textSecondary, margin: '4px 0 0' }}>
            {closed.reason === 'withdrawn' ? 'Withdrawn' : 'Closed'} by {byLabel} · {counts.tracks}{' '}
            {counts.tracks === 1 ? 'track' : 'tracks'} ended · 1 meeting cancelled · files unchanged
          </p>
          {viewer === 'admin' && closed.note && (
            <p
              style={{
                fontSize: 12.5,
                color: c.text,
                margin: '10px 0 0',
                padding: '8px 10px',
                borderRadius: 8,
                background: c.surface,
                border: `1px dashed ${c.border}`,
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
              }}
            >
              <I.lock size={12} color={c.textTertiary} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>
                <span style={{ color: c.textTertiary, fontWeight: 600 }}>Balo only · </span>
                {closed.note}
              </span>
            </p>
          )}
        </div>
        {viewer === 'client' && (
          <Btn variant="primary" icon={I.plus} onClick={onNewRequest}>
            Raise a new request
          </Btn>
        )}
      </div>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════
// EXPERT LENS — the track from the expert's side, live and after a "no"
// ══════════════════════════════════════════════════════════════════
function ExpertTrackView({ mode, onBack }) {
  const t = TRACKS[0];
  if (mode === 'live') {
    return (
      <Card style={{ padding: '18px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Pill color={c.accent} bg={c.accentLight} border={c.accentBorder} small>
            Proposal with the client
          </Pill>
          <span style={{ fontSize: 12.5, color: c.textTertiary }}>Submitted 3 Sep</span>
        </div>
        <p style={{ fontSize: 14, color: c.text, margin: '10px 0 0', lineHeight: 1.6 }}>
          Your proposal is with {REQUEST.company}. They can accept it, ask for changes, or decide
          not to proceed \u2014 you\u2019ll hear either way.
        </p>
        <div
          style={{
            marginTop: 12,
            padding: '10px 12px',
            borderRadius: 10,
            background: c.surfaceSubtle,
            display: 'flex',
            gap: 18,
            flexWrap: 'wrap',
          }}
        >
          <Money label="Your earnings" value={t.proposal.expert} />
          <Money label="Method" value={t.proposal.method} plain />
        </div>
      </Card>
    );
  }
  const declined = mode === 'declined';
  return (
    <Card style={{ padding: '22px 22px' }}>
      <span
        style={{
          width: 40,
          height: 40,
          borderRadius: 12,
          background: c.surfaceSubtle,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <I.xCircle size={18} color={c.textSecondary} />
      </span>
      <h3 style={{ fontSize: 17, fontWeight: 750, color: c.text, margin: '12px 0 0' }}>
        {declined
          ? `${REQUEST.company} isn\u2019t proceeding with your proposal`
          : `${REQUEST.company} closed this request`}
      </h3>
      <p
        style={{
          fontSize: 13.5,
          color: c.textSecondary,
          margin: '8px 0 0',
          lineHeight: 1.65,
          maxWidth: 520,
        }}
      >
        {declined
          ? 'They\u2019ve chosen a different direction. Your proposal is no longer under review, and the files you had access to stay exactly as they were. There\u2019s nothing further to do here.'
          : 'They\u2019ve stopped looking for an expert for this work. Your proposal was withdrawn along with the request, and the files you had access to stay exactly as they were. There\u2019s nothing further to do here.'}
      </p>
      <p style={{ fontSize: 12, color: c.textTertiary, margin: '10px 0 0' }}>
        {declined ? 'Declined 5 Sep 2026' : 'Closed 5 Sep 2026'}
      </p>
      <div style={{ marginTop: 16 }}>
        <TextLink icon={I.chevLeft} onClick={onBack}>
          Back to your projects
        </TextLink>
      </div>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════
// BALO PANEL (BAL-541) — owner + notes, admin lens only
// ══════════════════════════════════════════════════════════════════
function BaloPanel({ owner, setOwner, notes, onAddNote, onDeleteNote, readOnly, onToast }) {
  const [draft, setDraft] = useState('');
  return (
    <Card style={{ padding: 0, overflow: 'hidden', borderColor: c.accentBorder }}>
      <div
        style={{
          padding: '12px 16px',
          borderBottom: `1px solid ${c.borderSubtle}`,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <I.shield size={13} color={c.accent} />
        <span style={{ fontSize: 13, fontWeight: 750, color: c.accent }}>Balo</span>
        <span style={{ fontSize: 11.5, color: c.textTertiary, marginLeft: 'auto' }}>
          Staff only
        </span>
      </div>

      <div style={{ padding: '14px 16px', borderBottom: `1px solid ${c.borderSubtle}` }}>
        <p style={{ fontSize: 12, fontWeight: 700, color: c.textSecondary, margin: '0 0 6px' }}>
          Owner
        </p>
        <div style={{ position: 'relative' }}>
          <select
            className="balo-focus"
            value={owner}
            disabled={readOnly}
            onChange={(e) => {
              setOwner(e.target.value);
              onToast(
                e.target.value === 'Unassigned'
                  ? 'Owner cleared'
                  : `${e.target.value} is now the Balo owner`
              );
            }}
            style={{
              width: '100%',
              appearance: 'none',
              padding: '9px 34px 9px 12px',
              borderRadius: 10,
              border: `1px solid ${c.border}`,
              background: c.surface,
              fontSize: 13,
              fontWeight: 600,
              color: owner === 'Unassigned' ? c.textTertiary : c.text,
              fontFamily: 'inherit',
              cursor: readOnly ? 'default' : 'pointer',
            }}
          >
            {STAFF.map((s) => (
              <option key={s} value={s}>
                {s === 'Unassigned' ? 'Unassigned' : `${s} @ Balo`}
              </option>
            ))}
          </select>
          <I.chevDown
            size={14}
            color={c.textTertiary}
            style={{ position: 'absolute', right: 12, top: 11, pointerEvents: 'none' }}
          />
        </div>
      </div>

      <div style={{ padding: '14px 16px' }}>
        <p style={{ fontSize: 12, fontWeight: 700, color: c.textSecondary, margin: '0 0 10px' }}>
          Notes
        </p>
        {notes.length === 0 ? (
          <div
            style={{
              padding: '18px 12px',
              textAlign: 'center',
              borderRadius: 12,
              background: c.surfaceSubtle,
            }}
          >
            <p style={{ fontSize: 13.5, fontWeight: 700, color: c.text, margin: 0 }}>
              No notes yet
            </p>
            <p style={{ fontSize: 12.5, color: c.textSecondary, margin: '4px 0 0' }}>
              What should the next person at Balo know about this request?
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {notes.map((n) => (
              <div key={n.id} style={{ display: 'flex', gap: 10 }}>
                <Avatar name={n.author} size={26} tone="balo" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: c.text }}>
                      {n.author} @ Balo
                    </span>
                    <span style={{ fontSize: 11.5, color: c.textTertiary }}>{n.when}</span>
                    {!readOnly && (
                      <button
                        className="balo-focus"
                        onClick={() => onDeleteNote(n.id)}
                        title="Delete note"
                        style={{
                          marginLeft: 'auto',
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          padding: 2,
                        }}
                      >
                        <I.trash size={12} color={c.textTertiary} />
                      </button>
                    )}
                  </div>
                  <p style={{ fontSize: 13, color: c.text, margin: '3px 0 0', lineHeight: 1.55 }}>
                    {n.body}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
        {!readOnly && (
          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <textarea
              className="balo-focus"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              placeholder="Add a note for the team"
              style={{
                flex: 1,
                borderRadius: 10,
                border: `1px solid ${c.border}`,
                padding: '8px 11px',
                fontSize: 13,
                fontFamily: 'inherit',
                resize: 'none',
                color: c.text,
              }}
            />
            <Btn
              variant="ghost"
              small
              icon={I.send}
              disabled={draft.trim().length < 3}
              onClick={() => {
                onAddNote(draft.trim());
                setDraft('');
              }}
            >
              Add
            </Btn>
          </div>
        )}
      </div>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════
// PORTFOLIO EXCERPTS — where the new state shows up on the lists
// ══════════════════════════════════════════════════════════════════
function KanbanExcerpt({ owner, mine, setMine }) {
  const cards = [
    {
      title: REQUEST.title,
      company: REQUEST.company,
      owner: owner === 'Unassigned' ? null : owner,
      updated: '2h ago',
      stalled: null,
    },
    {
      title: 'Service Cloud case routing redesign',
      company: 'Meridian Retail',
      owner: 'Luke',
      updated: '3d ago',
      stalled: null,
    },
    {
      title: 'Marketing Cloud journeys audit',
      company: 'Pacific Retail Group',
      owner: null,
      updated: '6d ago',
      stalled: 'No EOIs · 6d',
    },
  ].filter((k) => !mine || k.owner === 'Adeeb');
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: c.textSecondary }}>
          Admin portfolio · Proposals column
        </span>
        <button
          className="balo-focus"
          onClick={() => setMine(!mine)}
          style={{
            marginLeft: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 11px',
            borderRadius: 20,
            border: `1px solid ${mine ? c.primaryBorder : c.border}`,
            background: mine ? c.primaryLight : c.surface,
            color: mine ? c.primary : c.textSecondary,
            fontSize: 12,
            fontWeight: 650,
            cursor: 'pointer',
          }}
        >
          <I.filter size={11} color={mine ? c.primary : c.textTertiary} />
          Mine
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {cards.length === 0 && (
          <p
            style={{
              fontSize: 12.5,
              color: c.textTertiary,
              margin: 0,
              padding: '14px 12px',
              background: c.surfaceSubtle,
              borderRadius: 12,
            }}
          >
            Nothing in Proposals is yours right now.
          </p>
        )}
        {cards.map((k) => (
          <Card key={k.title} style={{ padding: '10px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: c.text,
                    margin: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {k.title}
                </p>
                <p style={{ fontSize: 11.5, color: c.textTertiary, margin: '2px 0 0' }}>
                  {k.company} · {k.updated}
                  {k.stalled ? ` · ${k.stalled}` : ''}
                </p>
              </div>
              {k.owner ? (
                <Avatar name={k.owner} size={24} tone="balo" />
              ) : (
                <span
                  title="No Balo owner"
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    border: `1px dashed ${c.border}`,
                    display: 'inline-block',
                  }}
                />
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
function ClosedGroupExcerpt() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <p style={{ fontSize: 12, fontWeight: 700, color: c.textSecondary, margin: '0 0 10px' }}>
        Your projects
      </p>
      <Card style={{ overflow: 'hidden' }}>
        <div
          style={{
            padding: '12px 14px',
            borderBottom: `1px solid ${c.borderSubtle}`,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 13, fontWeight: 700, color: c.text, margin: 0 }}>
              Experience Cloud patient portal, phase 2
            </p>
            <p style={{ fontSize: 11.5, color: c.textTertiary, margin: '2px 0 0' }}>
              Inviting experts · updated 1d ago
            </p>
          </div>
          <Pill color={c.primary} bg={c.primaryLight} border={c.primaryBorder} small>
            Inviting
          </Pill>
        </div>
        <button
          className="balo-focus"
          onClick={() => setOpen(!open)}
          style={{
            width: '100%',
            textAlign: 'left',
            padding: '10px 14px',
            border: 'none',
            background: c.surfaceSubtle,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12.5,
            fontWeight: 650,
            color: c.textSecondary,
          }}
        >
          <I.chevDown
            size={13}
            color={c.textTertiary}
            style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
          />
          Closed · 1
        </button>
        {open && (
          <div
            style={{
              padding: '12px 14px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              opacity: 0.75,
            }}
          >
            <div style={{ flex: 1 }}>
              <p style={{ fontSize: 13, fontWeight: 700, color: c.text, margin: 0 }}>
                {REQUEST.title}
              </p>
              <p style={{ fontSize: 11.5, color: c.textTertiary, margin: '2px 0 0' }}>
                Withdrawn · closed 5 Sep
              </p>
            </div>
            <Pill icon={I.xCircle} small>
              Closed
            </Pill>
          </div>
        )}
      </Card>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// PAGE STAND-IN + ROOT
// ══════════════════════════════════════════════════════════════════
function RequestHeader({ viewer, closed, onClose }) {
  const stage = closed ? null : (
    <Pill color={c.accent} bg={c.accentLight} border={c.accentBorder} small>
      Proposals
    </Pill>
  );
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: 20, fontWeight: 800, color: c.text, margin: 0 }}>
            {REQUEST.title}
          </h1>
          {stage}
        </div>
        <p style={{ fontSize: 13, color: c.textTertiary, margin: '4px 0 0' }}>
          {REQUEST.company} · raised {REQUEST.raised} by {REQUEST.raisedBy} · {REQUEST.budget} ·{' '}
          {REQUEST.timeline}
        </p>
      </div>
      {!closed && viewer !== 'expert' && (
        <Btn variant="ghost" icon={I.xCircle} onClick={onClose}>
          Close request
        </Btn>
      )}
    </div>
  );
}

const STAGE_OPTIONS = {
  client: [
    { key: 'live', label: 'Live' },
    { key: 'closing', label: 'Closing' },
    { key: 'closed', label: 'Closed' },
  ],
  admin: [
    { key: 'live', label: 'Live' },
    { key: 'closing', label: 'Closing' },
    { key: 'closed', label: 'Closed' },
  ],
  expert: [
    { key: 'live', label: 'Live' },
    { key: 'declined', label: 'Declined' },
    { key: 'closed', label: 'Closed' },
  ],
};
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
      {items.map((it) => {
        const on = value === it.key;
        return (
          <button
            key={String(it.key)}
            className="balo-focus"
            onClick={() => onPick(it.key)}
            style={{
              padding: '7px 12px',
              borderRadius: 7,
              fontSize: 12.5,
              fontWeight: on ? 650 : 500,
              border: 'none',
              cursor: 'pointer',
              background: on ? c.surface : 'transparent',
              color: on ? c.text : c.textTertiary,
              boxShadow: on ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              whiteSpace: 'nowrap',
            }}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
const CtlLabel = ({ children }) => (
  <span style={{ fontSize: 11, fontWeight: 700, color: c.textTertiary, letterSpacing: '0.04em' }}>
    {children}
  </span>
);

export default function RequestCloseReference() {
  const [viewer, setViewer] = useState('client');
  const [stage, setStageRaw] = useState('live');
  const [mobile, setMobile] = useState(false);
  const [notesMode, setNotesMode] = useState('some');
  const [trackState, setTrackState] = useState({});
  const [sheet, setSheet] = useState(false);
  const [declineTarget, setDeclineTarget] = useState(null);
  const [closed, setClosed] = useState(null);
  const [owner, setOwner] = useState('Adeeb');
  const [notes, setNotes] = useState(NOTES_SEED);
  const [mine, setMine] = useState(false);
  const [toast, setToast] = useState(null);

  const say = (msg) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 3400);
  };
  const setStage = (s) => {
    setStageRaw(s);
    setSheet(s === 'closing');
    setDeclineTarget(null);
    if (s === 'closed') {
      setClosed({
        reason: viewer === 'admin' ? 'unfilled' : 'withdrawn',
        byViewer: viewer,
        note:
          viewer === 'admin'
            ? 'Two of three tracks went quiet; Dana confirmed the internal team will do it. Keep Priya warm for their Q1 work.'
            : '',
      });
      setTrackState(Object.fromEntries(TRACKS.map((t) => [t.id, { kind: 'ended' }])));
    } else {
      setClosed(null);
      setTrackState({});
    }
  };
  const pickViewer = (v) => {
    setViewer(v);
    setStageRaw('live');
    setSheet(false);
    setDeclineTarget(null);
    setClosed(null);
    setTrackState({});
  };
  const visibleNotes = notesMode === 'some' ? notes : [];
  const liveTracks = TRACKS.filter((t) => !trackState[t.id]);

  const confirmDecline = () => {
    const t = declineTarget;
    const byLabel =
      viewer === 'admin'
        ? `Declined by Adeeb @ Balo on ${REQUEST.company}\u2019s behalf`
        : `Declined by ${REQUEST.raisedBy} @ ${REQUEST.company}`;
    setTrackState((prev) => ({
      ...prev,
      [t.id]: {
        kind: 'declined',
        byLabel: t.stage === 'invited' ? byLabel.replace('Declined', 'Invite withdrawn') : byLabel,
        when: 'just now',
      },
    }));
    setDeclineTarget(null);
    say(
      t.stage === 'invited'
        ? `Invite withdrawn \u2014 ${t.party} has been told`
        : `Declined \u2014 ${t.party} has been told`
    );
  };
  const confirmClose = ({ reason, note }) => {
    setSheet(false);
    setStageRaw('closed');
    setClosed({ reason, byViewer: viewer, note });
    setTrackState(
      Object.fromEntries(TRACKS.map((t) => [t.id, trackState[t.id] ?? { kind: 'ended' }]))
    );
    say(
      `Request closed \u2014 ${liveTracks.length} ${liveTracks.length === 1 ? 'expert' : 'experts'} told`
    );
  };

  // ── The page ──
  const tracksList = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p style={{ fontSize: 12, fontWeight: 700, color: c.textSecondary, margin: 0 }}>
        Experts · {TRACKS.length}
      </p>
      {TRACKS.map((t) => (
        <TrackCard
          key={t.id}
          t={t}
          state={trackState[t.id]}
          viewer={viewer}
          frozen={!!closed}
          onNo={setDeclineTarget}
        />
      ))}
    </div>
  );
  let main;
  if (viewer === 'expert') {
    const mode = stage === 'live' ? 'live' : stage === 'declined' ? 'declined' : 'closed';
    main = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <RequestHeader viewer="expert" closed={stage === 'closed'} />
        <ExpertTrackView mode={mode} onBack={() => say('Opens /projects (expert lens)')} />
      </div>
    );
  } else {
    const balo = viewer === 'admin' && (
      <BaloPanel
        owner={owner}
        setOwner={setOwner}
        notes={visibleNotes}
        readOnly={false}
        onToast={say}
        onAddNote={(body) => {
          setNotes((prev) => [
            { id: `n${Date.now()}`, author: 'Adeeb', when: 'just now', body },
            ...prev,
          ]);
          setNotesMode('some');
          say('Note added');
        }}
        onDeleteNote={(id) => {
          setNotes((prev) => prev.filter((n) => n.id !== id));
          say('Note deleted');
        }}
      />
    );
    main = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <RequestHeader viewer={viewer} closed={!!closed} onClose={() => setSheet(true)} />
        {closed && (
          <ClosedBanner
            closed={closed}
            viewer={viewer}
            counts={{ tracks: TRACKS.length }}
            onNewRequest={() => say('Opens /projects/new')}
          />
        )}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: mobile || viewer !== 'admin' ? '1fr' : '1.6fr 1fr',
            gap: 16,
            alignItems: 'start',
          }}
        >
          {tracksList}
          {balo}
        </div>
        {!mobile && viewer === 'admin' && !closed && (
          <KanbanExcerpt owner={owner} mine={mine} setMine={setMine} />
        )}
        {!mobile && viewer === 'client' && closed && <ClosedGroupExcerpt />}
      </div>
    );
  }

  const overlays = (
    <>
      {sheet && (
        <CloseSheet
          viewer={viewer}
          liveTracks={liveTracks}
          inset={mobile}
          onCancel={() => {
            setSheet(false);
            if (stage === 'closing') setStageRaw('live');
          }}
          onConfirm={confirmClose}
        />
      )}
      {declineTarget && (
        <DeclineConfirm
          t={declineTarget}
          viewer={viewer}
          inset={mobile}
          onCancel={() => setDeclineTarget(null)}
          onConfirm={confirmDecline}
        />
      )}
    </>
  );
  const toastEl = toast && (
    <div
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 28,
        transform: 'translateX(-50%)',
        background: c.text,
        color: 'white',
        padding: '10px 16px',
        borderRadius: 12,
        fontSize: 13,
        fontWeight: 600,
        boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
        zIndex: 70,
        animation: 'toastIn 0.25s ease-out both',
      }}
    >
      {toast}
    </div>
  );

  return (
    <div
      style={{
        minHeight: '100vh',
        background: c.bg,
        fontFamily: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      <style>{keyframes}</style>
      <link
        href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800&display=swap"
        rel="stylesheet"
      />

      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 30,
          background: c.surface,
          borderBottom: `1px solid ${c.border}`,
          padding: '12px 24px',
        }}
      >
        <div
          style={{
            maxWidth: 1100,
            margin: '0 auto',
            display: 'flex',
            alignItems: 'center',
            gap: 18,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <CtlLabel>Viewer</CtlLabel>
            <Seg
              items={VIEWERS.map((v) => ({ key: v.key, label: v.label }))}
              value={viewer}
              onPick={pickViewer}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <CtlLabel>Stage</CtlLabel>
            <Seg items={STAGE_OPTIONS[viewer]} value={stage} onPick={setStage} />
          </div>
          {viewer === 'admin' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <CtlLabel>Notes</CtlLabel>
              <Seg
                items={[
                  { key: 'some', label: 'Some' },
                  { key: 'none', label: 'None yet' },
                ]}
                value={notesMode}
                onPick={setNotesMode}
              />
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
            <CtlLabel>View</CtlLabel>
            <Seg
              items={[
                { key: false, label: 'Desktop' },
                { key: true, label: 'Mobile' },
              ]}
              value={mobile}
              onPick={setMobile}
            />
          </div>
        </div>
      </div>

      {mobile ? (
        <div style={{ padding: '24px 16px' }}>
          <div
            style={{
              width: 390,
              maxWidth: '100%',
              height: 780,
              margin: '0 auto',
              background: c.bg,
              borderRadius: 36,
              border: '10px solid #0F1729',
              boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              position: 'relative',
            }}
          >
            <div style={{ height: 26, background: '#0F1729', flexShrink: 0 }} />
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 14px 28px' }}>{main}</div>
            {overlays}
          </div>
        </div>
      ) : (
        <div style={{ maxWidth: 1100, margin: '0 auto', padding: '28px 24px 80px' }}>{main}</div>
      )}
      {!mobile && overlays}
      {toastEl}
    </div>
  );
}
