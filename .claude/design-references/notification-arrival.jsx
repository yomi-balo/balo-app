import { useState, useEffect, useRef } from 'react';

/*
 * Notification arrival — design reference
 * Path: .claude/design-references/notification-arrival.jsx
 *
 * Problem: in-app notifications work but go unnoticed. Rather than auto-opening the panel
 * on page load, new notifications announce themselves with a toast and a bell ring, then
 * wait in the panel. Extends apps/web/src/components/balo/notification-bell.tsx (Popover,
 * 30s polling of /api/notifications?unread=true, read items drop out of the list).
 *
 * State model
 *  - read: the person opened it (user_notifications.read_at, unchanged). The badge and the
 *    tab title count unread.
 *  - seen: the person has been told about it (a toast showed it, or the panel was opened).
 *    users.notifications_last_seen_at, advanced by POST /api/notifications/seen { through }.
 *    A toast only ever covers unread items created after it, so each notification is
 *    announced once, across reloads and tabs. A NULL cursor initialises silently (no toast).
 *
 * Behaviour
 *  1. Full page load: about 0.7s after the page renders, toast whatever is unseen. One item
 *     gets an item toast with its own action; two or more get one collapsed toast that opens
 *     the panel. Then advance last-seen. Client-side route changes never toast.
 *  2. Live arrival: picked up by the existing 30s poll (slowed to 60s while the tab is hidden,
 *     so the tab title still updates; refetched at once on focus). Panel closed: toast, merging into one already
 *     showing. Panel open: the row flashes into the list, no toast. Already on the
 *     notification's page: mark it read, no toast, no ring. Ably push is a deferred follow-up.
 *  3. Visiting a notification's actionUrl path (query string ignored) marks it read, which
 *     covers email deep links. POST /api/notifications/read-by-path { path }.
 *  4. The bell rings once and the badge pings when unread goes up; the tab title gets an
 *     "(n) " prefix.
 *  5. The panel lists unread under "New" and recent read items under "Earlier".
 *  6. Toasts last 8s (single) or 10s (collapsed), pause on hover or focus, and never stack.
 *  7. prefers-reduced-motion: no ring, ping or slide.
 *  8. The toast button's label is derived from the actionUrl path ("Open case", "View project");
 *     no template changes. No actionUrl, no button.
 *
 * Analytics (PostHog): notification_toast_shown {count, trigger: load | live},
 * notification_toast_dismissed {count, reason: close | timeout},
 * notification_panel_opened {unread_count, source: bell | toast},
 * notification_clicked {event, source: panel | toast}, notification_auto_read {count}.
 *
 * Toast and panel are overlays, so they keep a soft shadow; cards stay flat.
 * The toast is rendered by NotificationBell, anchored under the bell, not by Sonner: the global
 * <Toaster position="top-center"> in app/layout.tsx is for action feedback.
 * The strip above the app (scenarios, unread/unseen readout, last analytics event) is
 * prototype chrome only.
 */

// ── Tokens (shared across Balo) ──────────────────────────────────
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
  accent: '#7C3AED',
  success: '#059669',
  cyan: '#0891B2',
  error: '#DC2626',
  gradient: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
  overlayShadow: '0 12px 32px rgba(17,24,39,0.10), 0 2px 6px rgba(17,24,39,0.06)',
};
const FONT = "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Same buckets as formatRelativeTime in notification-bell.tsx
function relTime(ts) {
  const diffMin = Math.floor((Date.now() - ts) / MIN);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const h = Math.floor(diffMin / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}
const byNewest = (a, b) => b.createdAt - a.createdAt;

// ── Icons (lucide paths) ─────────────────────────────────────────
function Svg({ size = 16, color = 'currentColor', children }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}
const Icons = {
  bell: (p) => (
    <Svg {...p}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </Svg>
  ),
  calendar: (p) => (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </Svg>
  ),
  message: (p) => (
    <Svg {...p}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </Svg>
  ),
  sparkles: (p) => (
    <Svg {...p}>
      <path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z" />
    </Svg>
  ),
  wallet: (p) => (
    <Svg {...p}>
      <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
      <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
    </Svg>
  ),
  link: (p) => (
    <Svg {...p}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </Svg>
  ),
  checkCheck: (p) => (
    <Svg {...p}>
      <path d="M18 6 7 17l-5-5" />
      <path d="m22 10-7.5 7.5L13 16" />
    </Svg>
  ),
  x: (p) => (
    <Svg {...p}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Svg>
  ),
  home: (p) => (
    <Svg {...p}>
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M9 22V12h6v10" />
    </Svg>
  ),
  video: (p) => (
    <Svg {...p}>
      <path d="m23 7-7 5 7 5V7z" />
      <rect x="1" y="5" width="15" height="14" rx="2" />
    </Svg>
  ),
  briefcase: (p) => (
    <Svg {...p}>
      <rect x="2" y="7" width="20" height="14" rx="2" />
      <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
    </Svg>
  ),
  sliders: (p) => (
    <Svg {...p}>
      <path d="M20 7h-9M14 17H5" />
      <circle cx="17" cy="17" r="3" />
      <circle cx="7" cy="7" r="3" />
    </Svg>
  ),
  user: (p) => (
    <Svg {...p}>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </Svg>
  ),
  chevronLeft: (p) => (
    <Svg {...p}>
      <path d="m15 18-6-6 6-6" />
    </Svg>
  ),
};

// ── Content ──────────────────────────────────────────────────────
const KINDS = {
  booking: { color: c.primary, tint: '#EFF6FF', icon: 'calendar' },
  message: { color: c.cyan, tint: '#ECFEFF', icon: 'message' },
  proposal: { color: c.accent, tint: '#F5F3FF', icon: 'sparkles' },
  payout: { color: c.success, tint: '#ECFDF5', icon: 'wallet' },
  setup: { color: c.textSecondary, tint: '#F1F4F8', icon: 'link' },
};

const NAV_TOP = [
  { key: 'dashboard', label: 'Dashboard', icon: 'home' },
  { key: 'cases', label: 'Cases', icon: 'video' },
  { key: 'projects', label: 'Projects', icon: 'briefcase' },
  { key: 'messages', label: 'Messages', icon: 'message' },
];
const NAV_BOTTOM = [
  { key: 'settings', label: 'Expert Settings', icon: 'sliders' },
  { key: 'account', label: 'Account', icon: 'user' },
];
const NAV_TITLES = {
  dashboard: 'Dashboard',
  cases: 'Cases',
  projects: 'Projects',
  messages: 'Messages',
  settings: 'Expert Settings',
  account: 'Account',
};

// Stand-ins for actionUrl destinations
const TARGETS = {
  'project:kestrel': {
    section: 'Projects',
    nav: 'projects',
    title: 'CPQ rollout',
    subtitle: 'Kestrel Energy',
  },
  'project:brightline': {
    section: 'Projects',
    nav: 'projects',
    title: 'Service Cloud audit',
    subtitle: 'Brightline Health',
  },
  'case:northwind': {
    section: 'Cases',
    nav: 'cases',
    title: 'Sandbox data migration',
    subtitle: 'Northwind Logistics',
  },
  'case:harbourview': {
    section: 'Cases',
    nav: 'cases',
    title: 'Flow error handling review',
    subtitle: 'Harbourview Bank',
  },
  'thread:daniel': {
    section: 'Messages',
    nav: 'messages',
    title: 'Daniel Okafor',
    subtitle: 'Brightline Health',
  },
  'thread:priya': {
    section: 'Messages',
    nav: 'messages',
    title: 'Priya Nair',
    subtitle: 'Northwind Logistics',
  },
  'settings:schedule': {
    section: 'Expert Settings',
    nav: 'settings',
    title: 'Schedule',
    subtitle: 'Calendars and availability',
  },
  'settings:payouts': {
    section: 'Expert Settings',
    nav: 'settings',
    title: 'Payouts',
    subtitle: 'Payout history',
  },
};

const N = {
  proposal: {
    id: 'n-proposal',
    kind: 'proposal',
    title: 'Proposal accepted',
    body: 'Congratulations! Sam Whitfield @Kestrel Energy accepted your proposal for the CPQ rollout.',
    short: 'an accepted proposal from Sam Whitfield',
    target: 'project:kestrel',
    actionLabel: 'View project',
  },
  booking: {
    id: 'n-booking',
    kind: 'booking',
    title: 'Consultation booked',
    body: 'Priya Nair @Northwind Logistics booked 30 minutes with you on Tue 27 Oct at 10:00 am.',
    short: 'a new booking from Priya Nair',
    target: 'case:northwind',
    actionLabel: 'Open case',
  },
  daniel: {
    id: 'n-daniel',
    kind: 'message',
    title: 'New message from Daniel Okafor @Brightline Health',
    body: 'Could we move Thursday’s call to the afternoon? Our admin is out until 1 pm.',
    short: 'a message from Daniel Okafor',
    target: 'thread:daniel',
    actionLabel: 'Reply',
  },
  payout: {
    id: 'n-payout',
    kind: 'payout',
    title: 'Your payout is on its way',
    body: 'The payout for the Discovery milestone of the Service Cloud audit has been sent to your bank.',
    short: 'a payout on its way',
    target: 'settings:payouts',
    actionLabel: 'View payouts',
  },
  calendar: {
    id: 'n-calendar',
    kind: 'setup',
    title: 'Calendar connected',
    body: 'Your Google Calendar is syncing, so busy times are blocked out for bookings.',
    short: 'a connected calendar',
    target: 'settings:schedule',
    actionLabel: 'View schedule',
  },
};

const LIVE = [
  {
    kind: 'message',
    title: 'New message from Priya Nair @Northwind Logistics',
    body: 'I’ve added the sandbox credentials to the case files.',
    short: 'a message from Priya Nair',
    target: 'thread:priya',
    actionLabel: 'Reply',
  },
  {
    kind: 'booking',
    title: 'Consultation booked',
    body: 'Mei Tanaka @Harbourview Bank booked 45 minutes with you on Fri 30 Oct at 2:30 pm.',
    short: 'a new booking from Mei Tanaka',
    target: 'case:harbourview',
    actionLabel: 'Open case',
  },
  {
    kind: 'message',
    title: 'New message from Priya Nair @Northwind Logistics',
    body: 'That worked, thanks. See you Tuesday.',
    short: 'a message from Priya Nair',
    target: 'thread:priya',
    actionLabel: 'Reply',
  },
];

function summarise(items) {
  const s = items.map((n) => n.short);
  const list = s.length <= 3 ? s : [...s.slice(0, 2), `${s.length - 2} more`];
  const text =
    list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

// ── Prototype scenarios ──────────────────────────────────────────
const SCENARIOS = [
  { key: 'away', label: 'Load after time away' },
  { key: 'one', label: 'Load with one new' },
  { key: 'email', label: 'Arrive from an email link' },
  { key: 'reload', label: 'Reload, nothing new' },
  { key: 'live', label: 'New one arrives now' },
];

const NOTES = {
  away: 'Three things happened since the last visit. One collapsed toast, the panel stays shut, and the bell rings once.',
  one: 'The badge shows 3 unread, but only one arrived since the last visit, so only that one toasts.',
  email:
    'Landed on the project from an email link. That notification is marked read on arrival, so only the other new one toasts.',
};

const make = (base, createdAt, readAt = null) => ({ ...base, createdAt, readAt });

function buildScenario(key, now) {
  const older = [
    make(N.payout, now - 4 * DAY, now - 4 * DAY + HOUR),
    make(N.calendar, now - 6 * DAY, now - 6 * DAY),
  ];
  if (key === 'away') {
    return {
      list: [
        make(N.proposal, now - 2 * HOUR),
        make(N.booking, now - DAY),
        make(N.daniel, now - 2 * DAY),
        ...older,
      ],
      seenAt: now - 3 * DAY,
      landing: 'dashboard',
    };
  }
  if (key === 'one') {
    return {
      list: [
        make(N.proposal, now - 20 * MIN),
        make(N.booking, now - 2 * DAY),
        make(N.daniel, now - 3 * DAY),
        ...older,
      ],
      seenAt: now - DAY,
      landing: 'dashboard',
    };
  }
  return {
    list: [
      make(N.proposal, now - 2 * HOUR),
      make(N.daniel, now - HOUR),
      make(N.booking, now - 3 * DAY),
      ...older,
    ],
    seenAt: now - DAY,
    landing: 'project:kestrel',
  };
}

// ── Styles needing pseudo-classes, keyframes or media queries ────
const css = `
@keyframes nbBellRing { 0%{transform:rotate(0)} 12%{transform:rotate(16deg)} 26%{transform:rotate(-13deg)} 40%{transform:rotate(9deg)} 54%{transform:rotate(-6deg)} 68%{transform:rotate(3deg)} 82%,100%{transform:rotate(0)} }
@keyframes nbPing { 0%{transform:scale(1);opacity:.5} 100%{transform:scale(2.2);opacity:0} }
@keyframes nbToastIn { from{opacity:0;transform:translateY(-10px)} to{opacity:1;transform:none} }
@keyframes nbPanelIn { from{opacity:0;transform:translateY(-4px) scale(.98)} to{opacity:1;transform:none} }
@keyframes nbRowFlash { 0%,40%{background:#EFF6FF} 100%{background:transparent} }
@keyframes nbShimmer { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
.bell-ring{animation:nbBellRing .9s ease-in-out;transform-origin:50% 3px}
.badge-ping{position:absolute;inset:-2px;border-radius:999px;background:#DC2626;animation:nbPing 1s ease-out 2 forwards;pointer-events:none}
.toast-in{animation:nbToastIn .28s cubic-bezier(.2,.8,.2,1)}
.panel-in{animation:nbPanelIn .16s ease-out;transform-origin:top right}
.nb-row{background:transparent;transition:background .12s}
.nb-row:hover{background:#F8FAFB}
.row-flash{animation:nbRowFlash 2.4s ease-out}
.nb-nav{background:transparent}
.nb-nav:hover{background:#F1F4F8}
.nb-chip{background:#fff;border:1px solid #E0E4EB;color:#111827;border-radius:8px;padding:5px 10px;font:inherit;font-size:12.5px;font-weight:500;cursor:pointer}
.nb-chip:hover{border-color:#BFDBFE;background:#EFF6FF}
.nb-primary{background:#2563EB;color:#fff;border:none;border-radius:8px;height:32px;padding:0 14px;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.nb-primary:hover{background:#1D4ED8}
.nb-ghost{background:transparent;border:none;border-radius:7px;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#9CA3AF}
.nb-ghost:hover{background:#F1F4F8;color:#4B5563}
.nb-focus:focus-visible{outline:2px solid #2563EB;outline-offset:2px}
.clamp2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sk{background:linear-gradient(90deg,#EAEFF5 25%,#F1F4F8 50%,#EAEFF5 75%);background-size:200% 100%;animation:nbShimmer 1.2s linear infinite;border-radius:6px}
@media (prefers-reduced-motion: reduce){
  .bell-ring,.toast-in,.panel-in,.row-flash,.sk{animation:none!important}
  .badge-ping{display:none}
}
`;

// ══════════════════════════════════════════════════════════════════
// NOTIFICATION PIECES (the part to build)
// ══════════════════════════════════════════════════════════════════

function KindBadge({ kind, size = 32, dim, ring }) {
  const k = KINDS[kind];
  const Ico = Icons[k.icon];
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        background: k.tint,
        border: ring ? '2px solid #fff' : `1px solid ${k.color}26`,
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        opacity: dim ? 0.6 : 1,
      }}
    >
      <Ico size={Math.round(size * 0.47)} color={k.color} />
    </div>
  );
}

function StackedBadges({ items }) {
  const shown = items.slice(0, 3);
  return (
    <div style={{ display: 'flex', flexShrink: 0, paddingTop: 2 }}>
      {shown.map((n, i) => (
        <div
          key={n.id}
          style={{ marginLeft: i ? -12 : 0, position: 'relative', zIndex: shown.length - i }}
        >
          <KindBadge kind={n.kind} size={32} ring />
        </div>
      ))}
    </div>
  );
}

function BellMenu({ unread, ringKey, open, onToggle, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (e.target.closest && e.target.closest('[data-proto]')) return;
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className="nb-focus"
        onClick={onToggle}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        aria-haspopup="dialog"
        style={{
          width: 36,
          height: 36,
          padding: 0,
          borderRadius: 10,
          border: `1px solid ${open ? c.primaryBorder : c.border}`,
          background: open ? c.primaryLight : c.surface,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          cursor: 'pointer',
        }}
      >
        <span
          key={`bell-${ringKey}`}
          className={ringKey ? 'bell-ring' : undefined}
          style={{ display: 'inline-flex' }}
        >
          <Icons.bell size={17} color={open ? c.primary : unread ? c.text : c.textTertiary} />
        </span>
        {unread > 0 && (
          <span
            style={{
              position: 'absolute',
              top: -7,
              right: -7,
              minWidth: 19,
              height: 19,
              padding: '0 5px',
              boxSizing: 'border-box',
              borderRadius: 10,
              border: '2px solid #fff',
              background: c.error,
              color: '#fff',
              fontSize: 10.5,
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {ringKey > 0 && <span key={`ping-${ringKey}`} className="badge-ping" />}
            <span style={{ position: 'relative' }}>{unread > 9 ? '9+' : unread}</span>
          </span>
        )}
      </button>
      {open && children}
    </div>
  );
}

function PanelRow({ n, flash, onOpen }) {
  const unread = !n.readAt;
  return (
    <button
      type="button"
      className={`nb-focus nb-row${flash ? ' row-flash' : ''}`}
      onClick={() => onOpen(n)}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        width: '100%',
        padding: '11px 16px',
        border: 'none',
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      <KindBadge kind={n.kind} size={32} dim={!unread} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontSize: 13,
            lineHeight: 1.35,
            fontWeight: unread ? 600 : 500,
            color: unread ? c.text : c.textSecondary,
          }}
        >
          {n.title}
        </p>
        <p
          className="clamp2"
          style={{ margin: '3px 0 0', fontSize: 12.5, lineHeight: 1.45, color: c.textSecondary }}
        >
          {n.body}
        </p>
        <p style={{ margin: '5px 0 0', fontSize: 11.5, color: c.textTertiary }}>
          {relTime(n.createdAt)}
        </p>
      </div>
      <span
        aria-label={unread ? 'Unread' : undefined}
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          marginTop: 6,
          flexShrink: 0,
          background: unread ? c.primary : 'transparent',
        }}
      />
    </button>
  );
}

function GroupLabel({ children }) {
  return (
    <p
      style={{
        margin: 0,
        padding: '12px 16px 4px',
        fontSize: 12,
        fontWeight: 600,
        color: c.textTertiary,
      }}
    >
      {children}
    </p>
  );
}

function NotificationPanel({ items, flashId, onOpen, onMarkAll }) {
  const fresh = items.filter((n) => !n.readAt);
  const earlier = items.filter((n) => n.readAt).slice(0, 5);
  return (
    <div
      role="dialog"
      aria-label="Notifications"
      className="panel-in"
      style={{
        position: 'absolute',
        top: 46,
        right: 0,
        width: 380,
        maxWidth: 'calc(100vw - 32px)',
        background: c.surface,
        border: `1px solid ${c.border}`,
        borderRadius: 14,
        boxShadow: c.overlayShadow,
        overflow: 'hidden',
        zIndex: 30,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '13px 12px 11px 16px',
          borderBottom: `1px solid ${c.borderSubtle}`,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Notifications</h2>
        {fresh.length > 0 && (
          <button
            type="button"
            className="nb-focus nb-ghost"
            onClick={onMarkAll}
            style={{
              gap: 5,
              padding: '4px 8px',
              fontSize: 12,
              fontWeight: 500,
              color: c.textSecondary,
              fontFamily: 'inherit',
            }}
          >
            <Icons.checkCheck size={13} /> Mark all read
          </button>
        )}
      </div>
      <div style={{ maxHeight: 440, overflowY: 'auto', paddingBottom: 6 }}>
        {fresh.length > 0 ? (
          <>
            <GroupLabel>New</GroupLabel>
            {fresh.map((n) => (
              <PanelRow key={n.id} n={n} flash={n.id === flashId} onOpen={onOpen} />
            ))}
          </>
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '16px 16px 6px',
              fontSize: 13,
              color: c.textSecondary,
            }}
          >
            <Icons.checkCheck size={15} color={c.success} /> You’re all caught up.
          </div>
        )}
        {earlier.length > 0 && (
          <>
            <GroupLabel>Earlier</GroupLabel>
            {earlier.map((n) => (
              <PanelRow key={n.id} n={n} flash={false} onOpen={onOpen} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function ArrivalToast({ items, trigger, onOpen, onOpenPanel, onDismiss }) {
  const [paused, setPaused] = useState(false);
  const single = items.length === 1;
  useEffect(() => {
    if (paused) return undefined;
    const t = setTimeout(() => onDismiss('timeout'), single ? 8000 : 10000);
    return () => clearTimeout(t);
  }, [paused, single]); // eslint-disable-line react-hooks/exhaustive-deps

  const first = items[0];
  const heading =
    trigger === 'load'
      ? `${items.length} updates since your last visit`
      : `${items.length} new updates`;

  return (
    <div
      role="status"
      aria-live="polite"
      className="toast-in"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      style={{
        position: 'absolute',
        top: 72,
        right: 24,
        width: 360,
        maxWidth: 'calc(100% - 32px)',
        boxSizing: 'border-box',
        padding: 14,
        background: c.surface,
        border: `1px solid ${c.border}`,
        borderRadius: 14,
        boxShadow: c.overlayShadow,
        zIndex: 25,
      }}
    >
      <button
        type="button"
        className="nb-focus nb-ghost"
        aria-label="Dismiss"
        onClick={() => onDismiss('close')}
        style={{ position: 'absolute', top: 10, right: 10, width: 26, height: 26, padding: 0 }}
      >
        <Icons.x size={14} />
      </button>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        {single ? <KindBadge kind={first.kind} size={36} /> : <StackedBadges items={items} />}
        <div style={{ flex: 1, minWidth: 0, paddingRight: 22 }}>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 600, lineHeight: 1.35 }}>
            {single ? first.title : heading}
          </p>
          <p
            className="clamp2"
            style={{ margin: '4px 0 0', fontSize: 13, lineHeight: 1.45, color: c.textSecondary }}
          >
            {single ? first.body : summarise(items)}
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
            {single ? (
              <button type="button" className="nb-focus nb-primary" onClick={() => onOpen(first)}>
                {first.actionLabel}
              </button>
            ) : (
              <button type="button" className="nb-focus nb-primary" onClick={onOpenPanel}>
                Open notifications
              </button>
            )}
            <span style={{ fontSize: 12, color: c.textTertiary }}>{relTime(first.createdAt)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// APP SHELL (context only)
// ══════════════════════════════════════════════════════════════════

function Sidebar({ active, onNavigate }) {
  const item = (n, bottom) => {
    const on = active === n.key;
    const Ico = Icons[n.icon];
    return (
      <button
        key={n.key}
        type="button"
        className="nb-focus nb-nav"
        onClick={() => onNavigate(n.key)}
        aria-current={on ? 'page' : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          width: '100%',
          padding: '9px 12px',
          marginBottom: 2,
          borderRadius: 9,
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'inherit',
          fontSize: 13,
          fontWeight: on ? 600 : 500,
          color: on ? c.primary : bottom ? c.textTertiary : c.textSecondary,
          background: on ? c.primaryLight : undefined,
        }}
      >
        <Ico size={bottom ? 16 : 17} color={on ? c.primary : c.textTertiary} />
        {n.label}
      </button>
    );
  };
  return (
    <nav
      aria-label="Main"
      style={{
        width: 224,
        flexShrink: 0,
        background: c.surface,
        borderRight: `1px solid ${c.border}`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ padding: '18px 16px 20px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: c.gradient,
            color: '#fff',
            fontSize: 14,
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          B
        </div>
        <span style={{ fontSize: 17, fontWeight: 700 }}>Balo</span>
      </div>
      <div style={{ padding: '0 8px', flex: 1 }}>{NAV_TOP.map((n) => item(n, false))}</div>
      <div style={{ padding: 8, borderTop: `1px solid ${c.borderSubtle}` }}>
        {NAV_BOTTOM.map((n) => item(n, true))}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            marginTop: 6,
          }}
        >
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: c.gradient,
              color: '#fff',
              fontSize: 11,
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            YJ
          </div>
          <div>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Yomi Joseph</p>
            <p style={{ margin: 0, fontSize: 11, color: c.textTertiary }}>Expert</p>
          </div>
        </div>
      </div>
    </nav>
  );
}

function Card({ title, children }) {
  return (
    <section
      style={{
        background: c.surface,
        border: `1px solid ${c.border}`,
        borderRadius: 14,
        padding: '18px 20px',
      }}
    >
      {title && <h3 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 600 }}>{title}</h3>}
      {children}
    </section>
  );
}

function ListRow({ primary, secondary, meta, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      className={onClick ? 'nb-focus nb-row' : undefined}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: 'calc(100% + 16px)',
        margin: '0 -8px',
        padding: '10px 8px',
        border: 'none',
        borderRadius: 8,
        textAlign: 'left',
        cursor: onClick ? 'pointer' : 'default',
        fontFamily: 'inherit',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: 13.5, fontWeight: 500, color: c.text }}>{primary}</p>
        <p style={{ margin: '2px 0 0', fontSize: 12.5, color: c.textSecondary }}>{secondary}</p>
      </div>
      <span style={{ fontSize: 12, color: c.textTertiary }}>{meta}</span>
    </Tag>
  );
}

function Dashboard({ onNavigate }) {
  return (
    <div style={{ maxWidth: 880 }}>
      <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Welcome back, Yomi</h2>
      <p style={{ margin: '4px 0 24px', fontSize: 14, color: c.textSecondary }}>
        Here’s your week at a glance.
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 16,
        }}
      >
        <Card title="Upcoming consultations">
          <ListRow
            primary="Tue 27 Oct, 10:00 am"
            secondary="Priya Nair @Northwind Logistics"
            meta="30 min"
            onClick={() => onNavigate('case:northwind')}
          />
          <ListRow
            primary="Thu 29 Oct, 9:30 am"
            secondary="Daniel Okafor @Brightline Health"
            meta="45 min"
          />
        </Card>
        <Card title="Active projects">
          <ListRow
            primary="CPQ rollout"
            secondary="Kestrel Energy"
            meta="Kickoff"
            onClick={() => onNavigate('project:kestrel')}
          />
          <ListRow
            primary="Service Cloud audit"
            secondary="Brightline Health"
            meta="In delivery"
            onClick={() => onNavigate('project:brightline')}
          />
        </Card>
      </div>
    </div>
  );
}

function DetailPage({ target, onBack }) {
  return (
    <div style={{ maxWidth: 880 }}>
      <button
        type="button"
        className="nb-focus nb-ghost"
        onClick={onBack}
        style={{
          gap: 4,
          padding: '4px 8px 4px 4px',
          margin: '0 0 12px -4px',
          fontSize: 13,
          color: c.textSecondary,
          fontFamily: 'inherit',
        }}
      >
        <Icons.chevronLeft size={15} /> {target.section}
      </button>
      <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{target.title}</h2>
      <p style={{ margin: '4px 0 24px', fontSize: 14, color: c.textSecondary }}>
        {target.subtitle}
      </p>
      <Card>
        {[92, 76, 84, 58].map((w, i) => (
          <div
            key={w}
            style={{
              height: 10,
              width: `${w}%`,
              marginTop: i ? 14 : 0,
              background: c.borderSubtle,
              borderRadius: 5,
            }}
          />
        ))}
      </Card>
    </div>
  );
}

function IndexPage({ title }) {
  return (
    <div style={{ maxWidth: 880 }}>
      <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{title}</h2>
      <p style={{ margin: '4px 0 0', fontSize: 14, color: c.textSecondary }}>
        Outside this prototype. Use a notification or the dashboard to move around.
      </p>
    </div>
  );
}

function Skeleton() {
  return (
    <div style={{ maxWidth: 880 }} aria-hidden="true">
      <div className="sk" style={{ height: 22, width: 260 }} />
      <div className="sk" style={{ height: 14, width: 200, marginTop: 10 }} />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 16,
          marginTop: 24,
        }}
      >
        <div className="sk" style={{ height: 150, borderRadius: 14 }} />
        <div className="sk" style={{ height: 150, borderRadius: 14 }} />
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// PROTOTYPE CHROME (not for implementation)
// ══════════════════════════════════════════════════════════════════

function Stat({ label, value }) {
  return (
    <span
      style={{
        fontSize: 12,
        color: c.textSecondary,
        background: c.surface,
        border: `1px solid ${c.border}`,
        borderRadius: 6,
        padding: '3px 8px',
        whiteSpace: 'nowrap',
      }}
    >
      {label} <strong style={{ color: c.text, fontWeight: 600 }}>{value}</strong>
    </span>
  );
}

function PrototypeBar({ onRun, unread, unseen, lastSeenAt, note, lastEvent }) {
  return (
    <div
      data-proto=""
      style={{
        flexShrink: 0,
        padding: '10px 16px',
        background: c.surfaceSubtle,
        borderBottom: `1px dashed ${c.border}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            color: c.accent,
            background: '#F5F3FF',
            border: '1px solid #DDD6FE',
            borderRadius: 6,
            padding: '3px 8px',
          }}
        >
          Prototype
        </span>
        {SCENARIOS.map((s) => (
          <button
            key={s.key}
            type="button"
            className="nb-focus nb-chip"
            onClick={() => onRun(s.key)}
          >
            {s.label}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Stat label="Unread" value={unread} />
          <Stat label="Unseen" value={unseen} />
          <Stat label="Last seen" value={relTime(lastSeenAt)} />
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 16,
          marginTop: 8,
          minHeight: 18,
          flexWrap: 'wrap',
        }}
      >
        <p
          style={{
            margin: 0,
            flex: '1 1 320px',
            fontSize: 12.5,
            lineHeight: 1.5,
            color: c.textSecondary,
          }}
        >
          {note}
        </p>
        {lastEvent && (
          <code
            style={{
              fontSize: 11.5,
              color: c.textTertiary,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          >
            {lastEvent.name} {JSON.stringify(lastEvent.props || {})}
          </code>
        )}
      </div>
    </div>
  );
}

function BrowserTab({ title }) {
  return (
    <div
      data-proto=""
      style={{ flexShrink: 0, display: 'flex', padding: '6px 12px 0', background: '#E8ECF1' }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          maxWidth: 280,
          padding: '6px 14px',
          borderRadius: '8px 8px 0 0',
          background: c.surface,
          fontSize: 12,
          color: c.textSecondary,
        }}
      >
        <span
          style={{
            width: 14,
            height: 14,
            flexShrink: 0,
            borderRadius: 4,
            background: c.gradient,
            color: '#fff',
            fontSize: 9,
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          B
        </span>
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {title}
        </span>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════

export default function NotificationArrival() {
  const [notifs, setNotifs] = useState([]);
  const [lastSeenAt, setLastSeenAt] = useState(() => Date.now());
  const [page, setPage] = useState('dashboard');
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null); // { ids, trigger: 'load' | 'live', key }
  const [panelOpen, setPanelOpen] = useState(false);
  const [ringKey, setRingKey] = useState(0);
  const [flashId, setFlashId] = useState(null);
  const [note, setNote] = useState('');
  const [lastEvent, setLastEvent] = useState(null);
  const [, setTick] = useState(0);
  const timers = useRef([]);
  const liveIndex = useRef(0);

  const sorted = [...notifs].sort(byNewest);
  const unread = notifs.filter((n) => !n.readAt).length;
  const unseen = notifs.filter((n) => !n.readAt && n.createdAt > lastSeenAt).length;
  const toastItems = toast
    ? toast.ids.map((id) => notifs.find((n) => n.id === id)).filter((n) => n && !n.readAt)
    : [];

  const later = (ms, fn) => {
    timers.current.push(setTimeout(fn, ms));
  };
  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  const track = (name, props) => setLastEvent({ name, props });

  // A full page load (hard reload, new tab, email deep link). Client-side navigation never calls this.
  const runLoad = (list, seenAt, landing, scenarioNote) => {
    clearTimers();
    const t = Date.now();
    setPanelOpen(false);
    setToast(null);
    setFlashId(null);
    // Visiting a notification's actionUrl marks it read
    const next = list.map((n) => (!n.readAt && n.target === landing ? { ...n, readAt: t } : n));
    const fresh = next.filter((n) => !n.readAt && n.createdAt > seenAt).sort(byNewest);
    setNotifs(next);
    setLastSeenAt(seenAt);
    setPage(landing);
    setLoading(true);
    setNote(scenarioNote || '');
    later(450, () => setLoading(false));
    later(1150, () => {
      if (fresh.length === 0) {
        setNote(
          'Nothing new since the last visit, so the reload stays quiet. The badge still shows what’s unread.'
        );
        return;
      }
      setToast({ ids: fresh.map((n) => n.id), trigger: 'load', key: Date.now() });
      setRingKey((k) => k + 1);
      setLastSeenAt(Date.now());
      track('notification_toast_shown', { count: fresh.length, trigger: 'load' });
    });
  };

  useEffect(() => {
    const s = buildScenario('away', Date.now());
    runLoad(s.list, s.seenAt, s.landing, NOTES.away);
    const tick = setInterval(() => setTick((x) => x + 1), 20000);
    return () => {
      clearTimers();
      clearInterval(tick);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const navigate = (to) => {
    const t = Date.now();
    setNotifs((prev) => prev.map((n) => (!n.readAt && n.target === to ? { ...n, readAt: t } : n)));
    setPage(to);
  };

  const openNotification = (n, source) => {
    setPanelOpen(false);
    setToast(null);
    navigate(n.target);
    track('notification_clicked', { event: n.kind, source });
  };

  const openPanel = (source) => {
    setPanelOpen(true);
    setToast(null);
    setFlashId(null);
    setLastSeenAt(Date.now());
    track('notification_panel_opened', { unread_count: unread, source });
  };
  const closePanel = () => setPanelOpen(false);

  const dismissToast = (reason) => {
    setToast(null);
    track('notification_toast_dismissed', { count: toastItems.length, reason });
  };

  const markAllRead = () => {
    const t = Date.now();
    setNotifs((prev) => prev.map((n) => (n.readAt ? n : { ...n, readAt: t })));
  };

  // Next poll (or tab refocus) finds a new unseen item → this
  const arrive = () => {
    const base = LIVE[liveIndex.current % LIVE.length];
    liveIndex.current += 1;
    const t = Date.now();
    const n = { ...base, id: `live-${t}`, createdAt: t, readAt: null };

    if (page === n.target) {
      setNotifs((prev) => [{ ...n, readAt: t }, ...prev]);
      setNote('You’re already on that page, so it’s marked read with no toast and no ring.');
      return;
    }

    setNotifs((prev) => [n, ...prev]);
    setRingKey((k) => k + 1);
    setLastSeenAt(t);

    if (panelOpen) {
      setFlashId(n.id);
      setNote('The panel is open, so the new item flashes into the list instead of toasting.');
      return;
    }

    const merging = toastItems.length > 0;
    setToast((prev) => ({ ids: prev ? [n.id, ...prev.ids] : [n.id], trigger: 'live', key: t }));
    setNote(
      merging
        ? 'A second arrival merges into the toast already showing, so toasts never stack.'
        : 'Arrived while you were here. The bell rings, the badge goes up, and one toast appears.'
    );
    track('notification_toast_shown', { count: toastItems.length + 1, trigger: 'live' });
  };

  const runScenario = (key) => {
    if (key === 'live') {
      arrive();
      return;
    }
    if (key === 'reload') {
      runLoad(notifs, lastSeenAt, page);
      return;
    }
    const s = buildScenario(key, Date.now());
    runLoad(s.list, s.seenAt, s.landing, NOTES[key]);
  };

  const target = TARGETS[page];
  const activeNav = target ? target.nav : page;
  const barTitle = target ? target.section : NAV_TITLES[page];
  const tabTitle = `${unread ? `(${unread}) ` : ''}${target ? target.title : NAV_TITLES[page]} | Balo`;

  let body;
  if (loading) body = <Skeleton />;
  else if (target) body = <DetailPage target={target} onBack={() => navigate(target.nav)} />;
  else if (page === 'dashboard') body = <Dashboard onNavigate={navigate} />;
  else body = <IndexPage title={NAV_TITLES[page]} />;

  return (
    <div
      style={{
        height: '100vh',
        minHeight: 620,
        display: 'flex',
        flexDirection: 'column',
        background: c.bg,
        color: c.text,
        fontFamily: FONT,
      }}
    >
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap"
      />
      <style>{css}</style>

      <PrototypeBar
        onRun={runScenario}
        unread={unread}
        unseen={unseen}
        lastSeenAt={lastSeenAt}
        note={note}
        lastEvent={lastEvent}
      />
      <BrowserTab title={tabTitle} />

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <Sidebar active={activeNav} onNavigate={navigate} />

        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
          }}
        >
          <header
            style={{
              height: 64,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0 32px',
              borderBottom: `1px solid ${c.borderSubtle}`,
              background: c.surface,
              position: 'relative',
              zIndex: 20,
            }}
          >
            <h1 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>{barTitle}</h1>
            <BellMenu
              unread={unread}
              ringKey={ringKey}
              open={panelOpen}
              onToggle={() => (panelOpen ? closePanel() : openPanel('bell'))}
              onClose={closePanel}
            >
              <NotificationPanel
                items={sorted}
                flashId={flashId}
                onOpen={(n) => openNotification(n, 'panel')}
                onMarkAll={markAllRead}
              />
            </BellMenu>
          </header>

          <main style={{ flex: 1, overflowY: 'auto', padding: '28px 32px' }}>{body}</main>

          {toastItems.length > 0 && !panelOpen && (
            <ArrivalToast
              key={toast.key}
              items={toastItems}
              trigger={toast.trigger}
              onOpen={(n) => openNotification(n, 'toast')}
              onOpenPanel={() => openPanel('toast')}
              onDismiss={dismissToast}
            />
          )}
        </div>
      </div>
    </div>
  );
}
