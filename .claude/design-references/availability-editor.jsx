import { useState } from 'react';
import {
  Clock,
  Plus,
  X,
  Copy,
  ChevronDown,
  AlertTriangle,
  Info,
  Globe,
  Trash2,
  Check,
  CalendarPlus,
  RefreshCw,
  CalendarDays,
  Sparkles,
} from 'lucide-react';

/**
 * Balo · Design reference — Weekly availability editor (expert)
 * Covers BAL-195. Source of truth for CC implementation.
 *
 * SCOPE: the hours an expert is open to consultations ("positive availability"),
 * plus the scheduling rules that turn those hours into bookable slots. This is
 * the layer the connected calendar's busy time is subtracted from — the editor
 * never shows raw calendar events, only the expert's own rules.
 *
 * The "preview state" control is a REVIEW AFFORDANCE ONLY — remove in
 * implementation. Everything below it is real UI.
 */

// Hex approximations of the app's OKLCH design tokens (src/app/globals.css).
// In implementation these are the real Tailwind v4 tokens, NOT literals:
//   bg/surface → --background/--card (white) · subtle → --muted (slate-100) · border → --border
//   ink → --foreground · muted → --muted-foreground · primary → --primary (SOLID blue, no gradient)
const t = {
  bg: '#FFFFFF',
  surface: '#FFFFFF',
  subtle: '#F1F5F9',
  border: '#E2E8F0',
  borderSubtle: '#F1F5F9',
  ink: '#0F172A',
  ink2: '#1E293B',
  muted: '#64748B',
  muted2: '#94A3B8',
  primary: '#2563EB',
  primary2: '#7C3AED',
  primaryLight: '#EFF6FF',
  primaryBorder: '#BFDBFE',
  successInk: '#15803D',
  successBg: '#F0FDF4',
  successBorder: '#BBF7D0',
  warnInk: '#B45309',
  warnBg: '#FFFBEB',
  warnBorder: '#FDE68A',
  errInk: '#B91C1C',
  errBg: '#FEF2F2',
  errBorder: '#FECACA',
};

/* ---------- primitives (self-contained per design reference) ---------- */
const SectionLabel = ({ icon: Icon, children }) => (
  <div
    style={{
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: '.12em',
      textTransform: 'uppercase',
      color: t.primary,
      marginBottom: 10,
      display: 'flex',
      alignItems: 'center',
      gap: 7,
    }}
  >
    {Icon && <Icon size={13} />}
    <span>{children}</span>
  </div>
);
const Btn = ({ children, variant = 'primary', onClick, icon: Icon, size = 'md', full }) => {
  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    fontWeight: 600,
    borderRadius: 8,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: size === 'sm' ? 13 : 14,
    padding: size === 'sm' ? '7px 13px' : '10px 17px',
    width: full ? '100%' : 'auto',
    transition: 'all .15s',
    border: '1px solid transparent',
    whiteSpace: 'nowrap',
  };
  const v = {
    primary: {
      ...base,
      color: '#fff',
      background: t.primary,
      boxShadow: '0 1px 2px rgba(15,23,41,.08)',
    },
    ghost: { ...base, color: t.ink2, background: '#fff', border: `1px solid ${t.border}` },
    subtle: {
      ...base,
      color: t.primary,
      background: t.primaryLight,
      border: `1px solid ${t.primaryBorder}`,
    },
  }[variant];
  return (
    <button className="balo-btn" style={v} onClick={onClick}>
      {Icon && <Icon size={size === 'sm' ? 15 : 16} />}
      {children}
    </button>
  );
};
const Card = ({ children, style }) => (
  <div
    style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 14, ...style }}
  >
    {children}
  </div>
);

/* ---------- time helpers ---------- */
const fmt = (m) => {
  const h = Math.floor(m / 60),
    min = m % 60,
    ampm = h < 12 ? 'AM' : 'PM',
    h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(min).padStart(2, '0')} ${ampm}`;
};
const TIME_OPTS = [];
for (let m = 0; m < 24 * 60; m += 15) TIME_OPTS.push({ v: m, label: fmt(m) });

const Select = ({ value, onChange, options, compact }) => (
  <div style={{ position: 'relative', display: 'inline-block' }}>
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{
        appearance: 'none',
        WebkitAppearance: 'none',
        padding: compact ? '7px 30px 7px 11px' : '11px 38px 11px 13px',
        borderRadius: compact ? 9 : 10,
        border: `1px solid ${t.border}`,
        background: '#fff',
        fontFamily: 'inherit',
        fontSize: compact ? 13.5 : 14,
        color: t.ink,
        cursor: 'pointer',
        fontWeight: compact ? 500 : 400,
      }}
    >
      {options.map((o) => (
        <option key={o.v} value={o.v}>
          {o.label}
        </option>
      ))}
    </select>
    <ChevronDown
      size={compact ? 15 : 17}
      color={t.muted}
      style={{
        position: 'absolute',
        right: compact ? 9 : 12,
        top: compact ? 9 : 12,
        pointerEvents: 'none',
      }}
    />
  </div>
);

const Toggle = ({ on, onChange }) => (
  <button
    role="switch"
    aria-checked={on}
    onClick={() => onChange(!on)}
    style={{
      width: 38,
      height: 22,
      borderRadius: 999,
      padding: 2,
      border: 'none',
      cursor: 'pointer',
      background: on ? t.primary : '#CBD5E1',
      transition: 'background .2s',
      flexShrink: 0,
    }}
  >
    <span
      style={{
        display: 'block',
        width: 18,
        height: 18,
        borderRadius: 999,
        background: '#fff',
        transform: on ? 'translateX(16px)' : 'translateX(0)',
        transition: 'transform .2s',
        boxShadow: '0 1px 2px rgba(15,23,41,.25)',
      }}
    />
  </button>
);

/* ---------- weekly hours ---------- */
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DEFAULT_WEEK = [
  { on: true, ranges: [{ start: 540, end: 1020 }] },
  { on: true, ranges: [{ start: 540, end: 1020 }] },
  {
    on: true,
    ranges: [
      { start: 540, end: 780 },
      { start: 840, end: 1020 },
    ],
  },
  { on: true, ranges: [{ start: 540, end: 1020 }] },
  { on: true, ranges: [{ start: 540, end: 960 }] },
  { on: false, ranges: [] },
  { on: false, ranges: [] },
];

const DayRow = ({ idx, day, onToggle, onRange, onAdd, onRemove, onCopy }) => {
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState({});
  const apply = () => {
    onCopy(
      idx,
      Object.keys(targets)
        .filter((k) => targets[k])
        .map(Number)
    );
    setOpen(false);
    setTargets({});
  };
  return (
    <div
      style={{
        display: 'flex',
        gap: 14,
        padding: '14px 0',
        borderTop: idx ? `1px solid ${t.borderSubtle}` : 'none',
        alignItems: 'flex-start',
        flexWrap: 'wrap',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          width: 96,
          flexShrink: 0,
          paddingTop: 6,
        }}
      >
        <Toggle on={day.on} onChange={onToggle} />
        <span style={{ fontWeight: 600, color: day.on ? t.ink : t.muted2, fontSize: 14 }}>
          {DAYS[idx]}
        </span>
      </div>
      <div style={{ flex: 1, minWidth: 220 }}>
        {!day.on ? (
          <div style={{ color: t.muted2, fontSize: 14, paddingTop: 8 }}>Unavailable</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {day.ranges.map((r, ri) => (
              <div
                key={ri}
                style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
              >
                <Select
                  compact
                  value={r.start}
                  onChange={(v) => onRange(ri, 'start', v)}
                  options={TIME_OPTS}
                />
                <span style={{ color: t.muted, fontSize: 14 }}>–</span>
                <Select
                  compact
                  value={r.end}
                  onChange={(v) => onRange(ri, 'end', v)}
                  options={TIME_OPTS}
                />
                <button
                  onClick={() => onRemove(ri)}
                  aria-label="Remove hours"
                  className="balo-icon-btn"
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 8,
                    border: `1px solid ${t.border}`,
                    background: '#fff',
                    display: 'grid',
                    placeItems: 'center',
                    cursor: 'pointer',
                    color: t.muted,
                  }}
                >
                  <X size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0, paddingTop: 4, position: 'relative' }}>
        {day.on && (
          <button
            onClick={onAdd}
            aria-label="Add hours"
            className="balo-icon-btn"
            style={{
              width: 34,
              height: 34,
              borderRadius: 9,
              border: `1px solid ${t.border}`,
              background: '#fff',
              display: 'grid',
              placeItems: 'center',
              cursor: 'pointer',
              color: t.muted,
            }}
          >
            <Plus size={17} />
          </button>
        )}
        <button
          onClick={() => setOpen((o) => !o)}
          aria-label="Copy hours to other days"
          className="balo-icon-btn"
          style={{
            width: 34,
            height: 34,
            borderRadius: 9,
            border: `1px solid ${t.border}`,
            background: '#fff',
            display: 'grid',
            placeItems: 'center',
            cursor: 'pointer',
            color: t.muted,
          }}
        >
          <Copy size={16} />
        </button>
        {open && (
          <div
            style={{
              position: 'absolute',
              right: 0,
              top: 40,
              background: '#fff',
              border: `1px solid ${t.border}`,
              borderRadius: 12,
              boxShadow: '0 14px 34px -14px rgba(15,23,41,.25)',
              padding: 12,
              width: 200,
              zIndex: 10,
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '.08em',
                textTransform: 'uppercase',
                color: t.muted,
                marginBottom: 8,
              }}
            >
              Copy {DAYS[idx]} to
            </div>
            {DAYS.map((d, di) =>
              di === idx ? null : (
                <label
                  key={d}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 9,
                    padding: '5px 4px',
                    cursor: 'pointer',
                    fontSize: 13.5,
                    color: t.ink2,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={!!targets[di]}
                    onChange={(e) => setTargets((s) => ({ ...s, [di]: e.target.checked }))}
                    style={{ width: 16, height: 16, accentColor: t.primary, cursor: 'pointer' }}
                  />
                  {d}
                </label>
              )
            )}
            <div style={{ marginTop: 10 }}>
              <Btn size="sm" full onClick={apply}>
                Apply
              </Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const WeeklyHours = () => {
  const [week, setWeek] = useState(DEFAULT_WEEK);
  const mut = (fn) =>
    setWeek((w) => fn(w.map((d) => ({ ...d, ranges: d.ranges.map((r) => ({ ...r })) }))));
  return (
    <Card style={{ padding: '20px 22px' }}>
      <SectionLabel icon={Clock}>Weekly hours</SectionLabel>
      <div style={{ color: t.muted, fontSize: 13.5, lineHeight: 1.5, marginBottom: 6 }}>
        Set the hours you're open to consultations each week.
      </div>
      <div>
        {week.map((day, idx) => (
          <DayRow
            key={idx}
            idx={idx}
            day={day}
            onToggle={(on) =>
              mut((w) => {
                w[idx].on = on;
                if (on && !w[idx].ranges.length) w[idx].ranges = [{ start: 540, end: 1020 }];
                return w;
              })
            }
            onRange={(ri, f, v) =>
              mut((w) => {
                w[idx].ranges[ri][f] = v;
                return w;
              })
            }
            onAdd={() =>
              mut((w) => {
                const last = w[idx].ranges[w[idx].ranges.length - 1];
                const s = last ? Math.min(last.end + 60, 1425) : 540;
                w[idx].ranges.push({ start: s, end: Math.min(s + 60, 1440) });
                return w;
              })
            }
            onRemove={(ri) =>
              mut((w) => {
                w[idx].ranges.splice(ri, 1);
                if (!w[idx].ranges.length) w[idx].on = false;
                return w;
              })
            }
            onCopy={(src, tgts) =>
              mut((w) => {
                tgts.forEach((ti) => {
                  w[ti].on = true;
                  w[ti].ranges = w[src].ranges.map((r) => ({ ...r }));
                });
                return w;
              })
            }
          />
        ))}
      </div>
    </Card>
  );
};

/* ---------- scheduling rules (feed the slot engine) ---------- */
const BUF_OPTS = [
  { v: 0, label: 'None' },
  { v: 5, label: '5 min' },
  { v: 10, label: '10 min' },
  { v: 15, label: '15 min' },
  { v: 30, label: '30 min' },
];
const NOTICE_OPTS = [
  { v: 0, label: 'No minimum' },
  { v: 60, label: '1 hour' },
  { v: 120, label: '2 hours' },
  { v: 240, label: '4 hours' },
  { v: 720, label: '12 hours' },
  { v: 1440, label: '1 day' },
  { v: 2880, label: '2 days' },
];
const WINDOW_OPTS = [
  { v: 14, label: '2 weeks ahead' },
  { v: 30, label: '30 days ahead' },
  { v: 60, label: '60 days ahead' },
  { v: 90, label: '90 days ahead' },
];

const Rule = ({ label, help, value, onChange, options }) => (
  <div>
    <div style={{ fontWeight: 600, color: t.ink, fontSize: 14 }}>{label}</div>
    <div style={{ color: t.muted, fontSize: 12.5, lineHeight: 1.45, margin: '2px 0 9px' }}>
      {help}
    </div>
    <Select value={value} onChange={onChange} options={options} />
  </div>
);

const SchedulingRules = () => {
  const [bufBefore, setBufBefore] = useState(0);
  const [bufAfter, setBufAfter] = useState(10);
  const [notice, setNotice] = useState(240);
  const [window, setWindow] = useState(60);
  return (
    <Card style={{ padding: '20px 22px', marginTop: 16 }}>
      <SectionLabel icon={CalendarDays}>Booking rules</SectionLabel>
      <div style={{ color: t.muted, fontSize: 13.5, lineHeight: 1.5, marginBottom: 18 }}>
        How your open hours are turned into bookable times.
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
          gap: 22,
        }}
      >
        <Rule
          label="Booking window"
          help="How far ahead clients can book."
          value={window}
          onChange={setWindow}
          options={WINDOW_OPTS}
        />
        <Rule
          label="Buffer before"
          help="Free time kept ahead of each consultation."
          value={bufBefore}
          onChange={setBufBefore}
          options={BUF_OPTS}
        />
        <Rule
          label="Buffer after"
          help="Free time kept after each consultation."
          value={bufAfter}
          onChange={setBufAfter}
          options={BUF_OPTS}
        />
        <Rule
          label="Minimum notice"
          help="The soonest a client can book you."
          value={notice}
          onChange={setNotice}
          options={NOTICE_OPTS}
        />
      </div>
    </Card>
  );
};

/* ---------- date overrides ---------- */
const OVERRIDES = [
  { id: 1, date: 'Thu, 25 Dec 2026', label: 'Unavailable', off: true },
  { id: 2, date: 'Fri, 2 Jan 2027', label: '10:00 AM – 2:00 PM', off: false },
];
const DateOverrides = () => {
  const [rows, setRows] = useState(OVERRIDES);
  const remove = (id) => setRows((r) => r.filter((x) => x.id !== id));
  return (
    <Card style={{ padding: '20px 22px', marginTop: 16 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <SectionLabel icon={CalendarPlus}>Date overrides</SectionLabel>
          <div style={{ color: t.muted, fontSize: 13.5, lineHeight: 1.5 }}>
            Different hours or time off for specific dates.
          </div>
        </div>
        <Btn
          size="sm"
          variant="subtle"
          icon={Plus}
          onClick={() =>
            setRows((r) => [
              ...r,
              { id: Date.now(), date: 'Pick a date', label: 'Unavailable', off: true },
            ])
          }
        >
          Add a date
        </Btn>
      </div>
      {rows.length === 0 ? (
        <div
          style={{
            marginTop: 16,
            padding: '22px 18px',
            borderRadius: 11,
            border: `1px dashed ${t.border}`,
            textAlign: 'center',
            color: t.muted,
            fontSize: 13.5,
            lineHeight: 1.5,
          }}
        >
          No date overrides yet. Add one for a holiday, time off, or a day with different hours.
        </div>
      ) : (
        <div style={{ marginTop: 14 }}>
          {rows.map((r, i) => (
            <div
              key={r.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 0',
                borderTop: i ? `1px solid ${t.borderSubtle}` : 'none',
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 10,
                  background: r.off ? t.subtle : t.primaryLight,
                  border: `1px solid ${r.off ? t.borderSubtle : t.primaryBorder}`,
                  display: 'grid',
                  placeItems: 'center',
                  flexShrink: 0,
                }}
              >
                <CalendarDays size={18} color={r.off ? t.muted : t.primary} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: t.ink, fontSize: 14 }}>{r.date}</div>
                <div style={{ color: r.off ? t.muted : t.ink2, fontSize: 13, marginTop: 1 }}>
                  {r.label}
                </div>
              </div>
              <button
                onClick={() => remove(r.id)}
                aria-label="Remove override"
                className="balo-icon-btn"
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 9,
                  border: `1px solid ${t.border}`,
                  background: '#fff',
                  display: 'grid',
                  placeItems: 'center',
                  cursor: 'pointer',
                  color: t.muted,
                }}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};

/* ---------- timezone + calendar link ---------- */
const TimezoneBar = () => (
  <Card
    style={{
      padding: '13px 16px',
      marginBottom: 16,
      display: 'flex',
      alignItems: 'center',
      gap: 11,
      flexWrap: 'wrap',
    }}
  >
    <Globe size={17} color={t.primary} style={{ flexShrink: 0 }} />
    <span style={{ fontSize: 13.5, color: t.ink2 }}>
      Times are in your timezone,{' '}
      <strong style={{ fontWeight: 600 }}>Australia/Melbourne (AEST)</strong>. Clients see slots in
      their own.
    </span>
    <button
      className="balo-link"
      style={{
        marginLeft: 'auto',
        border: 'none',
        background: 'none',
        cursor: 'pointer',
        color: t.primary,
        fontWeight: 600,
        fontSize: 13.5,
        fontFamily: 'inherit',
      }}
    >
      Change
    </button>
  </Card>
);
const CalendarLinkNote = () => (
  <div
    style={{
      marginTop: 16,
      display: 'flex',
      gap: 9,
      alignItems: 'flex-start',
      color: t.muted,
      fontSize: 12.5,
      lineHeight: 1.5,
      padding: '0 2px',
    }}
  >
    <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
    <span>
      These are the hours you're open. We automatically hide any times you're already busy on your
      connected calendar, so clients only see when you're genuinely free.
    </span>
  </div>
);

/* ---------- non-loaded states ---------- */
const Sk = ({ w, h = 14, r = 8, style }) => (
  <div className="balo-shimmer" style={{ width: w, height: h, borderRadius: r, ...style }} />
);
const LoadingView = () => (
  <Card style={{ padding: '20px 22px' }}>
    <Sk w={110} h={11} />
    <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 20 }}>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Sk w={38} h={22} r={999} />
          <Sk w={40} />
          <div style={{ flex: 1 }} />
          <Sk w={200} h={34} r={9} />
        </div>
      ))}
    </div>
  </Card>
);
const ErrorView = () => (
  <Card style={{ padding: 40, textAlign: 'center' }}>
    <div
      style={{
        width: 52,
        height: 52,
        borderRadius: 14,
        background: t.errBg,
        border: `1px solid ${t.errBorder}`,
        display: 'grid',
        placeItems: 'center',
        margin: '0 auto 16px',
      }}
    >
      <AlertTriangle size={24} color={t.errInk} />
    </div>
    <div style={{ fontWeight: 600, color: t.ink, fontSize: 16 }}>We couldn't load your hours</div>
    <div
      style={{
        color: t.muted,
        fontSize: 14,
        lineHeight: 1.55,
        maxWidth: 320,
        margin: '8px auto 18px',
      }}
    >
      Something went wrong on our end. Try again in a moment — if it keeps happening, we're already
      looking into it.
    </div>
    <Btn icon={RefreshCw}>Try again</Btn>
  </Card>
);
const EmptyView = ({ onUse }) => (
  <Card style={{ padding: '34px 28px', textAlign: 'center' }}>
    <div
      style={{
        width: 56,
        height: 56,
        borderRadius: 15,
        background: t.primaryLight,
        border: `1px solid ${t.primaryBorder}`,
        display: 'grid',
        placeItems: 'center',
        margin: '0 auto 16px',
      }}
    >
      <Clock size={26} color={t.primary} />
    </div>
    <div style={{ fontWeight: 600, color: t.ink, fontSize: 18 }}>Set your weekly hours</div>
    <div
      style={{
        color: t.muted,
        fontSize: 14,
        lineHeight: 1.55,
        maxWidth: 400,
        margin: '8px auto 20px',
      }}
    >
      Tell us when you're open to consultations. Clients book within these hours — and we hide
      anything you're already busy with.
    </div>
    <div
      style={{
        maxWidth: 340,
        margin: '0 auto',
        padding: 16,
        borderRadius: 12,
        background: t.subtle,
        border: `1px solid ${t.borderSubtle}`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          justifyContent: 'center',
          color: t.ink2,
          fontSize: 13.5,
          fontWeight: 600,
        }}
      >
        <Sparkles size={15} color={t.primary} /> A common starting point
      </div>
      <div style={{ color: t.muted, fontSize: 13, margin: '6px 0 14px' }}>
        Weekday mornings and afternoons, 9:00 AM – 5:00 PM.
      </div>
      <div style={{ display: 'flex', gap: 9, justifyContent: 'center', flexWrap: 'wrap' }}>
        <Btn size="sm" onClick={onUse}>
          Use these hours
        </Btn>
        <Btn size="sm" variant="ghost" onClick={onUse}>
          Set them up myself
        </Btn>
      </div>
    </div>
  </Card>
);

/* ---------- shell ---------- */
const STATES = [
  { id: 'loaded', label: 'Loaded' },
  { id: 'empty', label: 'Empty' },
  { id: 'loading', label: 'Loading' },
  { id: 'error', label: 'Error' },
];
export default function AvailabilityEditor() {
  const [view, setView] = useState('loaded');
  return (
    <div
      className="balo-root"
      style={{ background: t.bg, minHeight: '100vh', padding: '28px 20px 64px' }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap');
        .balo-root, .balo-root * { box-sizing:border-box; font-family:'Geist', ui-sans-serif, system-ui, -apple-system, sans-serif; }
        .balo-btn:hover { filter:brightness(1.03); transform:translateY(-1px); }
        .balo-btn:active { transform:translateY(0); }
        .balo-icon-btn:hover { background:#F1F5F9; border-color:#CBD5E1; }
        .balo-link:hover { text-decoration:underline; }
        .balo-shimmer { background:linear-gradient(90deg,#EEF2F6 25%,#E2E8F0 37%,#EEF2F6 63%); background-size:400% 100%; animation:balo-shimmer 1.4s ease infinite; }
        @keyframes balo-shimmer { 0%{background-position:100% 0} 100%{background-position:0 0} }
        @media (prefers-reduced-motion: reduce) { .balo-shimmer { animation:none } .balo-btn:hover { transform:none } }
      `}</style>

      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        {/* PREVIEW-ONLY — remove in implementation */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 22,
            flexWrap: 'wrap',
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '.1em',
              textTransform: 'uppercase',
              color: t.muted2,
            }}
          >
            Preview state
          </span>
          <div
            style={{
              display: 'inline-flex',
              gap: 4,
              padding: 4,
              background: '#fff',
              border: `1px solid ${t.border}`,
              borderRadius: 11,
            }}
          >
            {STATES.map((s) => (
              <button
                key={s.id}
                onClick={() => setView(s.id)}
                style={{
                  padding: '6px 12px',
                  borderRadius: 8,
                  border: 'none',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: 13,
                  fontWeight: 600,
                  background: view === s.id ? t.primary : 'transparent',
                  color: view === s.id ? '#fff' : t.muted,
                  transition: 'all .15s',
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 20 }}>
          <SectionLabel icon={Clock}>Schedule</SectionLabel>
          <h1
            style={{
              fontSize: 24,
              fontWeight: 700,
              color: t.ink,
              margin: 0,
              letterSpacing: '-.01em',
            }}
          >
            Availability
          </h1>
          <p
            style={{
              color: t.muted,
              fontSize: 14.5,
              lineHeight: 1.55,
              margin: '7px 0 0',
              maxWidth: 520,
            }}
          >
            Set when you're open to consultations. These hours, minus anything busy on your
            calendar, become the times clients can book.
          </p>
        </div>

        {view === 'loaded' && (
          <>
            <TimezoneBar />
            <WeeklyHours />
            <SchedulingRules />
            <DateOverrides />
            <CalendarLinkNote />
          </>
        )}
        {view === 'empty' && <EmptyView onUse={() => setView('loaded')} />}
        {view === 'loading' && <LoadingView />}
        {view === 'error' && <ErrorView />}
      </div>
    </div>
  );
}
