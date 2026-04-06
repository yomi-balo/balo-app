import { useState, useEffect } from 'react';

// ── Design Tokens ────────────────────────────────────────────────
const c = {
  bg: '#F8FAFB', surface: '#FFFFFF', surfaceSubtle: '#F1F4F8',
  border: '#E0E4EB', borderSubtle: '#EAEFF5',
  text: '#111827', textSecondary: '#4B5563', textTertiary: '#9CA3AF',
  primary: '#2563EB', primaryDark: '#1D4ED8', primaryLight: '#EFF6FF',
  primaryBorder: '#BFDBFE', primaryGlow: 'rgba(37,99,235,0.12)',
  accent: '#7C3AED', accentLight: '#F5F3FF', accentBorder: '#DDD6FE',
  success: '#059669', successLight: '#ECFDF5', successBorder: '#A7F3D0',
  error: '#DC2626', errorLight: '#FEF2F2',
  gradient: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
  gradientSubtle: 'linear-gradient(135deg, #EFF6FF 0%, #F5F3FF 100%)',
};

const keyframes = `
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
@keyframes shimmer {
  0% { background-position: -400px 0; }
  100% { background-position: 400px 0; }
}
@keyframes checkPop { 0% { transform: scale(0); } 60% { transform: scale(1.3); } 100% { transform: scale(1); } }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
`;
const slideUp = (d = 0) => ({ animation: `slideUp 0.35s ease-out ${d}s both` });
const SHIMMER = {
  background: 'linear-gradient(90deg, #E0E4EB 25%, #EEF1F6 50%, #E0E4EB 75%)',
  backgroundSize: '400px 100%',
  animation: 'shimmer 1.4s ease-in-out infinite',
};

// ── Icons ────────────────────────────────────────────────────────
const Icon = ({ d, size = 16, color = 'currentColor', style: xs }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
    strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={xs}><path d={d} /></svg>
);
const Icons = {
  calendar: (p) => <svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" fill="none" stroke={p.color||'currentColor'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={p.style}><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>,
  clock: (p) => <svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" fill="none" stroke={p.color||'currentColor'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={p.style}><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>,
  globe: (p) => <svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" fill="none" stroke={p.color||'currentColor'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={p.style}><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10A15.3 15.3 0 0112 2z"/></svg>,
  check: (p) => <Icon {...p} d="M20 6L9 17l-5-5" />,
  refreshCw: (p) => <Icon {...p} d="M21 2v6h-6M3 12a9 9 0 0115-6.7L21 8M3 22v-6h6M21 12a9 9 0 01-15 6.7L3 16" />,
  alertCircle: (p) => <svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" fill="none" stroke={p.color||'currentColor'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={p.style}><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>,
  chevLeft: (p) => <Icon {...p} d="M15 18l-6-6 6-6" />,
  chevRight: (p) => <Icon {...p} d="M9 18l6-6-6-6" />,
  info: (p) => <svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" fill="none" stroke={p.color||'currentColor'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={p.style}><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>,
  sparkles: (p) => <svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" fill="none" stroke={p.color||'currentColor'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={p.style}><path d="M12 3v2m0 14v2m-7-9H3m18 0h-2m-1.636-6.364l-1.414 1.414M7.05 16.95l-1.414 1.414m0-12.728l1.414 1.414m9.9 9.9l1.414 1.414"/><circle cx="12" cy="12" r="4"/></svg>,
};

// ── Mock slot data (7 days ahead) ────────────────────────────────
function generateMockSlots() {
  const slots = [];
  const now = new Date();
  for (let d = 0; d < 14; d++) {
    const date = new Date(now);
    date.setDate(date.getDate() + d);
    const dow = date.getDay(); // 0=Sun, 6=Sat
    if (dow === 0 || dow === 6) continue; // skip weekends
    const hours = [9, 9.5, 10, 10.5, 11, 14, 14.5, 15, 15.5, 16];
    // Randomly remove some slots to make it look realistic
    const available = hours.filter(() => Math.random() > 0.35);
    available.forEach(h => {
      const start = new Date(date);
      start.setHours(Math.floor(h), h % 1 === 0 ? 0 : 30, 0, 0);
      const end = new Date(start);
      end.setMinutes(end.getMinutes() + 30);
      slots.push({ start: start.toISOString(), end: end.toISOString() });
    });
  }
  return slots;
}

const MOCK_SLOTS = generateMockSlots();

// Group slots by day
function groupByDay(slots, viewerTimezone = 'Australia/Melbourne') {
  const groups = {};
  slots.forEach(slot => {
    const date = new Date(slot.start);
    const dayKey = date.toLocaleDateString('en-AU', { timeZone: viewerTimezone,
      year: 'numeric', month: '2-digit', day: '2-digit' });
    if (!groups[dayKey]) groups[dayKey] = { date, slots: [] };
    groups[dayKey].slots.push(slot);
  });
  return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
}

// Format time in viewer's timezone
function formatTime(isoStr, timezone) {
  return new Date(isoStr).toLocaleTimeString('en-AU', {
    timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function formatDayHeader(isoStr, timezone) {
  const d = new Date(isoStr);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const isToday = d.toDateString() === today.toDateString();
  const isTomorrow = d.toDateString() === tomorrow.toDateString();

  const dayName = d.toLocaleDateString('en-AU', { timeZone: timezone, weekday: 'short' });
  const dayNum = d.toLocaleDateString('en-AU', { timeZone: timezone, day: 'numeric' });
  const month = d.toLocaleDateString('en-AU', { timeZone: timezone, month: 'short' });

  if (isToday) return { label: `Today, ${dayNum} ${month}`, isToday: true };
  if (isTomorrow) return { label: `Tomorrow, ${dayNum} ${month}`, isTomorrow: true };
  return { label: `${dayName} ${dayNum} ${month}` };
}

// ── Slot Button ──────────────────────────────────────────────────
function SlotButton({ slot, mode, selected, onSelect, viewerTimezone }) {
  const [hover, setHover] = useState(false);
  const isSelectable = mode === 'selectable';
  const isSelected = selected;
  const isInteractive = isSelectable;

  const bg = isSelected
    ? c.gradient
    : hover && isInteractive
      ? c.primaryLight
      : mode === 'preview'
        ? c.surfaceSubtle
        : c.surface;

  const border = isSelected
    ? 'none'
    : hover && isInteractive
      ? `1px solid ${c.primaryBorder}`
      : `1px solid ${c.border}`;

  const textColor = isSelected
    ? 'white'
    : hover && isInteractive
      ? c.primary
      : c.text;

  return (
    <button
      onClick={isInteractive ? onSelect : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ padding: '8px 12px', borderRadius: 8, border, background: bg,
        cursor: isInteractive ? 'pointer' : 'default', fontSize: 13, fontWeight: 550,
        color: textColor, transition: 'all 0.15s',
        boxShadow: isSelected ? `0 2px 8px ${c.primaryGlow}` : 'none',
        display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
      {isSelected && (
        <span style={{ animation: 'checkPop 0.25s ease-out', display: 'inline-flex' }}>
          <Icons.check size={12} color="white" />
        </span>
      )}
      {formatTime(slot.start, viewerTimezone)}
    </button>
  );
}

// ── Loading Skeleton ──────────────────────────────────────────────
function LoadingSkeleton() {
  return (
    <div style={{ animation: 'fadeIn 0.2s ease-out' }}>
      {/* Day tabs skeleton */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
        {[80, 70, 80, 65, 75].map((w, i) => (
          <div key={i} style={{ width: w, height: 36, borderRadius: 8, ...SHIMMER }} />
        ))}
      </div>
      {/* Slot grid skeleton */}
      {[1, 2].map(row => (
        <div key={row} style={{ marginBottom: 20 }}>
          <div style={{ width: 120, height: 12, borderRadius: 4, ...SHIMMER, marginBottom: 10 }} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {[78, 82, 75, 80, 76, 78].map((w, i) => (
              <div key={i} style={{ width: w, height: 36, borderRadius: 8, ...SHIMMER }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Day Tab ───────────────────────────────────────────────────────
function DayTab({ dayData, isSelected, onClick, viewerTimezone }) {
  const [, dateStr] = dayData;
  const info = formatDayHeader(dateStr.date.toISOString(), viewerTimezone);
  const d = new Date(dateStr.date);
  const dayName = d.toLocaleDateString('en-AU', { timeZone: viewerTimezone, weekday: 'short' });
  const dayNum = d.toLocaleDateString('en-AU', { timeZone: viewerTimezone, day: 'numeric' });
  const slotCount = dateStr.slots.length;

  return (
    <button onClick={onClick}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
        padding: '8px 14px', borderRadius: 10, border: 'none', cursor: 'pointer',
        background: isSelected ? c.primary : 'transparent', minWidth: 56,
        transition: 'all 0.15s',
        boxShadow: isSelected ? `0 2px 8px ${c.primaryGlow}` : 'none' }}>
      <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
        letterSpacing: '0.06em', color: isSelected ? 'rgba(255,255,255,0.8)' : c.textTertiary,
        marginBottom: 2 }}>{dayName}</span>
      <span style={{ fontSize: 18, fontWeight: 700,
        color: isSelected ? 'white' : c.text }}>{dayNum}</span>
      <div style={{ marginTop: 4, width: 20, height: 4, borderRadius: 2,
        background: isSelected ? 'rgba(255,255,255,0.4)' : slotCount > 0 ? c.primaryBorder : c.borderSubtle,
        position: 'relative', overflow: 'hidden' }}>
        {slotCount > 0 && (
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0,
            width: `${Math.min((slotCount / 10) * 100, 100)}%`,
            background: isSelected ? 'rgba(255,255,255,0.8)' : c.primary,
            borderRadius: 2 }} />
        )}
      </div>
    </button>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN COMPONENT — ExpertAvailabilityCalendar
// Props: expertId, mode ('preview' | 'selectable'), viewerTimezone,
//        onSlotSelect (selectable mode), daysAhead
// ══════════════════════════════════════════════════════════════════

function ExpertAvailabilityCalendar({
  mode = 'selectable',
  viewerTimezone = 'Australia/Sydney',
  expertTimezone = 'Australia/Melbourne',
  onSlotSelect,
  // demo-only props:
  demoState = 'has_slots',
}) {
  const [selectedDay, setSelectedDay] = useState(0);
  const [selectedSlot, setSelectedSlot] = useState(null);

  const groupedDays = groupByDay(MOCK_SLOTS, viewerTimezone);
  const tzDiffers = viewerTimezone !== expertTimezone;

  const tzLabel = (() => {
    try {
      const offset = new Date().toLocaleDateString('en-AU', { timeZone: viewerTimezone, timeZoneName: 'short' });
      return viewerTimezone.split('/')[1]?.replace('_', ' ') || viewerTimezone;
    } catch { return viewerTimezone; }
  })();

  if (demoState === 'loading') return <LoadingSkeleton />;

  if (demoState === 'empty_not_configured') {
    return (
      <div style={{ padding: '36px 24px', textAlign: 'center', background: c.surface,
        borderRadius: 12, border: `1px solid ${c.border}` }}>
        <div style={{ width: 48, height: 48, borderRadius: 13, margin: '0 auto 14px',
          background: c.surfaceSubtle, border: `1px solid ${c.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icons.calendar size={22} color={c.textTertiary} />
        </div>
        <p style={{ fontSize: 14, fontWeight: 600, color: c.textSecondary, margin: '0 0 6px' }}>
          Schedule not set up yet
        </p>
        <p style={{ fontSize: 13, color: c.textTertiary, margin: 0, lineHeight: 1.5 }}>
          {mode === 'preview'
            ? 'Save your working hours above to see your availability preview here.'
            : 'This expert hasn\'t set their availability yet.'}
        </p>
      </div>
    );
  }

  if (demoState === 'empty_no_slots') {
    return (
      <div style={{ padding: '36px 24px', textAlign: 'center', background: c.surface,
        borderRadius: 12, border: `1px solid ${c.border}` }}>
        <div style={{ width: 48, height: 48, borderRadius: 13, margin: '0 auto 14px',
          background: c.surfaceSubtle, border: `1px solid ${c.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icons.sparkles size={22} color={c.textTertiary} />
        </div>
        <p style={{ fontSize: 14, fontWeight: 600, color: c.textSecondary, margin: '0 0 6px' }}>
          No availability in the next 14 days
        </p>
        <p style={{ fontSize: 13, color: c.textTertiary, margin: 0, lineHeight: 1.5 }}>
          Check back soon — this expert may open more slots shortly.
        </p>
      </div>
    );
  }

  if (demoState === 'error') {
    return (
      <div style={{ padding: '28px 24px', textAlign: 'center', background: c.surface,
        borderRadius: 12, border: `1px solid ${c.border}` }}>
        <Icons.alertCircle size={28} color={c.textTertiary} style={{ marginBottom: 12 }} />
        <p style={{ fontSize: 14, fontWeight: 600, color: c.textSecondary, margin: '0 0 6px' }}>
          Couldn't load availability
        </p>
        <p style={{ fontSize: 13, color: c.textTertiary, margin: '0 0 16px' }}>
          Something went wrong. Please try again.
        </p>
        <button style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '8px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600,
          background: c.surface, border: `1px solid ${c.border}`, cursor: 'pointer',
          color: c.textSecondary }}>
          <Icons.refreshCw size={13} color={c.textTertiary} />
          Retry
        </button>
      </div>
    );
  }

  // ── HAS SLOTS ─────────────────────────────────────────────────
  const activeDayData = groupedDays[selectedDay];

  return (
    <div style={{ animation: 'fadeIn 0.3s ease-out' }}>
      {/* Timezone label */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 12 }}>
        <Icons.globe size={12} color={c.textTertiary} />
        <span style={{ fontSize: 12, color: c.textTertiary }}>
          Times shown in <strong style={{ fontWeight: 600, color: c.textSecondary }}>{tzLabel}</strong>
        </span>
        {tzDiffers && (
          <span style={{ fontSize: 12, color: c.textTertiary }}>
            · Expert's timezone: {expertTimezone.split('/')[1]?.replace('_', ' ')}
          </span>
        )}
      </div>

      {/* Day tab strip */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, overflowX: 'auto',
        paddingBottom: 4, scrollbarWidth: 'none' }}>
        {groupedDays.map((dayData, i) => (
          <DayTab key={i} dayData={dayData} isSelected={selectedDay === i}
            onClick={() => { setSelectedDay(i); setSelectedSlot(null); }}
            viewerTimezone={viewerTimezone} />
        ))}
      </div>

      {/* Active day header */}
      {activeDayData && (
        <div key={selectedDay} style={{ animation: 'fadeIn 0.2s ease-out' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {(() => {
                const info = formatDayHeader(activeDayData[1].date.toISOString(), viewerTimezone);
                return (
                  <span style={{ fontSize: 14, fontWeight: 650, color: c.text }}>
                    {info.label}
                    {info.isToday && (
                      <span style={{ marginLeft: 7, fontSize: 11, fontWeight: 700, padding: '2px 7px',
                        borderRadius: 5, background: c.primaryLight, color: c.primary,
                        border: `1px solid ${c.primaryBorder}` }}>Today</span>
                    )}
                  </span>
                );
              })()}
            </div>
            <span style={{ fontSize: 12, color: c.textTertiary }}>
              {activeDayData[1].slots.length} slot{activeDayData[1].slots.length !== 1 ? 's' : ''} available
            </span>
          </div>

          {/* Slot grid */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {activeDayData[1].slots.map((slot, i) => (
              <SlotButton key={i} slot={slot} mode={mode}
                selected={selectedSlot === `${selectedDay}-${i}`}
                viewerTimezone={viewerTimezone}
                onSelect={() => {
                  setSelectedSlot(`${selectedDay}-${i}`);
                  onSlotSelect?.(slot);
                }} />
            ))}
          </div>

          {/* Selected slot confirmation (selectable mode) */}
          {mode === 'selectable' && selectedSlot?.startsWith(`${selectedDay}-`) && (
            <div style={{ marginTop: 14, padding: '10px 14px', borderRadius: 9,
              background: c.successLight, border: `1px solid ${c.successBorder}`,
              display: 'flex', alignItems: 'center', gap: 8,
              animation: 'slideUp 0.3s ease-out' }}>
              <Icons.check size={14} color={c.success} />
              <span style={{ fontSize: 13, fontWeight: 600, color: c.success }}>
                {formatTime(activeDayData[1].slots[parseInt(selectedSlot.split('-')[1])].start, viewerTimezone)} selected
              </span>
              <span style={{ fontSize: 13, color: c.success, opacity: 0.75 }}>
                · 30 min consultation
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// DEMO WRAPPER
// Shows both modes and all states
// ══════════════════════════════════════════════════════════════════

const DEMO_STATES = [
  { key: 'has_slots', label: 'Has Slots' },
  { key: 'loading', label: 'Loading' },
  { key: 'empty_not_configured', label: 'Not Configured' },
  { key: 'empty_no_slots', label: 'No Slots' },
  { key: 'error', label: 'Error' },
];

export default function AvailabilityCalendarDemo() {
  const [demoState, setDemoState] = useState('has_slots');
  const [mode, setMode] = useState('selectable');
  const [selectedSlot, setSelectedSlot] = useState(null);

  return (
    <div style={{ minHeight: '100vh', background: c.bg,
      fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif",
      padding: '32px 40px' }}>
      <style>{keyframes}</style>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />

      {/* Context note */}
      <div style={{ padding: '10px 14px', borderRadius: 8, background: c.accentLight,
        border: `1px solid ${c.accentBorder}`, maxWidth: 700, margin: '0 auto 20px' }}>
        <p style={{ fontSize: 12, color: c.accent, margin: 0, fontWeight: 500 }}>
          BAL-236 design reference — ExpertAvailabilityCalendar reusable component.
          Props: expertId, mode ("preview" | "selectable"), viewerTimezone, onSlotSelect, daysAhead.
          Component location: packages/web/src/components/availability/ExpertAvailabilityCalendar.tsx
        </p>
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginBottom: 28, flexWrap: 'wrap' }}>
        {/* State switcher */}
        <div style={{ display: 'inline-flex', gap: 4, padding: 4, borderRadius: 10,
          background: c.surfaceSubtle, border: `1px solid ${c.borderSubtle}` }}>
          {DEMO_STATES.map(s => (
            <button key={s.key} onClick={() => setDemoState(s.key)}
              style={{ padding: '6px 14px', borderRadius: 7, fontSize: 12, fontWeight: 550,
                border: 'none', cursor: 'pointer',
                background: demoState === s.key ? c.surface : 'transparent',
                color: demoState === s.key ? c.text : c.textTertiary,
                boxShadow: demoState === s.key ? '0 1px 3px rgba(0,0,0,0.06)' : 'none',
                transition: 'all 0.15s' }}>{s.label}</button>
          ))}
        </div>
        {/* Mode switcher */}
        <div style={{ display: 'inline-flex', gap: 4, padding: 4, borderRadius: 10,
          background: c.surfaceSubtle, border: `1px solid ${c.borderSubtle}` }}>
          {['preview', 'selectable'].map(m => (
            <button key={m} onClick={() => setMode(m)}
              style={{ padding: '6px 14px', borderRadius: 7, fontSize: 12, fontWeight: 550,
                border: 'none', cursor: 'pointer', textTransform: 'capitalize',
                background: mode === m ? c.primary : 'transparent',
                color: mode === m ? 'white' : c.textTertiary,
                boxShadow: mode === m ? `0 1px 4px ${c.primaryGlow}` : 'none',
                transition: 'all 0.15s' }}>{m}</button>
          ))}
        </div>
      </div>

      <div style={{ maxWidth: 700, margin: '0 auto' }}>
        {/* Side-by-side: expert settings context (left) + standalone (right) */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, ...slideUp(0) }}>

          {/* Left: In context of schedule editor (preview mode) */}
          <div>
            <p style={{ fontSize: 11, fontWeight: 700, color: c.textTertiary, textTransform: 'uppercase',
              letterSpacing: '0.07em', margin: '0 0 10px' }}>In schedule editor (preview)</p>
            <div style={{ background: c.surface, borderRadius: 14, border: `1px solid ${c.border}`,
              padding: '18px 18px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 14 }}>
                <Icons.sparkles size={13} color={c.accent} />
                <span style={{ fontSize: 11, fontWeight: 700, color: c.accent,
                  textTransform: 'uppercase', letterSpacing: '0.07em' }}>Your availability preview</span>
              </div>
              <ExpertAvailabilityCalendar mode="preview"
                viewerTimezone="Australia/Melbourne" expertTimezone="Australia/Melbourne"
                demoState={demoState} />
            </div>
          </div>

          {/* Right: In context of client booking (selectable mode) */}
          <div>
            <p style={{ fontSize: 11, fontWeight: 700, color: c.textTertiary, textTransform: 'uppercase',
              letterSpacing: '0.07em', margin: '0 0 10px' }}>On client booking page (selectable)</p>
            <div style={{ background: c.surface, borderRadius: 14, border: `1px solid ${c.border}`,
              padding: '18px 18px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
              <div style={{ marginBottom: 14 }}>
                <p style={{ fontSize: 14, fontWeight: 650, color: c.text, margin: '0 0 2px' }}>
                  Book a consultation
                </p>
                <p style={{ fontSize: 13, color: c.textTertiary, margin: 0 }}>
                  Select a 30-minute time slot
                </p>
              </div>
              <ExpertAvailabilityCalendar mode={mode}
                viewerTimezone="America/New_York" expertTimezone="Australia/Melbourne"
                demoState={demoState}
                onSlotSelect={(slot) => setSelectedSlot(slot)} />
              {selectedSlot && mode === 'selectable' && demoState === 'has_slots' && (
                <button style={{ width: '100%', marginTop: 14, padding: '10px', borderRadius: 10,
                  fontSize: 13, fontWeight: 650, background: c.gradient, color: 'white',
                  border: 'none', cursor: 'pointer', boxShadow: `0 2px 10px ${c.primaryGlow}`,
                  animation: 'slideUp 0.3s ease-out' }}>
                  Confirm booking
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Component API reference */}
        <div style={{ marginTop: 24, padding: '16px 18px', borderRadius: 12,
          background: c.surface, border: `1px solid ${c.border}`, ...slideUp(0.08) }}>
          <p style={{ fontSize: 11, fontWeight: 700, color: c.textTertiary, textTransform: 'uppercase',
            letterSpacing: '0.07em', margin: '0 0 10px' }}>Component API</p>
          <pre style={{ fontSize: 12, color: c.textSecondary, margin: 0, lineHeight: 1.7,
            fontFamily: 'ui-monospace, monospace', overflowX: 'auto' }}>{`<ExpertAvailabilityCalendar
  expertId={string}              // required — fetches from /api/experts/:id/availability
  mode="preview" | "selectable"  // preview = read-only, selectable = clickable slots
  viewerTimezone={string}        // IANA — defaults to browser timezone
  onSlotSelect={(slot) => void}  // selectable mode only: { start: string, end: string } (UTC)
  daysAhead={number}             // default 14 (preview), 60 (selectable)
/>`}</pre>
        </div>
      </div>
    </div>
  );
}
