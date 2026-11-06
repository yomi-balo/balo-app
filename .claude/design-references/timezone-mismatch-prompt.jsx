import { useEffect, useMemo, useState } from 'react';

/**
 * Travelling experts — timezone mismatch dialog (design reference).
 *
 * ONE decision, in ONE dialog, opened by the dashboard layout over whatever page the
 * expert is on: keep the hours in the saved zone, or switch them to the device zone.
 * The dialog carries the consequences of switching (clocks, converted hours, the
 * consultations that would fall outside, time off), so there is no second confirm step.
 * Two passive hints remain where the zone is on screen anyway: a note on the Schedule
 * tab's timezone line, and the Calendar chip's existing info icon.
 *
 * Scenario: hours saved in Sydney, device in London. Clocks and conversions are live
 * (Intl), so daylight saving is applied correctly whenever this file is opened.
 *
 * Controls: "Page" picks where the expert is; "Situation" is shared across pages, so
 * choosing Keep on one page closes the dialog everywhere, exactly as in the app.
 */

// ── Design tokens (shared across Balo) ────────────────────────────
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
  accent: '#7C3AED',
  success: '#059669',
  successLight: '#ECFDF5',
  successBorder: '#A7F3D0',
  warning: '#D97706',
  warningLight: '#FFFBEB',
  warningBorder: '#FDE68A',
};

const CSS = `
@keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
@keyframes dropIn { from { opacity: 0; transform: translateY(-6px) } to { opacity: 1; transform: translateY(0) } }
@keyframes scaleIn { from { opacity: 0; transform: scale(0.97) } to { opacity: 1; transform: scale(1) } }
@keyframes spin { to { transform: rotate(360deg) } }
.bl-btn:focus-visible { outline: 2px solid #2563EB; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`;

// ── Scenario ──────────────────────────────────────────────────────
const SCHEDULE_TZ = 'Australia/Sydney';
const SCHEDULE_CITY = 'Sydney';
const DEVICE_TZ = 'Europe/London';
const DEVICE_CITY = 'London';

// ── Timezone helpers (Intl only, same approach as @balo/shared/timezone) ──
const formatterCache = new Map();
function wallParts(tz, date) {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(tz, f);
  }
  const out = {};
  for (const p of f.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  if (out.hour === 24) out.hour = 0;
  return out;
}

/** Minutes `tz` is ahead of UTC at `date`. */
function offsetMin(tz, date) {
  const p = wallParts(tz, date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** The instant a wall-clock time in `tz` happens. */
function wallToUtc(tz, y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - offsetMin(tz, new Date(guess)) * 60000;
  return new Date(guess - offsetMin(tz, new Date(first)) * 60000);
}

/** `days` after today in `tz`, at h:mi wall-clock time in `tz`. */
function addDaysAt(tz, base, days, h, mi) {
  const p = wallParts(tz, base);
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return wallToUtc(tz, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, mi);
}

function fmt(date, tz, opts) {
  return new Intl.DateTimeFormat('en-AU', { timeZone: tz, ...opts }).format(date);
}
const fmtTime = (date, tz) => fmt(date, tz, { hour: 'numeric', minute: '2-digit' });
const fmtDay = (date, tz) => fmt(date, tz, { weekday: 'short', day: 'numeric', month: 'short' });

function gmtLabel(tz, now) {
  const off = offsetMin(tz, now);
  if (off === 0) return 'GMT';
  const sign = off > 0 ? '+' : '−';
  const h = Math.floor(Math.abs(off) / 60);
  const m = Math.abs(off) % 60;
  return `GMT${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}
const zoneLabel = (city, tz, now) => `${city} (${gmtLabel(tz, now)})`;

function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(id);
  }, []);
  return now;
}

// ── Mock consultations (booked in Sydney business hours) ──────────
const MEETING_SPECS = [
  {
    h: 10,
    m: 0,
    dur: 60,
    company: 'Northwind Logistics',
    caseTitle: 'Service Cloud data migration',
  },
  { h: 14, m: 30, dur: 30, company: 'Acme Health', caseTitle: 'CPQ pricing rules' },
  { h: 11, m: 0, dur: 45, company: 'Brightline Energy', caseTitle: 'Marketing Cloud journeys' },
  { h: 9, m: 30, dur: 60, company: 'Harbour Bank', caseTitle: 'Flow error handling' },
  { h: 15, m: 0, dur: 30, company: 'Kestrel Retail', caseTitle: 'Experience Cloud login' },
  {
    h: 10,
    m: 0,
    dur: 60,
    company: 'Northwind Logistics',
    caseTitle: 'Service Cloud data migration',
  },
  { h: 16, m: 0, dur: 30, company: 'Acme Health', caseTitle: 'CPQ pricing rules' },
];

function buildMeetings(now) {
  const offsets = [];
  for (let i = 1; offsets.length < MEETING_SPECS.length && i < 30; i++) {
    const weekday = fmt(addDaysAt(SCHEDULE_TZ, now, i, 12, 0), SCHEDULE_TZ, { weekday: 'short' });
    if (weekday !== 'Sat' && weekday !== 'Sun') offsets.push(i);
  }
  return MEETING_SPECS.map((spec, i) => {
    const start = addDaysAt(SCHEDULE_TZ, now, offsets[i], spec.h, spec.m);
    return { ...spec, start, end: new Date(start.getTime() + spec.dur * 60000) };
  });
}

const dayRange = (m, tz) =>
  `${fmtDay(m.start, tz)}, ${fmtTime(m.start, tz)} – ${fmtTime(m.end, tz)}`;

// ── Icons ─────────────────────────────────────────────────────────
function Svg({ size = 16, color = 'currentColor', style, children }) {
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
      style={style}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}
const Icons = {
  globe: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10A15.3 15.3 0 0112 2z" />
    </Svg>
  ),
  clock: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </Svg>
  ),
  calendar: (p) => (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </Svg>
  ),
  check: (p) => (
    <Svg {...p}>
      <path d="M20 6L9 17l-5-5" />
    </Svg>
  ),
  info: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </Svg>
  ),
  alert: (p) => (
    <Svg {...p}>
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </Svg>
  ),
  chevRight: (p) => (
    <Svg {...p}>
      <path d="M9 18l6-6-6-6" />
    </Svg>
  ),
  spinner: (p) => (
    <Svg {...p} style={{ animation: 'spin 0.9s linear infinite', ...p.style }}>
      <path d="M21 12a9 9 0 11-6.22-8.56" />
    </Svg>
  ),
  home: (p) => (
    <Svg {...p}>
      <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      <path d="M9 22V12h6v10" />
    </Svg>
  ),
  briefcase: (p) => (
    <Svg {...p}>
      <rect x="2" y="7" width="20" height="14" rx="2" />
      <path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16" />
    </Svg>
  ),
  folder: (p) => (
    <Svg {...p}>
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    </Svg>
  ),
  message: (p) => (
    <Svg {...p}>
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </Svg>
  ),
  sliders: (p) => (
    <Svg {...p}>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
    </Svg>
  ),
  user: (p) => (
    <Svg {...p}>
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </Svg>
  ),
  menu: (p) => (
    <Svg {...p}>
      <path d="M3 12h18M3 6h18M3 18h18" />
    </Svg>
  ),
};

// ── Primitives (flat cards, solid --primary on settings surfaces) ──
function Card({ children, style }) {
  return (
    <div
      style={{ background: c.surface, border: `1px solid ${c.border}`, borderRadius: 14, ...style }}
    >
      {children}
    </div>
  );
}

function Button({ variant = 'outline', onClick, disabled, full, children }) {
  const [hover, setHover] = useState(false);
  const active = hover && !disabled;
  const variants = {
    primary: {
      background: active ? c.primaryDark : c.primary,
      color: '#FFFFFF',
      border: '1px solid transparent',
    },
    outline: {
      background: active ? c.surfaceSubtle : c.surface,
      color: c.text,
      border: `1px solid ${c.border}`,
    },
  };
  return (
    <button
      type="button"
      className="bl-btn"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        minHeight: 36,
        padding: '8px 14px',
        borderRadius: 8,
        fontSize: 13,
        fontWeight: 600,
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        width: full ? '100%' : undefined,
        transition: 'background 0.15s',
        ...variants[variant],
      }}
    >
      {children}
    </button>
  );
}

function Toggle({ on }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        position: 'relative',
        width: 32,
        height: 18,
        borderRadius: 9,
        background: on ? c.primary : c.border,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 16 : 2,
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: '#FFFFFF',
        }}
      />
    </span>
  );
}

function IconTile({ color, children }) {
  return (
    <div
      style={{
        width: 36,
        height: 36,
        borderRadius: 10,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: `${color}14`,
        border: `1px solid ${color}26`,
        flexShrink: 0,
      }}
    >
      {children}
    </div>
  );
}

function PageHeader({ icon, color, title, description, children }) {
  return (
    <header style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <IconTile color={color}>{icon}</IconTile>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: c.text }}>{title}</h1>
      </div>
      {description && (
        <p style={{ margin: '10px 0 0', fontSize: 14, color: c.textSecondary, lineHeight: 1.6 }}>
          {description}
        </p>
      )}
      {children}
    </header>
  );
}

// ══════════════════════════════════════════════════════════════════
// APP SHELL
// ══════════════════════════════════════════════════════════════════

const NAV_TOP = [
  ['dashboard', 'Dashboard', Icons.home],
  ['cases', 'Cases', Icons.briefcase],
  ['projects', 'Projects', Icons.folder],
  ['messages', 'Messages', Icons.message],
  ['calendar', 'Calendar', Icons.calendar],
];
const NAV_BOTTOM = [
  ['settings', 'Expert settings', Icons.sliders],
  ['account', 'Account', Icons.user],
];

function Wordmark() {
  return (
    <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.02em', color: c.text }}>
      balo
    </span>
  );
}

function NavItem({ label, icon: Ic, active }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px',
        borderRadius: 8,
        fontSize: 13.5,
        fontWeight: active ? 600 : 500,
        background: active ? c.primaryLight : 'transparent',
        color: active ? c.primary : c.textSecondary,
      }}
    >
      <Ic size={16} color={active ? c.primary : c.textTertiary} />
      {label}
    </div>
  );
}

function AppShell({ mobile, activeNav, children }) {
  if (mobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 700 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '12px 16px',
            background: c.surface,
            borderBottom: `1px solid ${c.border}`,
          }}
        >
          <Icons.menu size={18} color={c.textSecondary} />
          <Wordmark />
          <span
            style={{
              marginLeft: 'auto',
              width: 28,
              height: 28,
              borderRadius: '50%',
              background: c.surfaceSubtle,
              border: `1px solid ${c.border}`,
            }}
          />
        </div>
        <main style={{ flex: 1, padding: '18px 16px 88px' }}>{children}</main>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', minHeight: 700 }}>
      <aside
        style={{
          width: 208,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          padding: '18px 12px',
          background: c.surface,
          borderRight: `1px solid ${c.border}`,
        }}
      >
        <div style={{ padding: '0 10px 14px' }}>
          <Wordmark />
        </div>
        {NAV_TOP.map(([key, label, icon]) => (
          <NavItem key={key} label={label} icon={icon} active={activeNav === key} />
        ))}
        <div style={{ flex: 1 }} />
        {NAV_BOTTOM.map(([key, label, icon]) => (
          <NavItem key={key} label={label} icon={icon} active={activeNav === key} />
        ))}
      </aside>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <main style={{ flex: 1, padding: '28px 32px 88px' }}>{children}</main>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// PAGES
// ══════════════════════════════════════════════════════════════════

/** Any page — Cases stands in. Times use the device zone and say so while zones differ. */
function CasesPage({ meetings, zonesDiffer }) {
  return (
    <>
      <PageHeader
        icon={<Icons.briefcase size={18} color={c.primary} />}
        color={c.primary}
        title="Cases"
        description="Your consultations with each client, grouped by case."
      />
      <Card style={{ overflow: 'hidden' }}>
        {meetings.slice(0, 3).map((m, i) => (
          <div
            key={m.caseTitle}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '14px 18px',
              borderTop: i ? `1px solid ${c.borderSubtle}` : 'none',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: c.text }}>
                {m.caseTitle}
              </p>
              <p style={{ margin: '2px 0 0', fontSize: 13, color: c.textSecondary }}>{m.company}</p>
              <p
                style={{
                  margin: '6px 0 0',
                  fontSize: 12.5,
                  color: c.textSecondary,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                Next consultation: {dayRange(m, DEVICE_TZ)}
                {zonesDiffer && (
                  <span style={{ color: c.text, fontWeight: 500 }}> ({DEVICE_CITY})</span>
                )}
              </p>
            </div>
            <Icons.chevRight size={15} color={c.textTertiary} />
          </div>
        ))}
      </Card>
    </>
  );
}

const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Schedule tab — passive note on the timezone line when the dialog isn't due. */
function SchedulePage({ now, situation, onChangeTimezone }) {
  const switched = situation === 'switched';
  const tz = switched ? DEVICE_TZ : SCHEDULE_TZ;
  const city = switched ? DEVICE_CITY : SCHEDULE_CITY;
  const paused = situation === 'paused';
  const hasHours = situation !== 'noHours';
  const passiveNote = situation === 'kept' || situation === 'paused' || situation === 'noHours';

  return (
    <>
      <PageHeader
        icon={<Icons.calendar size={18} color={c.primary} />}
        color={c.primary}
        title="Schedule"
        description="Set when you’re open to consultations. These hours, minus anything busy on your calendar, become the times clients can book."
      >
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 10px' }}>
            <Icons.globe size={15} color={c.textTertiary} />
            <p style={{ margin: 0, fontSize: 13, color: c.textSecondary, lineHeight: 1.5 }}>
              Hours are set in{' '}
              <span style={{ color: c.text, fontWeight: 500 }}>{zoneLabel(city, tz, now)}</span> —
              currently{' '}
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                {fmt(now, tz, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
              </span>
            </p>
            <button
              type="button"
              className="bl-btn"
              disabled={paused}
              onClick={paused || switched ? undefined : onChangeTimezone}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                fontSize: 13,
                fontWeight: 500,
                fontFamily: 'inherit',
                color: paused ? c.textTertiary : c.primary,
                cursor: paused ? 'not-allowed' : 'pointer',
              }}
            >
              Change timezone
            </button>
          </div>
          {passiveNote && (
            <p
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                margin: '6px 0 0 25px',
                fontSize: 12.5,
                color: c.textTertiary,
              }}
            >
              <Icons.info size={13} color={c.textTertiary} />
              Your device is in {zoneLabel(DEVICE_CITY, DEVICE_TZ, now)}.
            </p>
          )}
        </div>
      </PageHeader>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Card style={{ padding: '16px 20px', display: 'flex', alignItems: 'flex-start', gap: 14 }}>
          <div style={{ flex: 1 }}>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: c.text }}>
              {paused ? 'You’re paused' : 'Available for new work'}
            </p>
            <p style={{ margin: '2px 0 0', fontSize: 13, color: c.textSecondary, lineHeight: 1.5 }}>
              {paused
                ? 'Clients can’t book new consultations until you turn this back on.'
                : 'Clients can book you during your hours.'}
            </p>
          </div>
          <Toggle on={!paused} />
        </Card>

        <Card style={{ padding: 20, opacity: paused ? 0.7 : 1 }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: c.text }}>Availability</h2>
          <p style={{ margin: '2px 0 14px', fontSize: 13, color: c.textSecondary }}>
            Your open hours, turned into bookable slots.
          </p>
          {hasHours ? (
            WEEK.map((day, i) => {
              const on = i < 5;
              return (
                <div
                  key={day}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    padding: '9px 0',
                    borderTop: i ? `1px solid ${c.borderSubtle}` : 'none',
                  }}
                >
                  <Toggle on={on} />
                  <span
                    style={{
                      width: 36,
                      fontSize: 13,
                      fontWeight: on ? 600 : 450,
                      color: on ? c.text : c.textTertiary,
                    }}
                  >
                    {day}
                  </span>
                  <span style={{ fontSize: 13, color: on ? c.text : c.textTertiary }}>
                    {on ? '9:00 am – 5:00 pm' : 'Unavailable'}
                  </span>
                </div>
              );
            })
          ) : (
            <div
              style={{
                padding: '22px 16px',
                borderRadius: 10,
                background: c.surfaceSubtle,
                textAlign: 'center',
              }}
            >
              <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: c.text }}>
                Set your weekly hours
              </p>
              <p style={{ margin: '4px 0 14px', fontSize: 13, color: c.textSecondary }}>
                Clients can book you once your hours are set.
              </p>
              <Button variant="primary">Use Mon–Fri, 9 am–5 pm</Button>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

function TimezoneChip({ label, showInfo }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6 }}>
      <Icons.clock size={14} color={c.textTertiary} />
      <span style={{ fontSize: 13, color: c.textSecondary }}>{label}</span>
      {showInfo && (
        <button
          type="button"
          className="bl-btn"
          aria-label="Why does this differ from my device?"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          style={{
            display: 'inline-flex',
            padding: 2,
            background: 'none',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          <Icons.info size={14} color={c.textTertiary} />
        </button>
      )}
      {showInfo && open && (
        <div
          role="note"
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            width: 260,
            padding: '10px 12px',
            borderRadius: 10,
            background: c.surface,
            border: `1px solid ${c.border}`,
            fontSize: 12.5,
            color: c.textSecondary,
            lineHeight: 1.5,
            zIndex: 10,
            animation: 'dropIn 0.15s ease-out',
          }}
        >
          Your device is set to a different timezone. This calendar always shows your schedule’s
          timezone, the same one your hours are set in.
        </div>
      )}
    </div>
  );
}

/** Calendar page — unchanged from today: saved zone, chip info icon when zones differ. */
function CalendarPage({ now, meetings, situation, mobile }) {
  const switched = situation === 'switched';
  const tz = switched ? DEVICE_TZ : SCHEDULE_TZ;
  const city = switched ? DEVICE_CITY : SCHEDULE_CITY;
  const showInfo = situation === 'kept' || situation === 'paused' || situation === 'noHours';

  const groups = [];
  for (const m of meetings.slice(0, 3)) {
    const label = fmt(m.start, tz, { weekday: 'long', day: 'numeric', month: 'long' });
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(m);
    else groups.push({ label, items: [m] });
  }

  return (
    <>
      <div
        style={{
          display: 'flex',
          flexDirection: mobile ? 'column' : 'row',
          alignItems: mobile ? 'flex-start' : 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 18,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <IconTile color={c.accent}>
            <Icons.calendar size={18} color={c.accent} />
          </IconTile>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: c.text }}>Calendar</h1>
        </div>
        <TimezoneChip label={zoneLabel(city, tz, now)} showInfo={showInfo} />
      </div>

      <Card style={{ padding: mobile ? 16 : 20 }}>
        {groups.map((g, gi) => (
          <div key={g.label} style={{ marginTop: gi ? 18 : 0 }}>
            <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600, color: c.text }}>
              {g.label}
            </p>
            {g.items.map((m) => (
              <div
                key={m.start.toISOString()}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: `1px solid ${c.borderSubtle}`,
                  marginBottom: 6,
                }}
              >
                <span
                  style={{
                    width: 3,
                    alignSelf: 'stretch',
                    borderRadius: 2,
                    background: c.primary,
                    flexShrink: 0,
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p
                    style={{
                      margin: 0,
                      fontSize: 13,
                      fontWeight: 600,
                      color: c.text,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {fmtTime(m.start, tz)} – {fmtTime(m.end, tz)}
                  </p>
                  <p style={{ margin: '1px 0 0', fontSize: 12.5, color: c.textSecondary }}>
                    Consultation with {m.company}
                  </p>
                </div>
                <Icons.chevRight size={15} color={c.textTertiary} />
              </div>
            ))}
          </div>
        ))}
      </Card>
    </>
  );
}

// ══════════════════════════════════════════════════════════════════
// ON A CALL — the dialog is held here
// ══════════════════════════════════════════════════════════════════

function CallPage({ mobile }) {
  return (
    <div
      style={{
        minHeight: 700,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        padding: mobile ? 16 : 24,
        background: '#111827',
      }}
    >
      <div
        style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#E5E7EB' }}
      >
        <span style={{ fontWeight: 600 }}>Consultation with Northwind Logistics</span>
        <span style={{ fontVariantNumeric: 'tabular-nums', color: '#9CA3AF' }}>12:04</span>
      </div>
      <div
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: mobile ? '1fr' : '1fr 1fr',
          gap: 12,
        }}
      >
        {['You', 'Northwind Logistics'].map((name) => (
          <div
            key={name}
            style={{
              minHeight: mobile ? 200 : 320,
              display: 'flex',
              alignItems: 'flex-end',
              padding: 12,
              borderRadius: 14,
              background: '#1F2937',
              fontSize: 12.5,
              color: '#D1D5DB',
            }}
          >
            {name}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 10 }}>
        {['#374151', '#374151', '#374151', '#DC2626'].map((bg, i) => (
          <span
            key={i}
            style={{ width: 44, height: 44, borderRadius: '50%', background: bg }}
            aria-hidden="true"
          />
        ))}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// THE DIALOG — one decision, consequences included
// ══════════════════════════════════════════════════════════════════

function Notice({ tone, icon, children }) {
  const tones = {
    success: [c.successLight, c.successBorder],
    neutral: [c.surface, c.borderSubtle],
  };
  const [bg, border] = tones[tone];
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        padding: '11px 13px',
        borderRadius: 10,
        background: bg,
        border: `1px solid ${border}`,
      }}
    >
      <span style={{ display: 'inline-flex', marginTop: 2, flexShrink: 0 }}>{icon}</span>
      <p style={{ margin: 0, fontSize: 13, color: c.text, lineHeight: 1.5 }}>{children}</p>
    </div>
  );
}

function ConsultationCheck({ check, affected }) {
  if (check === 'checking') {
    return (
      <Notice tone="neutral" icon={<Icons.spinner size={15} color={c.textTertiary} />}>
        Checking your upcoming consultations…
      </Notice>
    );
  }
  if (check === 'none') {
    return (
      <Notice tone="success" icon={<Icons.check size={15} color={c.success} />}>
        None of your upcoming consultations would fall outside your new hours.
      </Notice>
    );
  }
  if (check === 'failed') {
    return (
      <Notice tone="neutral" icon={<Icons.info size={15} color={c.textTertiary} />}>
        We couldn’t check your upcoming consultations. Nothing that’s booked would move either way.
      </Notice>
    );
  }

  const shown = affected.slice(0, 3);
  const more = affected.length - shown.length;
  return (
    <div
      style={{
        padding: '11px 13px',
        borderRadius: 10,
        background: c.warningLight,
        border: `1px solid ${c.warningBorder}`,
      }}
    >
      <div style={{ display: 'flex', gap: 8 }}>
        <Icons.alert size={15} color={c.warning} style={{ marginTop: 2, flexShrink: 0 }} />
        <p style={{ margin: 0, fontSize: 13, color: c.text, lineHeight: 1.5 }}>
          <span style={{ fontWeight: 600 }}>
            {affected.length} upcoming consultation{affected.length === 1 ? '' : 's'} would fall
            outside your new hours.
          </span>{' '}
          {affected.length === 1 ? 'It would stay' : 'They would stay'} booked at the current time:
        </p>
      </div>
      <ul
        style={{
          listStyle: 'none',
          margin: '10px 0 0',
          padding: '0 0 0 23px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        {shown.map((m) => (
          <li
            key={m.start.toISOString()}
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              gap: '2px 12px',
              fontSize: 13,
            }}
          >
            <span style={{ color: c.text, fontVariantNumeric: 'tabular-nums' }}>
              {dayRange(m, DEVICE_TZ)}
            </span>
            <span style={{ color: c.textSecondary }}>{m.company}</span>
          </li>
        ))}
        {more > 0 && <li style={{ fontSize: 13, color: c.textSecondary }}>and {more} more</li>}
      </ul>
      <p style={{ margin: '10px 0 0 23px', fontSize: 12.5, color: c.textSecondary }}>
        You can reschedule any of them from its case.
      </p>
    </div>
  );
}

/**
 * `source: 'detected'` — opened by the layout after a zone change.
 * `source: 'manual'` — opened by the Schedule tab's "Change timezone" after a zone is picked.
 * Same consequences, same two buttons; only the heading and the travel hint differ.
 */
function MismatchDialog({ source, check, meetings, now, mobile, onKeep, onSwitch }) {
  const detected = source === 'detected';
  let affected = [];
  if (check === 'some') affected = meetings.slice(0, 2);
  if (check === 'many') affected = meetings;

  const hereDay = fmt(now, DEVICE_TZ, { weekday: 'long' });
  const thereDay = fmt(now, SCHEDULE_TZ, { weekday: 'long' });
  const thereClock =
    hereDay === thereDay ? fmtTime(now, SCHEDULE_TZ) : `${fmtTime(now, SCHEDULE_TZ)} ${thereDay}`;

  // The expert's most common weekday range (9–5 in this scenario), shown in both zones.
  const start = addDaysAt(SCHEDULE_TZ, now, 0, 9, 0);
  const end = addDaysAt(SCHEDULE_TZ, now, 0, 17, 0);
  const range = `${fmtTime(start, SCHEDULE_TZ)} – ${fmtTime(end, SCHEDULE_TZ)}`;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 20,
        display: 'flex',
        alignItems: mobile ? 'flex-end' : 'flex-start',
        justifyContent: 'center',
        padding: mobile ? 0 : '56px 16px',
        background: 'rgba(17,24,39,0.45)',
        animation: 'fadeIn 0.15s ease-out',
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="tz-dialog-title"
        aria-describedby="tz-dialog-desc"
        style={{
          width: '100%',
          maxWidth: mobile ? 'none' : 520,
          maxHeight: mobile ? '92%' : 'calc(100% - 32px)',
          overflowY: 'auto',
          padding: 22,
          borderRadius: mobile ? '18px 18px 0 0' : 14,
          background: c.surface,
          border: `1px solid ${c.border}`,
          animation: 'scaleIn 0.18s ease-out',
        }}
      >
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <IconTile color={c.primary}>
            <Icons.globe size={18} color={c.primary} />
          </IconTile>
          <div>
            <h2
              id="tz-dialog-title"
              style={{ margin: 0, fontSize: 17, fontWeight: 650, color: c.text, lineHeight: 1.35 }}
            >
              {detected
                ? `You’re in ${DEVICE_CITY}, but your hours are set in ${SCHEDULE_CITY} time`
                : `Switch your hours to ${DEVICE_CITY} time?`}
            </h2>
            <p
              id="tz-dialog-desc"
              style={{ margin: '6px 0 0', fontSize: 13.5, color: c.textSecondary, lineHeight: 1.6 }}
            >
              It’s {fmtTime(now, DEVICE_TZ)} here and {thereClock} in {SCHEDULE_CITY}. Your {range}{' '}
              {SCHEDULE_CITY} hours are {fmtTime(start, DEVICE_TZ)} – {fmtTime(end, DEVICE_TZ)} in{' '}
              {DEVICE_CITY}.
            </p>
          </div>
        </div>

        {/* What switching would do — boxed so it reads as the consequence of ONE choice. */}
        <div
          style={{
            marginTop: 16,
            padding: '14px 16px',
            borderRadius: 12,
            background: c.surfaceSubtle,
            border: `1px solid ${c.borderSubtle}`,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div>
            <p style={{ margin: 0, fontSize: 13.5, fontWeight: 600, color: c.text }}>
              If you switch to {DEVICE_CITY} time
            </p>
            <p
              style={{ margin: '3px 0 0', fontSize: 13, color: c.textSecondary, lineHeight: 1.55 }}
            >
              Your hours stay {range}, read in {DEVICE_CITY} time, and every time clients can book
              moves with them.
            </p>
          </div>
          <ConsultationCheck check={check} affected={affected} />
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <Icons.calendar
              size={14}
              color={c.textTertiary}
              style={{ marginTop: 3, flexShrink: 0 }}
            />
            <p style={{ margin: 0, fontSize: 13, color: c.textSecondary, lineHeight: 1.5 }}>
              Your time off (24 Dec – 2 Jan) would be read in {DEVICE_CITY} time too.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <Icons.info size={14} color={c.textTertiary} style={{ marginTop: 3, flexShrink: 0 }} />
            <p style={{ margin: 0, fontSize: 13, color: c.textSecondary, lineHeight: 1.5 }}>
              Busy times from your connected calendar wouldn’t change.
            </p>
          </div>
        </div>

        {detected && (
          <p style={{ margin: '14px 0 0', fontSize: 12.5, color: c.textTertiary, lineHeight: 1.5 }}>
            Travelling but still working with the same clients? Keep {SCHEDULE_CITY} hours.
          </p>
        )}

        <div
          style={{
            display: 'flex',
            flexDirection: mobile ? 'column' : 'row',
            justifyContent: 'flex-end',
            gap: 8,
            marginTop: detected ? 14 : 20,
          }}
        >
          {/* Equal weight: we can't tell travelling from moving. Keep is first in tab order and
              takes initial focus (AlertDialog's cancel), so Enter or Escape never switches. The
              consultation check never blocks Switch — it warns and fails open (BAL-416). */}
          <Button onClick={onKeep} full={mobile}>
            Keep {SCHEDULE_CITY} hours
          </Button>
          <Button onClick={onSwitch} full={mobile}>
            Switch to {DEVICE_CITY} time
          </Button>
        </div>
      </div>
    </div>
  );
}

function Toast({ mobile }) {
  return (
    <div
      role="status"
      style={{
        position: 'absolute',
        bottom: 16,
        right: 16,
        left: mobile ? 16 : 'auto',
        zIndex: 30,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '11px 14px',
        borderRadius: 10,
        background: c.surface,
        border: `1px solid ${c.border}`,
        fontSize: 13,
        color: c.text,
        animation: 'dropIn 0.2s ease-out',
      }}
    >
      <Icons.check size={15} color={c.success} />
      Timezone updated. Your hours are now set in {DEVICE_CITY} time.
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// DEMO CONTROLS + BEHAVIOUR NOTES (for the ticket and CC)
// ══════════════════════════════════════════════════════════════════

const PAGES = [
  ['cases', 'Any page (Cases)'],
  ['schedule', 'Schedule tab'],
  ['calendar', 'Calendar page'],
  ['call', 'On a call'],
];

const SITUATIONS = [
  ['shown', 'Dialog due'],
  ['kept', 'Kept Sydney hours'],
  ['paused', 'Paused'],
  ['noHours', 'No hours yet'],
  ['switched', 'Switched to London'],
];

const CHECKS = [
  ['checking', 'Checking'],
  ['none', 'Nothing affected'],
  ['some', '2 affected'],
  ['many', '7 affected'],
  ['failed', 'Check failed'],
];

function caption(situation, page) {
  if (situation === 'shown' && page === 'call') {
    return 'Held: the dialog never opens over a call. It appears on the first page after the call ends.';
  }
  return {
    shown:
      'Dialog showing: approved expert with saved hours, not paused, device zone differs, and this pair of zones not yet answered on this device.',
    kept: 'Answered: Sydney hours kept for this pair of zones on this device. Passive hints only from here.',
    paused: 'Not shown: nothing is bookable while paused. Passive hints only.',
    noHours: 'Not shown: no hours saved yet, so nothing is bookable. Passive hints only.',
    switched: 'No mismatch: the saved zone now matches the device.',
  }[situation];
}

const NOTES = {
  cases: [
    'Opened by the dashboard layout, so it can appear over any page. Never over the call route or the join lobby.',
    'Detection runs on page load and when the tab regains focus. The dialog opens on page load or on the next page change, never in the middle of a page, so it can’t interrupt someone typing.',
    'Shown only when all hold: an approved expert profile, saved weekly hours, not paused, the device and schedule zones have a different UTC offset now or within 12 months, and this pair of zones hasn’t been answered on this device. Shown in either workspace.',
    'One decision: Keep or Switch, no second confirm step. Escape counts as Keep, the no-change option. Keep takes initial focus, so Enter can’t switch by accident.',
    'The consultation check starts when the dialog opens and fails open: Switch is never blocked by it.',
    'Affected consultations are shown in the new zone, since that’s the clock the expert would work by.',
    'While the zones differ, times elsewhere in the app show their zone, e.g. “(London)”. Once they match, the label goes away.',
    'The hours line uses the expert’s most common weekday range, or their earliest start if no range repeats.',
    'Never switches automatically.',
  ],
  schedule: [
    'No separate prompt here. When the dialog isn’t due (kept, paused, no hours yet) but the zones differ, the timezone line adds a passive note naming the device zone.',
    '“Change timezone” opens the existing picker; choosing a zone opens the same dialog, headed “Switch your hours to London time?”. In this prototype the click goes straight to the dialog.',
    'The “no hours yet” case is covered by the note: an expert setting hours for the first time sees which zone they’re typing them in.',
    'Hours are always shown and edited in the saved zone.',
  ],
  calendar: [
    'Unchanged from today: the calendar shows the saved zone.',
    'The chip’s info icon appears when the zones differ and the dialog isn’t open.',
  ],
  call: [
    'The call screen never shows the dialog, and neither does the join lobby.',
    'If the zone change is detected during a call, the dialog waits for the first page the expert opens after it.',
  ],
};

function Segmented({ label, options, value, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ width: 72, fontSize: 12, color: c.textTertiary }}>{label}</span>
      <div
        role="tablist"
        aria-label={label}
        style={{
          display: 'inline-flex',
          flexWrap: 'wrap',
          gap: 4,
          padding: 4,
          borderRadius: 10,
          background: c.surfaceSubtle,
          border: `1px solid ${c.borderSubtle}`,
        }}
      >
        {options.map(([key, text]) => {
          const active = key === value;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active}
              className="bl-btn"
              onClick={() => onChange(key)}
              style={{
                padding: '6px 12px',
                borderRadius: 7,
                fontSize: 12,
                fontWeight: 550,
                fontFamily: 'inherit',
                cursor: 'pointer',
                border: active ? `1px solid ${c.border}` : '1px solid transparent',
                background: active ? c.surface : 'transparent',
                color: active ? c.text : c.textTertiary,
              }}
            >
              {text}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════

export default function TimezoneMismatchDialog() {
  const now = useNow();
  const hourKey = Math.floor(now.getTime() / 3600000);
  const meetings = useMemo(() => buildMeetings(new Date(hourKey * 3600000)), [hourKey]);

  const [page, setPage] = useState('cases');
  const [situation, setSituation] = useState('shown');
  const [check, setCheck] = useState('some');
  const [viewport, setViewport] = useState('desktop');
  const [manualOpen, setManualOpen] = useState(false); // opened from "Change timezone"
  const [toast, setToast] = useState(false);
  const mobile = viewport === 'mobile';

  const detectedOpen = situation === 'shown' && page !== 'call';
  const dialogOpen = detectedOpen || manualOpen;

  const keep = () => {
    if (manualOpen) setManualOpen(false);
    else setSituation('kept');
  };
  const switchZone = () => {
    setManualOpen(false);
    setSituation('switched');
    setToast(true);
  };

  // Escape counts as Keep — the no-change option.
  useEffect(() => {
    if (!dialogOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') keep();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (!toast) return undefined;
    const id = setTimeout(() => setToast(false), 3200);
    return () => clearTimeout(id);
  }, [toast]);

  const activeNav = { cases: 'cases', schedule: 'settings', calendar: 'calendar' }[page];

  let content = null;
  if (page === 'cases') {
    content = <CasesPage meetings={meetings} zonesDiffer={situation !== 'switched'} />;
  } else if (page === 'schedule') {
    content = (
      <SchedulePage now={now} situation={situation} onChangeTimezone={() => setManualOpen(true)} />
    );
  } else if (page === 'calendar') {
    content = <CalendarPage now={now} meetings={meetings} situation={situation} mobile={mobile} />;
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        padding: '28px 20px 48px',
        background: c.bg,
        color: c.text,
        fontFamily: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      <style>{CSS}</style>
      <link
        href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap"
        rel="stylesheet"
      />

      <div
        style={{
          maxWidth: 1040,
          margin: '0 auto 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <Segmented
          label="Page"
          options={PAGES}
          value={page}
          onChange={(p) => {
            setPage(p);
            setManualOpen(false);
          }}
        />
        <Segmented
          label="Situation"
          options={SITUATIONS}
          value={situation}
          onChange={(s) => {
            setSituation(s);
            setManualOpen(false);
          }}
        />
        <Segmented label="Check" options={CHECKS} value={check} onChange={setCheck} />
        <Segmented
          label="Viewport"
          options={[
            ['desktop', 'Desktop'],
            ['mobile', 'Mobile'],
          ]}
          value={viewport}
          onChange={setViewport}
        />
      </div>

      <p style={{ maxWidth: 1040, margin: '0 auto 14px', fontSize: 12.5, color: c.textTertiary }}>
        {caption(situation, page)}
      </p>

      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <div
          style={{
            position: 'relative',
            width: mobile ? 375 : 1040,
            maxWidth: '100%',
            borderRadius: mobile ? 28 : 16,
            background: c.bg,
            border: `1px solid ${c.border}`,
            overflow: 'hidden',
          }}
        >
          {page === 'call' ? (
            <CallPage mobile={mobile} />
          ) : (
            <AppShell mobile={mobile} activeNav={activeNav}>
              {content}
            </AppShell>
          )}

          {dialogOpen && (
            <MismatchDialog
              source={manualOpen ? 'manual' : 'detected'}
              check={check}
              meetings={meetings}
              now={now}
              mobile={mobile}
              onKeep={keep}
              onSwitch={switchZone}
            />
          )}

          {toast && <Toast mobile={mobile} />}
        </div>
      </div>

      <div style={{ maxWidth: 1040, margin: '28px auto 0' }}>
        <Card style={{ padding: '18px 22px' }}>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: c.text }}>Behaviour</h2>
          <ul
            style={{
              margin: '10px 0 0',
              paddingLeft: 18,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            {NOTES[page].map((note) => (
              <li key={note} style={{ fontSize: 13, color: c.textSecondary, lineHeight: 1.55 }}>
                {note}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
