import { useState, useEffect, useRef } from 'react';

// ── Design Tokens ────────────────────────────────────────────────
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
  gradient: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
  gradientSubtle: 'linear-gradient(135deg, #EFF6FF 0%, #F5F3FF 100%)',
};

const keyframes = `
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
@keyframes checkPop { 0% { transform: scale(0); } 60% { transform: scale(1.3); } 100% { transform: scale(1); } }
@keyframes dropIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
`;
const slideUp = (d = 0) => ({ animation: `slideUp 0.4s ease-out ${d}s both` });

// ── Icons ────────────────────────────────────────────────────────
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
const Icons = {
  clock: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={p.style}
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  ),
  globe: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={p.style}
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10A15.3 15.3 0 0112 2z" />
    </svg>
  ),
  plus: (p) => <Icon {...p} d="M12 5v14M5 12h14" />,
  x: (p) => <Icon {...p} d="M18 6L6 18M6 6l12 12" />,
  check: (p) => <Icon {...p} d="M20 6L9 17l-5-5" />,
  chevDown: (p) => <Icon {...p} d="M6 9l6 6 6-6" />,
  copy: (p) => (
    <Icon
      {...p}
      d="M20 9h-9a2 2 0 00-2 2v9a2 2 0 002 2h9a2 2 0 002-2v-9a2 2 0 00-2-2zM5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"
    />
  ),
  trash: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={p.style}
    >
      <path d="M3 6h18M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2" />
    </svg>
  ),
  calendar: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={p.style}
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  ),
  search: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={p.style}
    >
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  ),
  sparkles: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={p.style}
    >
      <path d="M12 3v2m0 14v2m-7-9H3m18 0h-2m-1.636-6.364l-1.414 1.414M7.05 16.95l-1.414 1.414m0-12.728l1.414 1.414m9.9 9.9l1.414 1.414" />
      <circle cx="12" cy="12" r="4" />
    </svg>
  ),
};

// ── Timezone data (subset) ───────────────────────────────────────
const POPULAR_TIMEZONES = [
  { value: 'Australia/Melbourne', label: 'Melbourne, Sydney, Hobart', offset: 'UTC+11' },
  { value: 'Australia/Brisbane', label: 'Brisbane', offset: 'UTC+10' },
  { value: 'Australia/Perth', label: 'Perth', offset: 'UTC+8' },
  { value: 'Pacific/Auckland', label: 'Auckland', offset: 'UTC+13' },
  { value: 'Asia/Singapore', label: 'Singapore, Kuala Lumpur', offset: 'UTC+8' },
  { value: 'America/New_York', label: 'New York, Miami, Toronto', offset: 'UTC-5' },
  { value: 'America/Los_Angeles', label: 'Los Angeles, Vancouver', offset: 'UTC-8' },
  { value: 'Europe/London', label: 'London, Dublin', offset: 'UTC+0' },
  { value: 'Europe/Paris', label: 'Paris, Berlin, Amsterdam', offset: 'UTC+1' },
  { value: 'Asia/Tokyo', label: 'Tokyo, Seoul', offset: 'UTC+9' },
  { value: 'Asia/Dubai', label: 'Dubai, Abu Dhabi', offset: 'UTC+4' },
  { value: 'America/Chicago', label: 'Chicago, Dallas', offset: 'UTC-6' },
];

// ── Time options (30-min increments 5am–11pm) ────────────────────
const TIME_OPTIONS = [];
for (let h = 5; h <= 23; h++) {
  for (let m = 0; m < 60; m += 30) {
    const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const label = `${h12}:${m === 0 ? '00' : '30'} ${ampm}`;
    TIME_OPTIONS.push({ value: `${String(h).padStart(2, '0')}:${m === 0 ? '00' : '30'}`, label });
  }
}

// ── Days of week ─────────────────────────────────────────────────
const DAYS = [
  { key: 'monday', label: 'Mon', full: 'Monday' },
  { key: 'tuesday', label: 'Tue', full: 'Tuesday' },
  { key: 'wednesday', label: 'Wed', full: 'Wednesday' },
  { key: 'thursday', label: 'Thu', full: 'Thursday' },
  { key: 'friday', label: 'Fri', full: 'Friday' },
  { key: 'saturday', label: 'Sat', full: 'Saturday' },
  { key: 'sunday', label: 'Sun', full: 'Sunday' },
];

const DEFAULT_SCHEDULE = {
  monday: [{ start: '09:00', end: '17:00' }],
  tuesday: [{ start: '09:00', end: '17:00' }],
  wednesday: [{ start: '09:00', end: '17:00' }],
  thursday: [{ start: '09:00', end: '17:00' }],
  friday: [{ start: '09:00', end: '17:00' }],
  saturday: [],
  sunday: [],
};

// ── Toggle ───────────────────────────────────────────────────────
function Toggle({ checked, onChange }) {
  return (
    <div
      onClick={() => onChange(!checked)}
      style={{
        width: 36,
        height: 20,
        borderRadius: 10,
        background: checked ? c.primary : c.border,
        position: 'relative',
        cursor: 'pointer',
        transition: 'background 0.2s',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 2,
          left: checked ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: 'white',
          boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
          transition: 'left 0.18s',
        }}
      />
    </div>
  );
}

// ── Time Select ──────────────────────────────────────────────────
function TimeSelect({ value, onChange, min }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const options = min ? TIME_OPTIONS.filter((t) => t.value > min) : TIME_OPTIONS;
  const selected = TIME_OPTIONS.find((t) => t.value === value);

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '6px 10px',
          borderRadius: 7,
          border: `1px solid ${open ? c.primary : c.border}`,
          background: open ? c.primaryLight : c.surface,
          cursor: 'pointer',
          fontSize: 13,
          fontWeight: 500,
          color: c.text,
          whiteSpace: 'nowrap',
          boxShadow: open ? `0 0 0 3px ${c.primaryGlow}` : 'none',
          transition: 'all 0.15s',
          minWidth: 98,
        }}
      >
        <Icons.clock size={12} color={open ? c.primary : c.textTertiary} />
        {selected?.label || '—'}
        <Icons.chevDown
          size={11}
          color={open ? c.primary : c.textTertiary}
          style={{
            marginLeft: 'auto',
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.15s',
          }}
        />
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 30,
            background: c.surface,
            border: `1px solid ${c.border}`,
            borderRadius: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            maxHeight: 220,
            overflowY: 'auto',
            minWidth: 130,
            animation: 'dropIn 0.15s ease-out',
          }}
        >
          {options.map((opt) => (
            <div
              key={opt.value}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              style={{
                padding: '8px 12px',
                fontSize: 13,
                cursor: 'pointer',
                background: value === opt.value ? c.primaryLight : 'transparent',
                color: value === opt.value ? c.primary : c.text,
                fontWeight: value === opt.value ? 600 : 400,
                transition: 'background 0.1s',
              }}
              onMouseEnter={(e) => {
                if (value !== opt.value) e.target.style.background = c.surfaceSubtle;
              }}
              onMouseLeave={(e) => {
                if (value !== opt.value) e.target.style.background = 'transparent';
              }}
            >
              {opt.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Day Row ──────────────────────────────────────────────────────
function DayRow({ day, ranges, onToggle, onUpdateRange, onAddRange, onRemoveRange, enabled }) {
  const [hover, setHover] = useState(false);

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 14,
        padding: '10px 0',
        borderBottom: `1px solid ${c.borderSubtle}`,
      }}
    >
      {/* Day name + toggle */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          width: 110,
          flexShrink: 0,
          paddingTop: 4,
        }}
      >
        <Toggle checked={enabled} onChange={onToggle} />
        <span
          style={{
            fontSize: 13,
            fontWeight: enabled ? 600 : 450,
            color: enabled ? c.text : c.textTertiary,
            transition: 'all 0.2s',
            width: 32,
          }}
        >
          {day.label}
        </span>
      </div>

      {/* Ranges or unavailable */}
      <div style={{ flex: 1 }}>
        {!enabled ? (
          <div style={{ paddingTop: 4 }}>
            <span style={{ fontSize: 13, color: c.textTertiary, fontStyle: 'italic' }}>
              Unavailable
            </span>
          </div>
        ) : (
          <div>
            {ranges.map((range, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: i < ranges.length - 1 ? 8 : 0,
                }}
              >
                <TimeSelect value={range.start} onChange={(v) => onUpdateRange(i, 'start', v)} />
                <span style={{ fontSize: 12, color: c.textTertiary, flexShrink: 0 }}>to</span>
                <TimeSelect
                  value={range.end}
                  onChange={(v) => onUpdateRange(i, 'end', v)}
                  min={range.start}
                />
                {ranges.length > 1 && (
                  <button
                    onClick={() => onRemoveRange(i)}
                    style={{
                      padding: 4,
                      borderRadius: 6,
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      color: c.textTertiary,
                      opacity: hover ? 1 : 0,
                      transition: 'opacity 0.15s',
                    }}
                  >
                    <Icons.x size={13} color={c.textTertiary} />
                  </button>
                )}
              </div>
            ))}
            {/* Add time range */}
            {ranges.length < 3 && (
              <button
                onClick={onAddRange}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  marginTop: 7,
                  padding: '4px 8px',
                  borderRadius: 6,
                  background: 'none',
                  border: `1px dashed ${hover ? c.primary : c.borderSubtle}`,
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 500,
                  color: hover ? c.primary : c.textTertiary,
                  transition: 'all 0.2s',
                }}
              >
                <Icons.plus size={11} color={hover ? c.primary : c.textTertiary} />
                Add range
              </button>
            )}
          </div>
        )}
      </div>

      {/* Hours count badge */}
      {enabled && ranges.length > 0 && (
        <div style={{ paddingTop: 6, flexShrink: 0 }}>
          {(() => {
            const totalMins = ranges.reduce((sum, r) => {
              const [sh, sm] = r.start.split(':').map(Number);
              const [eh, em] = r.end.split(':').map(Number);
              return sum + (eh * 60 + em) - (sh * 60 + sm);
            }, 0);
            const hrs = totalMins / 60;
            return (
              <span style={{ fontSize: 11, color: c.textTertiary }}>
                {hrs % 1 === 0 ? hrs : hrs.toFixed(1)}h
              </span>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// ── Timezone Combobox ────────────────────────────────────────────
function TimezoneSelector({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef(null);
  const inputRef = useRef(null);

  const selected = POPULAR_TIMEZONES.find((t) => t.value === value) || POPULAR_TIMEZONES[0];
  const filtered = query
    ? POPULAR_TIMEZONES.filter(
        (t) =>
          t.label.toLowerCase().includes(query.toLowerCase()) ||
          t.value.toLowerCase().includes(query.toLowerCase())
      )
    : POPULAR_TIMEZONES;

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);
  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Live clock in selected timezone
  const [localTime, setLocalTime] = useState('');
  useEffect(() => {
    const update = () => {
      try {
        const time = new Date().toLocaleTimeString('en-AU', {
          timeZone: value,
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        });
        const day = new Date().toLocaleDateString('en-AU', { timeZone: value, weekday: 'long' });
        setLocalTime(`${time} ${day}`);
      } catch {
        setLocalTime('');
      }
    };
    update();
    const id = setInterval(update, 10000);
    return () => clearInterval(id);
  }, [value]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          width: '100%',
          padding: '10px 14px',
          borderRadius: 10,
          border: `1px solid ${open ? c.primary : c.border}`,
          background: c.surface,
          cursor: 'pointer',
          textAlign: 'left',
          boxShadow: open ? `0 0 0 3px ${c.primaryGlow}` : 'none',
          transition: 'all 0.2s',
        }}
      >
        <Icons.globe size={16} color={open ? c.primary : c.textTertiary} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 500, color: c.text }}>{selected.label}</span>
          {localTime && (
            <span style={{ fontSize: 12, color: c.textTertiary, marginLeft: 8 }}>
              · {localTime}
            </span>
          )}
        </div>
        <span
          style={{ fontSize: 11, color: c.textTertiary, fontFamily: 'monospace', marginRight: 4 }}
        >
          {selected.offset}
        </span>
        <Icons.chevDown
          size={14}
          color={c.textTertiary}
          style={{
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.2s',
            flexShrink: 0,
          }}
        />
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            right: 0,
            zIndex: 40,
            background: c.surface,
            border: `1px solid ${c.border}`,
            borderRadius: 12,
            boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
            overflow: 'hidden',
            animation: 'dropIn 0.18s ease-out',
          }}
        >
          <div style={{ padding: '8px 8px 4px', borderBottom: `1px solid ${c.borderSubtle}` }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 10px',
                borderRadius: 7,
                background: c.surfaceSubtle,
                border: `1px solid ${c.borderSubtle}`,
              }}
            >
              <Icons.search size={13} color={c.textTertiary} />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search timezone..."
                style={{
                  flex: 1,
                  fontSize: 13,
                  color: c.text,
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                }}
              />
            </div>
          </div>
          <div style={{ maxHeight: 240, overflowY: 'auto' }}>
            {filtered.map((tz) => (
              <div
                key={tz.value}
                onClick={() => {
                  onChange(tz.value);
                  setOpen(false);
                  setQuery('');
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '9px 14px',
                  cursor: 'pointer',
                  background: value === tz.value ? c.primaryLight : 'transparent',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={(e) => {
                  if (value !== tz.value) e.currentTarget.style.background = c.surfaceSubtle;
                }}
                onMouseLeave={(e) => {
                  if (value !== tz.value) e.currentTarget.style.background = 'transparent';
                }}
              >
                <div style={{ flex: 1 }}>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: value === tz.value ? 600 : 400,
                      color: value === tz.value ? c.primary : c.text,
                    }}
                  >
                    {tz.label}
                  </span>
                  <span style={{ fontSize: 11, color: c.textTertiary, marginLeft: 6 }}>
                    {tz.value.split('/')[1]?.replace('_', ' ')}
                  </span>
                </div>
                <span style={{ fontSize: 11, color: c.textTertiary, fontFamily: 'monospace' }}>
                  {tz.offset}
                </span>
                {value === tz.value && <Icons.check size={13} color={c.primary} />}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Saved State Preview (text summary until BAL-236 component exists) ──────────
function ScheduleSavedPreview({ schedule, timezone }) {
  const tz = POPULAR_TIMEZONES.find((t) => t.value === timezone);
  const enabledDays = DAYS.filter((d) => schedule[d.key]?.length > 0);

  return (
    <div
      style={{
        padding: '16px',
        borderRadius: 10,
        background: c.successLight,
        border: `1px solid ${c.successBorder}`,
        animation: 'fadeIn 0.3s ease-out',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
        <span style={{ animation: 'checkPop 0.3s ease-out', display: 'inline-flex' }}>
          <Icons.check size={14} color={c.success} />
        </span>
        <span style={{ fontSize: 13, fontWeight: 650, color: c.success }}>
          Schedule saved — {enabledDays.length} days active
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {enabledDays.map((day) => (
          <div
            key={day.key}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '4px 10px',
              borderRadius: 20,
              background: 'white',
              border: `1px solid ${c.successBorder}`,
              fontSize: 12,
            }}
          >
            <span style={{ fontWeight: 600, color: c.text }}>{day.label}</span>
            <span style={{ color: c.textTertiary }}>
              {schedule[day.key]
                .map((r) => {
                  const fmt = (t) => {
                    const [h, m] = t.split(':').map(Number);
                    return `${h > 12 ? h - 12 : h}:${m === 0 ? '00' : '30'}${h >= 12 ? 'pm' : 'am'}`;
                  };
                  return `${fmt(r.start)}–${fmt(r.end)}`;
                })
                .join(', ')}
            </span>
          </div>
        ))}
      </div>
      {tz && (
        <p
          style={{
            fontSize: 12,
            color: c.success,
            margin: '8px 0 0',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Icons.globe size={11} color={c.success} />
          {tz.label} · {tz.offset}
        </p>
      )}
      <p style={{ fontSize: 12, color: c.success, margin: '6px 0 0', opacity: 0.75 }}>
        Slot preview will appear here once ExpertAvailabilityCalendar component is built (BAL-236)
      </p>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN PAGE
// ══════════════════════════════════════════════════════════════════

const DEMO_STATES = [
  { key: 'empty', label: 'Empty' },
  { key: 'editing', label: 'Editing' },
  { key: 'saved', label: 'Saved' },
];

export default function ScheduleEditor() {
  const [demoState, setDemoState] = useState('editing');
  const [timezone, setTimezone] = useState('Australia/Melbourne');
  const [schedule, setSchedule] = useState(DEFAULT_SCHEDULE);
  const [saved, setSaved] = useState(false);

  const isEditing = demoState === 'editing';
  const isEmpty = demoState === 'empty';
  const isSaved = demoState === 'saved';

  const toggleDay = (dayKey) => {
    setSchedule((prev) => ({
      ...prev,
      [dayKey]: prev[dayKey]?.length > 0 ? [] : [{ start: '09:00', end: '17:00' }],
    }));
  };

  const updateRange = (dayKey, i, field, val) => {
    setSchedule((prev) => {
      const ranges = [...prev[dayKey]];
      ranges[i] = { ...ranges[i], [field]: val };
      if (field === 'start' && ranges[i].end <= val) {
        const idx = TIME_OPTIONS.findIndex((t) => t.value === val);
        ranges[i].end = TIME_OPTIONS[Math.min(idx + 4, TIME_OPTIONS.length - 1)].value;
      }
      return { ...prev, [dayKey]: ranges };
    });
  };

  const addRange = (dayKey) => {
    setSchedule((prev) => {
      const ranges = prev[dayKey];
      const lastEnd = ranges[ranges.length - 1]?.end || '17:00';
      const idx = TIME_OPTIONS.findIndex((t) => t.value === lastEnd);
      const newStart = TIME_OPTIONS[Math.min(idx + 2, TIME_OPTIONS.length - 2)].value;
      const newEnd = TIME_OPTIONS[Math.min(idx + 4, TIME_OPTIONS.length - 1)].value;
      return { ...prev, [dayKey]: [...ranges, { start: newStart, end: newEnd }] };
    });
  };

  const removeRange = (dayKey, i) => {
    setSchedule((prev) => ({
      ...prev,
      [dayKey]: prev[dayKey].filter((_, idx) => idx !== i),
    }));
  };

  const totalHours = DAYS.reduce((sum, d) => {
    return (
      sum +
      (schedule[d.key] || []).reduce((s, r) => {
        const [sh, sm] = r.start.split(':').map(Number);
        const [eh, em] = r.end.split(':').map(Number);
        return s + (eh * 60 + em - sh * 60 - sm) / 60;
      }, 0)
    );
  }, 0);

  return (
    <div
      style={{
        minHeight: '100vh',
        background: c.bg,
        fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif",
        padding: '32px 40px',
      }}
    >
      <style>{keyframes}</style>
      <link
        href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap"
        rel="stylesheet"
      />

      {/* State switcher */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 28 }}>
        <div
          style={{
            display: 'inline-flex',
            gap: 4,
            padding: 4,
            borderRadius: 10,
            background: '#F1F4F8',
            border: '1px solid #EAEFF5',
          }}
        >
          {DEMO_STATES.map((s) => (
            <button
              key={s.key}
              onClick={() => setDemoState(s.key)}
              style={{
                padding: '6px 16px',
                borderRadius: 7,
                fontSize: 12,
                fontWeight: 550,
                border: 'none',
                cursor: 'pointer',
                background: demoState === s.key ? c.surface : 'transparent',
                color: demoState === s.key ? c.text : c.textTertiary,
                boxShadow: demoState === s.key ? '0 1px 3px rgba(0,0,0,0.06)' : 'none',
                transition: 'all 0.15s',
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ maxWidth: 660, margin: '0 auto' }}>
        {/* Page header */}
        <div style={{ marginBottom: 28, ...slideUp(0) }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 11,
                background: 'rgba(8,145,178,0.08)',
                border: '1px solid rgba(8,145,178,0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icons.clock size={20} color="#0891B2" />
            </div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: c.text, margin: 0 }}>Schedule</h1>
          </div>
          <p style={{ fontSize: 14, color: c.textSecondary, margin: 0, lineHeight: 1.6 }}>
            Set the days and times you're available for consultations. Clients will only be able to
            book within these windows.
          </p>
        </div>

        {/* ── EMPTY STATE ─────────────────────────── */}
        {isEmpty && (
          <div style={{ ...slideUp(0.05) }}>
            <div
              style={{
                padding: '56px 40px',
                textAlign: 'center',
                background: c.surface,
                borderRadius: 16,
                border: `1px solid ${c.border}`,
                boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
              }}
            >
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 15,
                  margin: '0 auto 18px',
                  background: 'rgba(8,145,178,0.08)',
                  border: '1px solid rgba(8,145,178,0.15)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icons.clock size={26} color="#0891B2" />
              </div>
              <h3 style={{ fontSize: 17, fontWeight: 700, color: c.text, margin: '0 0 8px' }}>
                Set your working hours
              </h3>
              <p
                style={{
                  fontSize: 14,
                  color: c.textSecondary,
                  margin: '0 auto 24px',
                  lineHeight: 1.6,
                  maxWidth: 360,
                }}
              >
                Tell clients when you're available for consultations. You can always update this
                later and add date-specific blocks for holidays or leave.
              </p>
              <button
                onClick={() => setDemoState('editing')}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '10px 22px',
                  borderRadius: 10,
                  fontSize: 13,
                  fontWeight: 650,
                  background: c.primary,
                  color: 'white',
                  border: 'none',
                  cursor: 'pointer',
                  boxShadow: `0 2px 10px ${c.primaryGlow}`,
                }}
              >
                <Icons.sparkles size={14} color="white" />
                Set up schedule
              </button>
            </div>
          </div>
        )}

        {/* ── EDITING STATE ────────────────────────── */}
        {(isEditing || isSaved) && (
          <div key={demoState}>
            {/* Section 1: Timezone */}
            <div
              style={{
                background: c.surface,
                borderRadius: 16,
                border: `1px solid ${c.border}`,
                boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
                padding: '20px 22px',
                marginBottom: 12,
                ...slideUp(0.04),
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12 }}>
                <Icons.globe size={13} color={c.primary} />
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: c.primary,
                    textTransform: 'uppercase',
                    letterSpacing: '0.07em',
                  }}
                >
                  Timezone
                </span>
              </div>
              <TimezoneSelector value={timezone} onChange={setTimezone} />
              <p style={{ fontSize: 12, color: c.textTertiary, margin: '8px 0 0' }}>
                Your schedule times are set in this timezone. Clients see slots converted to their
                local time.
              </p>
            </div>

            {/* Section 2: Weekly Hours */}
            <div
              style={{
                background: c.surface,
                borderRadius: 16,
                border: `1px solid ${c.border}`,
                boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
                padding: '20px 22px',
                marginBottom: 12,
                ...slideUp(0.07),
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 4,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <Icons.calendar size={13} color={c.primary} />
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: c.primary,
                      textTransform: 'uppercase',
                      letterSpacing: '0.07em',
                    }}
                  >
                    Weekly Hours
                  </span>
                </div>
                {/* Total hours summary */}
                <span style={{ fontSize: 12, color: c.textTertiary }}>{totalHours}h / week</span>
              </div>

              {/* Column headers */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, paddingBottom: 6 }}>
                <div style={{ width: 110, flexShrink: 0 }}>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: c.textTertiary,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                    }}
                  >
                    Day
                  </span>
                </div>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: c.textTertiary,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  Available hours
                </span>
              </div>

              {DAYS.map((day) => (
                <DayRow
                  key={day.key}
                  day={day}
                  enabled={!!schedule[day.key]?.length}
                  ranges={schedule[day.key] || []}
                  onToggle={() => toggleDay(day.key)}
                  onUpdateRange={(i, f, v) => updateRange(day.key, i, f, v)}
                  onAddRange={() => addRange(day.key)}
                  onRemoveRange={(i) => removeRange(day.key, i)}
                />
              ))}

              {/* Quick actions */}
              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <button
                  onClick={() => setSchedule({ ...DEFAULT_SCHEDULE })}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '5px 12px',
                    borderRadius: 7,
                    fontSize: 12,
                    fontWeight: 500,
                    background: c.surface,
                    border: `1px solid ${c.border}`,
                    cursor: 'pointer',
                    color: c.textSecondary,
                  }}
                >
                  <Icons.sparkles size={11} color={c.textTertiary} />
                  Reset to default (Mon–Fri, 9–5)
                </button>
                <button
                  onClick={() => {
                    const monRanges = schedule.monday;
                    if (!monRanges?.length) return;
                    setSchedule((prev) => ({
                      ...prev,
                      tuesday: [...monRanges],
                      wednesday: [...monRanges],
                      thursday: [...monRanges],
                      friday: [...monRanges],
                    }));
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '5px 12px',
                    borderRadius: 7,
                    fontSize: 12,
                    fontWeight: 500,
                    background: c.surface,
                    border: `1px solid ${c.border}`,
                    cursor: 'pointer',
                    color: c.textSecondary,
                  }}
                >
                  <Icons.copy size={11} color={c.textTertiary} />
                  Copy Mon to weekdays
                </button>
              </div>
            </div>

            {/* Section 3: Saved preview (saved state only) */}
            {isSaved && (
              <div style={{ marginBottom: 12, ...slideUp(0.1) }}>
                <ScheduleSavedPreview schedule={schedule} timezone={timezone} />
              </div>
            )}

            {/* Save CTA */}
            {!isSaved && (
              <div
                style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, ...slideUp(0.1) }}
              >
                <button
                  style={{
                    padding: '10px 18px',
                    borderRadius: 10,
                    fontSize: 13,
                    fontWeight: 550,
                    background: c.surface,
                    border: `1px solid ${c.border}`,
                    cursor: 'pointer',
                    color: c.textSecondary,
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => setDemoState('saved')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    padding: '10px 22px',
                    borderRadius: 10,
                    fontSize: 13,
                    fontWeight: 650,
                    background: c.primary,
                    color: 'white',
                    border: 'none',
                    cursor: 'pointer',
                    boxShadow: `0 2px 10px ${c.primaryGlow}`,
                  }}
                >
                  <Icons.check size={14} color="white" />
                  Save schedule
                </button>
              </div>
            )}

            {isSaved && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', ...slideUp(0.12) }}>
                <button
                  onClick={() => setDemoState('editing')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '9px 18px',
                    borderRadius: 9,
                    fontSize: 13,
                    fontWeight: 550,
                    background: c.surface,
                    border: `1px solid ${c.border}`,
                    cursor: 'pointer',
                    color: c.textSecondary,
                  }}
                >
                  Edit schedule
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
