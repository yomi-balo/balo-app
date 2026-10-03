import { useEffect, useRef, useState } from 'react';

// BAL-591 — "Available for new work" on Expert Settings → Schedule.
//
// Mirrors the shipped Schedule tab (schedule-tab.tsx): header → Availability → Time off →
// Calendar connections → What clients see. The status card at the top is the ONLY new block;
// every other card is the existing one rendered in its paused state. The second view is the
// Calendar page (BAL-498) while paused.
//
// Visual motif: diagonal hatching = paused. It appears on the status card, the client preview
// and the Calendar page's open hours, so "greyed" always reads as deliberately paused, never
// as broken or loading.

const c = {
  bg: '#F8FAFB',
  surface: '#FFFFFF',
  subtle: '#F3F5F8',
  border: '#E3E7ED',
  borderSoft: '#EDF0F4',
  text: '#111827',
  text2: '#4B5563',
  text3: '#8A93A1',
  primary: '#2563EB',
  primaryLight: '#EFF6FF',
  primaryBorder: '#BFDBFE',
  violet: '#7C3AED',
  violetLight: '#F5F3FF',
  success: '#059669',
  successLight: '#ECFDF5',
  successBorder: '#A7F3D0',
  slate: '#475569',
  slateLight: '#F1F5F9',
  slateBorder: '#CBD5E1',
  hatchTone: 'rgba(100,116,139,0.11)',
};

const FONT = "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const hatch = (tone = c.hatchTone) =>
  `repeating-linear-gradient(135deg, ${tone} 0 6px, transparent 6px 12px)`;

const GLOBAL_CSS = `
.bf:focus-visible { outline: 2px solid ${c.primary}; outline-offset: 2px; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes dialogIn { from { opacity: 0; transform: translateY(8px) scale(.98); } to { opacity: 1; transform: none; } }
@keyframes toastIn { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;

// ── Icons ────────────────────────────────────────────────────────
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
const I = {
  calendar: (p) => (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </Svg>
  ),
  clock: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </Svg>
  ),
  pause: (p) => (
    <Svg {...p}>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </Svg>
  ),
  check: (p) => (
    <Svg {...p}>
      <path d="M20 6L9 17l-5-5" />
    </Svg>
  ),
  globe: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10A15.3 15.3 0 0112 2z" />
    </Svg>
  ),
  sun: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Svg>
  ),
  sync: (p) => (
    <Svg {...p}>
      <path d="M21 12a9 9 0 11-2.6-6.4L21 8" />
      <path d="M21 3v5h-5" />
    </Svg>
  ),
  eye: (p) => (
    <Svg {...p}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  ),
  lock: (p) => (
    <Svg {...p}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 018 0v4" />
    </Svg>
  ),
  plus: (p) => (
    <Svg {...p}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  ),
  chevL: (p) => (
    <Svg {...p}>
      <path d="M15 18l-6-6 6-6" />
    </Svg>
  ),
  chevR: (p) => (
    <Svg {...p}>
      <path d="M9 18l6-6-6-6" />
    </Svg>
  ),
};

// ── Primitives ───────────────────────────────────────────────────
function Switch({ id, checked, onChange, describedBy, small = false }) {
  const w = small ? 32 : 44;
  const h = small ? 18 : 24;
  const knob = h - 6;
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-describedby={describedBy}
      onClick={() => onChange?.(!checked)}
      className="bf"
      style={{
        width: w,
        height: h,
        borderRadius: 999,
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        position: 'relative',
        flexShrink: 0,
        background: checked ? c.primary : c.slateBorder,
        transition: 'background .2s',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 3,
          left: checked ? w - knob - 3 : 3,
          width: knob,
          height: knob,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 3px rgba(0,0,0,.25)',
          transition: 'left .18s',
        }}
      />
    </button>
  );
}

function IconTile({ children, bg }) {
  return (
    <div
      style={{
        width: 34,
        height: 34,
        borderRadius: 9,
        background: bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {children}
    </div>
  );
}

function Card({ id, icon, iconBg, title, sub, children }) {
  return (
    <section
      aria-labelledby={id}
      style={{
        background: c.surface,
        border: `1px solid ${c.border}`,
        borderRadius: 14,
        padding: '22px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
        boxShadow: '0 1px 2px rgba(17,24,39,.04)',
      }}
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <IconTile bg={iconBg}>{icon}</IconTile>
        <div>
          <h2 id={id} style={{ margin: 0, fontSize: 15, fontWeight: 600, color: c.text }}>
            {title}
          </h2>
          <p style={{ margin: '2px 0 0', fontSize: 13, color: c.text2 }}>{sub}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

/** Stays at full strength inside a dimmed card — it is the explanation, not the content. */
function PausedNote({ id, children }) {
  return (
    <div
      id={id}
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        padding: '10px 12px',
        borderRadius: 10,
        background: c.slateLight,
        border: `1px solid ${c.slateBorder}`,
        fontSize: 12.5,
        lineHeight: 1.5,
        color: c.slate,
      }}
    >
      <I.lock size={14} color={c.slate} style={{ marginTop: 2, flexShrink: 0 }} />
      <span>{children}</span>
    </div>
  );
}

/** Greys a block while paused. In code: `disabled` on every control (NOT `inert` — values must
 *  stay readable to screen readers), plus aria-describedby → the card's PausedNote. */
function Dim({ paused, children }) {
  return (
    <div
      aria-disabled={paused || undefined}
      style={{
        opacity: paused ? 0.45 : 1,
        filter: paused ? 'grayscale(1)' : 'none',
        pointerEvents: paused ? 'none' : 'auto',
        userSelect: paused ? 'none' : 'auto',
        transition: 'opacity .25s, filter .25s',
      }}
    >
      {children}
    </div>
  );
}

const btnPrimary = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '9px 16px',
  borderRadius: 9,
  border: 'none',
  background: c.primary,
  color: '#fff',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: FONT,
};
const btnOutline = {
  ...btnPrimary,
  background: c.surface,
  color: c.text,
  border: `1px solid ${c.border}`,
};

// ── Data ─────────────────────────────────────────────────────────
const WEEK = [
  { day: 'Mon', ranges: [['9:00 AM', '5:00 PM']] },
  { day: 'Tue', ranges: [['9:00 AM', '5:00 PM']] },
  {
    day: 'Wed',
    ranges: [
      ['9:00 AM', '12:00 PM'],
      ['1:00 PM', '5:00 PM'],
    ],
  },
  { day: 'Thu', ranges: [['9:00 AM', '5:00 PM']] },
  { day: 'Fri', ranges: [['9:00 AM', '3:00 PM']] },
  { day: 'Sat', ranges: [] },
  { day: 'Sun', ranges: [] },
];

const PREVIEW = [
  { d: 'Mon 6', slots: ['9:00', '10:30', '2:00'] },
  { d: 'Tue 7', slots: ['9:30', '1:00', '3:30'] },
  { d: 'Wed 8', slots: ['9:00', '1:30'] },
  { d: 'Thu 9', slots: ['10:00', '11:30', '2:30', '4:00'] },
  { d: 'Fri 10', slots: ['9:00', '11:00'] },
  { d: 'Sat 11', slots: [] },
  { d: 'Sun 12', slots: [] },
];

// ── Schedule tab sections ───────────────────────────────────────
function StatusCard({ available, onChange }) {
  const paused = !available;
  return (
    <section
      aria-label="Availability for new work"
      style={{
        borderRadius: 14,
        border: `1px solid ${paused ? c.slateBorder : c.border}`,
        background: paused ? `${hatch()}, ${c.slateLight}` : c.surface,
        padding: '18px 22px',
        display: 'flex',
        gap: 14,
        alignItems: 'flex-start',
        boxShadow: '0 1px 2px rgba(17,24,39,.04)',
        transition: 'background .25s, border-color .25s',
      }}
    >
      <IconTile bg={paused ? '#E2E8F0' : c.successLight}>
        {paused ? <I.pause size={16} color={c.slate} /> : <I.check size={16} color={c.success} />}
      </IconTile>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label
            htmlFor="work-switch"
            style={{ fontSize: 15, fontWeight: 600, color: c.text, cursor: 'pointer' }}
          >
            Available for new work
          </label>
          {paused && (
            <span
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                color: c.slate,
                background: '#fff',
                border: `1px solid ${c.slateBorder}`,
                borderRadius: 999,
                padding: '2px 9px',
              }}
            >
              Paused
            </span>
          )}
        </div>
        <p
          id="work-switch-desc"
          aria-live="polite"
          style={{
            margin: '4px 0 0',
            fontSize: 13,
            lineHeight: 1.55,
            color: c.text2,
            maxWidth: 520,
          }}
        >
          {available
            ? 'Clients can book consultations with you and send you project briefs.'
            : "You're paused. Clients can't book consultations or send you new project briefs. Your current consultations and projects carry on as normal."}
        </p>
      </div>
      <Switch
        id="work-switch"
        checked={available}
        onChange={onChange}
        describedBy="work-switch-desc"
      />
    </section>
  );
}

function TimeBox({ children }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '6px 10px',
        borderRadius: 7,
        border: `1px solid ${c.border}`,
        background: c.surface,
        fontSize: 13,
        fontWeight: 500,
        color: c.text,
        whiteSpace: 'nowrap',
      }}
    >
      <I.clock size={12} color={c.text3} />
      {children}
    </span>
  );
}

function AvailabilityCard({ paused }) {
  return (
    <Card
      id="avail-h"
      icon={<I.clock size={17} color={c.violet} />}
      iconBg={c.violetLight}
      title="Availability"
      sub="Your open hours, turned into bookable slots."
    >
      {paused && (
        <PausedNote id="avail-paused">
          Your hours are kept exactly as they are and come back when you turn on availability.
        </PausedNote>
      )}
      <Dim paused={paused}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: c.text3, marginBottom: 4 }}>
            Weekly hours
          </span>
          {WEEK.map((row) => (
            <div
              key={row.day}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 14,
                padding: '8px 0',
                borderBottom: `1px solid ${c.borderSoft}`,
              }}
            >
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 10, width: 92, paddingTop: 6 }}
              >
                <Switch small checked={row.ranges.length > 0} />
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: row.ranges.length ? c.text : c.text3,
                  }}
                >
                  {row.day}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                {row.ranges.length === 0 ? (
                  <span style={{ fontSize: 13, color: c.text3, paddingTop: 6 }}>Unavailable</span>
                ) : (
                  row.ranges.map(([a, b]) => (
                    <div key={a} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <TimeBox>{a}</TimeBox>
                      <span style={{ fontSize: 12, color: c.text3 }}>to</span>
                      <TimeBox>{b}</TimeBox>
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>

        <div style={{ height: 1, background: c.borderSoft, margin: '18px 0' }} />

        <span style={{ fontSize: 12, fontWeight: 600, color: c.text3 }}>Booking rules</span>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: 10,
            marginTop: 10,
          }}
        >
          {[
            ['Buffer before', 'None'],
            ['Buffer after', '10 min'],
            ['Minimum notice', '4 hours'],
          ].map(([label, value]) => (
            <div
              key={label}
              style={{ border: `1px solid ${c.border}`, borderRadius: 9, padding: '9px 12px' }}
            >
              <div style={{ fontSize: 11.5, color: c.text3 }}>{label}</div>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: c.text, marginTop: 2 }}>
                {value}
              </div>
            </div>
          ))}
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 20,
          }}
        >
          <button
            type="button"
            className="bf"
            style={{
              background: 'none',
              border: 'none',
              color: c.text3,
              fontSize: 13,
              cursor: 'pointer',
              padding: 0,
              fontFamily: FONT,
            }}
          >
            Clear schedule
          </button>
          <button type="button" className="bf" style={btnPrimary}>
            Save schedule
          </button>
        </div>
      </Dim>
    </Card>
  );
}

function TimeOffCard({ paused }) {
  return (
    <Card
      id="timeoff-h"
      icon={<I.sun size={17} color="#D97706" />}
      iconBg="#FFFBEB"
      title="Time off"
      sub="Block out holidays and leave."
    >
      <Dim paused={paused}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '11px 14px',
            borderRadius: 10,
            border: `1px solid ${c.border}`,
          }}
        >
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: c.text }}>
              Wed 24 Dec to Fri 2 Jan
            </div>
            <div style={{ fontSize: 12.5, color: c.text3, marginTop: 2 }}>All day</div>
          </div>
          <button type="button" className="bf" style={{ ...btnOutline, padding: '7px 12px' }}>
            Edit
          </button>
        </div>
        <button
          type="button"
          className="bf"
          style={{ ...btnOutline, marginTop: 12, padding: '7px 12px' }}
        >
          <I.plus size={13} color={c.text2} /> Add time off
        </button>
      </Dim>
    </Card>
  );
}

function ConnectionsCard({ paused }) {
  return (
    <Card
      id="conn-h"
      icon={<I.calendar size={17} color={c.primary} />}
      iconBg={c.primaryLight}
      title="Calendar connections"
      sub="Busy times on these calendars are hidden from clients."
    >
      {/* Deliberately NOT dimmed: sync keeps existing bookings correct while paused. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 14px',
          borderRadius: 10,
          border: `1px solid ${c.border}`,
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: c.subtle,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 700,
            fontSize: 14,
            color: c.primary,
          }}
          aria-hidden="true"
        >
          G
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: c.text }}>priya@northwind.io</div>
          <div style={{ fontSize: 12.5, color: c.text3, marginTop: 2 }}>
            Checking 2 calendars for busy times
          </div>
        </div>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 12,
            fontWeight: 600,
            color: c.success,
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: c.success }} />
          Connected
        </span>
      </div>
      {paused && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            fontSize: 12.5,
            color: c.text2,
            lineHeight: 1.5,
          }}
        >
          <I.sync size={14} color={c.success} style={{ marginTop: 2, flexShrink: 0 }} />
          <span>
            Still syncing while you&apos;re paused, so the consultations you&apos;ve already booked
            stay up to date.
          </span>
        </div>
      )}
    </Card>
  );
}

function ClientPreviewCard({ paused }) {
  return (
    <Card
      id="preview-h"
      icon={<I.eye size={17} color={c.text2} />}
      iconBg={c.subtle}
      title="What clients see"
      sub="Your hours, minus anything already busy on your connected calendar."
    >
      {paused ? (
        <div
          style={{
            borderRadius: 12,
            border: `1px dashed ${c.slateBorder}`,
            background: `${hatch()}, ${c.slateLight}`,
            padding: '26px 22px',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, color: c.text }}>
            Nothing bookable while you&apos;re paused
          </div>
          <p
            style={{
              fontSize: 13,
              color: c.text2,
              margin: '6px auto 0',
              maxWidth: 400,
              lineHeight: 1.55,
            }}
          >
            Clients see that you&apos;re not taking on new work right now, with a way to find
            someone with similar experience.
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 6 }}>
          {PREVIEW.map((col) => (
            <div
              key={col.d}
              style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}
            >
              <span
                style={{ fontSize: 11.5, fontWeight: 600, color: c.text2, textAlign: 'center' }}
              >
                {col.d}
              </span>
              {col.slots.length === 0 ? (
                <span style={{ fontSize: 11, color: c.text3, textAlign: 'center' }}>None</span>
              ) : (
                col.slots.map((s) => (
                  <span
                    key={s}
                    style={{
                      fontSize: 11.5,
                      fontWeight: 600,
                      color: c.primary,
                      background: c.primaryLight,
                      border: `1px solid ${c.primaryBorder}`,
                      borderRadius: 6,
                      padding: '4px 0',
                      textAlign: 'center',
                    }}
                  >
                    {s}
                  </span>
                ))
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ScheduleTabView({ available, onChange }) {
  const paused = !available;
  return (
    <div
      style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}
    >
      <header style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 4 }}>
        <IconTile bg={c.primaryLight}>
          <I.calendar size={18} color={c.primary} />
        </IconTile>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: c.text }}>Schedule</h1>
          <p
            style={{
              margin: '4px 0 0',
              fontSize: 14,
              color: c.text2,
              lineHeight: 1.55,
              maxWidth: 560,
            }}
          >
            Set when you&apos;re open to consultations. These hours, minus anything busy on your
            calendar, become the times clients can book.
          </p>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginTop: 8,
              fontSize: 13,
              color: c.text2,
            }}
          >
            <I.globe size={13} color={c.text3} /> Melbourne, Sydney, Hobart (UTC+10)
          </div>
        </div>
      </header>

      <StatusCard available={available} onChange={onChange} />
      <AvailabilityCard paused={paused} />
      <TimeOffCard paused={paused} />
      <ConnectionsCard paused={paused} />
      <ClientPreviewCard paused={paused} />
    </div>
  );
}

// ── Calendar page (BAL-498) ──────────────────────────────────────
const DAYS = ['Mon 29', 'Tue 30', 'Wed 1', 'Thu 2', 'Fri 3'];
const OPEN = [
  [[9, 17]],
  [[9, 17]],
  [
    [9, 12],
    [13, 17],
  ],
  [[9, 17]],
  [[9, 15]],
];
const MEETINGS = [
  { day: 1, start: 10, end: 11, title: 'Flow audit', who: 'Dana @Acme' },
  { day: 3, start: 14, end: 14.5, title: 'Follow-up call', who: 'Sam @Northwind' },
];
const H0 = 8;
const H1 = 18;
const ROW = 42;

function hourLabel(h) {
  if (h === 12) return '12 PM';
  return h > 12 ? `${h - 12} PM` : `${h} AM`;
}

function CalendarPageView({ available, onGoToSchedule }) {
  const paused = !available;
  const hours = Array.from({ length: H1 - H0 }, (_, i) => H0 + i);
  return (
    <div
      style={{ maxWidth: 920, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: c.text }}>Calendar</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            aria-label="Previous week"
            className="bf"
            style={{ ...btnOutline, padding: 7 }}
          >
            <I.chevL size={14} color={c.text2} />
          </button>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: c.text, padding: '0 6px' }}>
            29 Sep to 3 Oct
          </span>
          <button
            type="button"
            aria-label="Next week"
            className="bf"
            style={{ ...btnOutline, padding: 7 }}
          >
            <I.chevR size={14} color={c.text2} />
          </button>
        </div>
      </header>

      {paused && (
        <div
          role="status"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
            padding: '12px 16px',
            borderRadius: 12,
            border: `1px solid ${c.slateBorder}`,
            background: `${hatch()}, ${c.slateLight}`,
          }}
        >
          <IconTile bg="#E2E8F0">
            <I.pause size={15} color={c.slate} />
          </IconTile>
          <p
            style={{
              flex: 1,
              minWidth: 220,
              margin: 0,
              fontSize: 13.5,
              color: c.text,
              lineHeight: 1.5,
            }}
          >
            <strong style={{ fontWeight: 600 }}>You&apos;re paused.</strong> No new consultations
            will be booked. Meetings you already have stay on your calendar.
          </p>
          <button type="button" className="bf" style={btnOutline} onClick={onGoToSchedule}>
            Go to Schedule
          </button>
        </div>
      )}

      <div
        style={{
          background: c.surface,
          border: `1px solid ${c.border}`,
          borderRadius: 14,
          overflow: 'hidden',
        }}
      >
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 640 }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: `56px repeat(${DAYS.length}, 1fr)`,
                borderBottom: `1px solid ${c.border}`,
              }}
            >
              <span />
              {DAYS.map((d) => (
                <span
                  key={d}
                  style={{
                    padding: '10px 0',
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: c.text2,
                    textAlign: 'center',
                  }}
                >
                  {d}
                </span>
              ))}
            </div>
            <div
              style={{ display: 'grid', gridTemplateColumns: `56px repeat(${DAYS.length}, 1fr)` }}
            >
              <div>
                {hours.map((h) => (
                  <div
                    key={h}
                    style={{
                      height: ROW,
                      fontSize: 11,
                      color: c.text3,
                      textAlign: 'right',
                      paddingRight: 8,
                      transform: 'translateY(-6px)',
                    }}
                  >
                    {hourLabel(h)}
                  </div>
                ))}
              </div>
              {DAYS.map((d, di) => (
                <div
                  key={d}
                  style={{
                    position: 'relative',
                    height: ROW * hours.length,
                    borderLeft: `1px solid ${c.borderSoft}`,
                    backgroundImage: `repeating-linear-gradient(to bottom, transparent 0 ${ROW - 1}px, ${c.borderSoft} ${ROW - 1}px ${ROW}px)`,
                  }}
                >
                  {OPEN[di].map(([s, e]) => (
                    <div
                      key={s}
                      aria-hidden="true"
                      style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        top: (s - H0) * ROW,
                        height: (e - s) * ROW,
                        background: paused ? hatch() : 'rgba(37,99,235,0.07)',
                        borderLeft: `3px solid ${paused ? c.slateBorder : c.primaryBorder}`,
                        transition: 'background .25s',
                      }}
                    />
                  ))}
                  {MEETINGS.filter((m) => m.day === di).map((m) => (
                    <div
                      key={m.title}
                      style={{
                        position: 'absolute',
                        left: 6,
                        right: 6,
                        top: (m.start - H0) * ROW + 2,
                        height: (m.end - m.start) * ROW - 4,
                        borderRadius: 8,
                        background: c.violet,
                        color: '#fff',
                        padding: '5px 8px',
                        overflow: 'hidden',
                        boxShadow: '0 2px 6px rgba(124,58,237,.25)',
                      }}
                    >
                      <div style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.2 }}>
                        {m.title}
                      </div>
                      {m.end - m.start >= 1 && (
                        <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>{m.who}</div>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12.5, color: c.text2 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              width: 14,
              height: 10,
              borderRadius: 2,
              background: paused ? hatch('rgba(100,116,139,0.35)') : 'rgba(37,99,235,0.18)',
            }}
          />
          {paused ? 'Open hours (paused)' : 'Open hours'}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 14, height: 10, borderRadius: 2, background: c.violet }} />
          Booked
        </span>
      </div>
    </div>
  );
}

// ── Notes for CC ─────────────────────────────────────────────────
const NOTES = [
  'Status card is the only new block. It sits above the Availability card and writes `available_for_work` immediately (no Save button), like the timezone line.',
  'Turning OFF opens a confirmation dialog (shadcn AlertDialog) that spells out the impact; nothing is written until "Pause new work" is pressed. Escape, the overlay or "Keep me available" leave the switch on. Turning back ON needs no dialog and applies at once.',
  'Dialog emphasis follows the Balo "don\'t encourage it" rule: "Keep me available" is the solid primary and takes initial focus; "Pause new work" is the outline button.',
  'The "carries on as normal" line uses the expert\'s real counts of upcoming consultations and active projects. Omit any count that is zero; if both are zero, say "Your calendar connection keeps syncing." alone.',
  'Toasts after the change: "You\'re paused" / "You\'re available for new work again". No Undo — the dialog is the safeguard.',
  'Paused → Availability and Time off cards dim. Their controls get `disabled` (not `inert`) and aria-describedby → the PausedNote, so screen readers still read the values. Values are never cleared.',
  'Calendar connections stay fully interactive while paused. Sync keeps existing bookings and conflict checks correct.',
  '"What clients see" swaps the slot grid for the hatched paused message. It must not call the resolver for an empty grid that looks like a broken calendar.',
  'Calendar page: open-hours shading turns to the hatched pattern, the banner explains, booked meetings stay full colour and joinable. "Go to Schedule" links to Expert Settings → Schedule.',
  'Hatching (135°, 6px) is the single "paused" motif across all three surfaces. Reuse one utility; do not invent per-surface greys.',
  'Analytics: `expert_work_availability_changed { available_for_work }` on each confirmed change, plus `expert_work_availability_pause_cancelled` when the dialog is dismissed without pausing.',
];

// ── Pause confirmation ──────────────────────────────────────────
// Prototype stand-in for shadcn AlertDialog: role="alertdialog", labelled + described,
// initial focus on the safe action, Escape cancels.
const UPCOMING = { consultations: 2, projects: 1 };

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function carriesOnLine({ consultations, projects }) {
  const parts = [];
  if (consultations > 0)
    parts.push(plural(consultations, 'upcoming consultation', 'upcoming consultations'));
  if (projects > 0) parts.push(plural(projects, 'active project', 'active projects'));
  if (parts.length === 0) return 'Your calendar connection keeps syncing.';
  return `Your ${parts.join(' and ')} carry on as normal, and your calendar keeps syncing.`;
}

function PauseConfirmDialog({ open, onCancel, onConfirm }) {
  const keepRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    keepRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const impacts = [
    {
      icon: <I.calendar size={15} color={c.slate} />,
      text: "Clients won't be able to book consultations with you.",
    },
    {
      icon: <I.pause size={15} color={c.slate} />,
      text: "Clients can't send you new project briefs. Your profile offers to match them with someone similar instead.",
    },
    {
      icon: <I.check size={15} color={c.success} />,
      text: carriesOnLine(UPCOMING),
    },
    {
      icon: <I.lock size={15} color={c.slate} />,
      text: 'Your hours and time off are kept, ready for when you turn availability back on.',
    },
  ];

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(17,24,39,.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        animation: 'fadeIn .15s ease-out',
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="pause-title"
        aria-describedby="pause-desc"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 460,
          background: c.surface,
          borderRadius: 16,
          boxShadow: '0 24px 60px rgba(17,24,39,.3)',
          padding: '24px 24px 20px',
          animation: 'dialogIn .18s ease-out',
        }}
      >
        <h2 id="pause-title" style={{ margin: 0, fontSize: 18, fontWeight: 700, color: c.text }}>
          Pause new work?
        </h2>
        <p
          id="pause-desc"
          style={{ margin: '6px 0 0', fontSize: 13.5, color: c.text2, lineHeight: 1.55 }}
        >
          While you&apos;re paused:
        </p>
        <ul
          style={{
            listStyle: 'none',
            margin: '14px 0 0',
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 11,
          }}
        >
          {impacts.map((item) => (
            <li key={item.text} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <span
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 7,
                  background: c.slateLight,
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {item.icon}
              </span>
              <span style={{ fontSize: 13.5, color: c.text, lineHeight: 1.5, paddingTop: 3 }}>
                {item.text}
              </span>
            </li>
          ))}
        </ul>
        <p style={{ margin: '16px 0 0', fontSize: 12.5, color: c.text3, lineHeight: 1.5 }}>
          You can turn availability back on any time from Schedule.
        </p>
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
            marginTop: 20,
            flexWrap: 'wrap-reverse',
          }}
        >
          <button type="button" className="bf" style={btnOutline} onClick={onConfirm}>
            Pause new work
          </button>
          <button ref={keepRef} type="button" className="bf" style={btnPrimary} onClick={onCancel}>
            Keep me available
          </button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
export default function ExpertAvailabilityPause() {
  const [view, setView] = useState('schedule');
  const [available, setAvailable] = useState(true);
  const [toast, setToast] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const apply = (next) => {
    setAvailable(next);
    setToast({
      key: Date.now(),
      text: next ? "You're available for new work again" : "You're paused",
    });
  };

  // Off goes through the dialog; on applies at once.
  const change = (next) => {
    if (next) apply(true);
    else setConfirmOpen(true);
  };

  const cancelPause = () => {
    setConfirmOpen(false);
    document.getElementById('work-switch')?.focus();
  };

  const confirmPause = () => {
    setConfirmOpen(false);
    apply(false);
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        background: c.bg,
        fontFamily: FONT,
        color: c.text,
        padding: '28px 20px 120px',
      }}
    >
      <style>{GLOBAL_CSS}</style>
      <link
        href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap"
        rel="stylesheet"
      />

      {/* Prototype controls */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          gap: 14,
          flexWrap: 'wrap',
          marginBottom: 28,
        }}
      >
        <div
          role="tablist"
          aria-label="Prototype view"
          style={{
            display: 'inline-flex',
            gap: 4,
            padding: 4,
            borderRadius: 10,
            background: c.subtle,
            border: `1px solid ${c.borderSoft}`,
          }}
        >
          {[
            ['schedule', 'Settings → Schedule'],
            ['calendar', 'Calendar page'],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={view === key}
              onClick={() => setView(key)}
              className="bf"
              style={{
                padding: '6px 14px',
                borderRadius: 7,
                border: 'none',
                cursor: 'pointer',
                fontSize: 12.5,
                fontWeight: 600,
                fontFamily: FONT,
                background: view === key ? c.surface : 'transparent',
                color: view === key ? c.text : c.text3,
                boxShadow: view === key ? '0 1px 3px rgba(0,0,0,.06)' : 'none',
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 12.5, color: c.text3 }}>
          {view === 'schedule'
            ? 'Use the switch to pause and resume.'
            : `Showing: ${available ? 'available' : 'paused'}.`}
        </span>
        {view === 'calendar' && (
          <button
            type="button"
            className="bf"
            style={{ ...btnOutline, padding: '6px 12px', fontSize: 12.5 }}
            onClick={() => setAvailable(!available)}
          >
            {available ? 'Simulate paused' : 'Simulate available'}
          </button>
        )}
      </div>

      {view === 'schedule' ? (
        <ScheduleTabView available={available} onChange={change} />
      ) : (
        <CalendarPageView available={available} onGoToSchedule={() => setView('schedule')} />
      )}

      <aside
        style={{
          maxWidth: 720,
          margin: '40px auto 0',
          padding: '18px 20px',
          borderRadius: 12,
          border: `1px dashed ${c.border}`,
          background: c.surface,
        }}
      >
        <h2 style={{ margin: '0 0 10px', fontSize: 13.5, fontWeight: 600, color: c.text }}>
          Implementation notes (BAL-591)
        </h2>
        <ul
          style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}
        >
          {NOTES.map((n) => (
            <li key={n} style={{ fontSize: 12.5, color: c.text2, lineHeight: 1.55 }}>
              {n}
            </li>
          ))}
        </ul>
      </aside>

      {toast && (
        <div
          key={toast.key}
          role="status"
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: '11px 16px',
            borderRadius: 11,
            background: c.text,
            color: '#fff',
            fontSize: 13.5,
            boxShadow: '0 10px 30px rgba(17,24,39,.25)',
            animation: 'toastIn .2s ease-out',
            zIndex: 50,
          }}
        >
          <span>{toast.text}</span>
        </div>
      )}

      <PauseConfirmDialog open={confirmOpen} onCancel={cancelPause} onConfirm={confirmPause} />
    </div>
  );
}
