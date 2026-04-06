import { useState, useMemo } from 'react';

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
};

// Duration badge colours
const DUR_COLORS = {
  15: { bg: '#F1F4F8', text: '#6B7280', border: '#E0E4EB' },
  30: { bg: '#EFF6FF', text: '#2563EB', border: '#BFDBFE' },
  45: { bg: '#F5F3FF', text: '#7C3AED', border: '#DDD6FE' },
  60: { bg: '#ECFDF5', text: '#059669', border: '#A7F3D0' },
};

// ── Mock Data Generator ──────────────────────────────────────────
// Generates slots with varying maxDuration (15 / 30 / 45 / 60 min)
// maxDuration = max time a consultation can run starting from this slot
function generateMonthSlots() {
  const slotsByDay = {};
  const now = new Date();
  const DURATIONS = [15, 30, 30, 60, 60, 45]; // weighted pool

  for (let d = 1; d < 30; d++) {
    const dt = new Date(now);
    dt.setDate(dt.getDate() + d);
    const dow = dt.getDay();
    if (dow === 0 || dow === 6) continue; // skip weekends
    if (Math.random() < 0.2) continue;   // some days off

    const hours = [8, 8.5, 9, 9.5, 10, 10.5, 11, 13, 13.5, 14, 14.5, 15, 15.5, 16];
    const available = hours.filter(() => Math.random() > 0.45);

    const dayKey = dt.toISOString().slice(0, 10);
    slotsByDay[dayKey] = available.map(h => {
      const start = new Date(dt);
      start.setHours(Math.floor(h), h % 1 === 0 ? 0 : 30, 0, 0);
      const end = new Date(start);
      end.setMinutes(end.getMinutes() + 30);
      return {
        start: start.toISOString(),
        end: end.toISOString(),
        maxDuration: DURATIONS[Math.floor(Math.random() * DURATIONS.length)],
      };
    });

    if (slotsByDay[dayKey].length === 0) delete slotsByDay[dayKey];
  }
  return slotsByDay;
}

const SLOTS_BY_DAY = generateMonthSlots();

// ── Helpers ──────────────────────────────────────────────────────
const fmtTime = (iso, tz = 'Australia/Sydney') =>
  new Date(iso).toLocaleTimeString('en-AU', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });

// ── Month Calendar Component ──────────────────────────────────────
// Left panel — shows the month grid, availability dots, day selection
function MonthCalendar({ selectedDay, onSelectDay, viewerTz = 'Australia/Sydney' }) {
  const [monthOffset, setMonthOffset] = useState(0);
  const today = new Date();
  const displayMonth = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);

  const monthLabel = displayMonth.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });

  // Build calendar grid
  const firstDow = (displayMonth.getDay() + 6) % 7; // Mon=0
  const daysInMonth = new Date(displayMonth.getFullYear(), displayMonth.getMonth() + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const getDateKey = (day) => {
    if (!day) return null;
    const dt = new Date(displayMonth.getFullYear(), displayMonth.getMonth(), day);
    return dt.toISOString().slice(0, 10);
  };

  const isPast = (day) => {
    if (!day) return false;
    const dt = new Date(displayMonth.getFullYear(), displayMonth.getMonth(), day);
    const t = new Date(); t.setHours(0, 0, 0, 0);
    return dt < t;
  };

  const isToday = (day) => {
    if (!day) return false;
    const dt = new Date(displayMonth.getFullYear(), displayMonth.getMonth(), day);
    return dt.toDateString() === today.toDateString();
  };

  return (
    <div>
      {/* Month header nav */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <button onClick={() => setMonthOffset(o => o - 1)}
          disabled={monthOffset <= 0}
          style={{ width: 28, height: 28, borderRadius: 7, border: `1px solid ${c.border}`, background: c.surface,
            cursor: monthOffset <= 0 ? 'not-allowed' : 'pointer', opacity: monthOffset <= 0 ? 0.35 : 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke={c.textSecondary} strokeWidth={2.5}><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <span style={{ fontSize: 14, fontWeight: 650, color: c.text }}>{monthLabel}</span>
        <button onClick={() => setMonthOffset(o => o + 1)}
          style={{ width: 28, height: 28, borderRadius: 7, border: `1px solid ${c.border}`, background: c.surface,
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke={c.textSecondary} strokeWidth={2.5}><path d="M9 18l6-6-6-6"/></svg>
        </button>
      </div>

      {/* Day-of-week headers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
        {['M','T','W','T','F','S','S'].map((d, i) => (
          <div key={i} style={{ textAlign: 'center', fontSize: 11, fontWeight: 600,
            color: i >= 5 ? c.textTertiary : c.textTertiary, paddingBottom: 4 }}>{d}</div>
        ))}
      </div>

      {/* Day cells */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
        {cells.map((day, i) => {
          const key = getDateKey(day);
          const hasSlots = key && !!SLOTS_BY_DAY[key];
          const past = isPast(day);
          const today2 = isToday(day);
          const isSel = key === selectedDay;
          const isWeekend = i % 7 >= 5;

          return (
            <div key={i} onClick={hasSlots && !past ? () => onSelectDay(key) : undefined}
              style={{
                height: 36, display: 'flex', flexDirection: 'column', alignItems: 'center',
                justifyContent: 'center', borderRadius: 8, position: 'relative',
                cursor: hasSlots && !past ? 'pointer' : 'default',
                background: isSel ? c.primary : today2 && !isSel ? c.primaryLight : 'transparent',
                border: today2 && !isSel ? `1px solid ${c.primaryBorder}` : '1px solid transparent',
                opacity: past || isWeekend ? 0.35 : 1,
                transition: 'all 0.15s',
              }}>
              {day && (
                <>
                  <span style={{ fontSize: 13, fontWeight: today2 || isSel ? 700 : 400,
                    color: isSel ? 'white' : today2 ? c.primary : c.text, lineHeight: 1 }}>{day}</span>
                  {hasSlots && !past && (
                    <div style={{ width: 4, height: 4, borderRadius: '50%', marginTop: 2,
                      background: isSel ? 'rgba(255,255,255,0.7)' : c.primary }} />
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 14, paddingTop: 12,
        borderTop: `1px solid ${c.borderSubtle}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <div style={{ width: 4, height: 4, borderRadius: '50%', background: c.primary }} />
          <span style={{ fontSize: 11, color: c.textTertiary }}>Available</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <div style={{ width: 16, height: 16, borderRadius: 5, background: c.primary, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 9, color: 'white', fontWeight: 700 }}>1</span>
          </div>
          <span style={{ fontSize: 11, color: c.textTertiary }}>Selected</span>
        </div>
      </div>
    </div>
  );
}

// ── Duration Badge ────────────────────────────────────────────────
function DurBadge({ duration }) {
  const style = DUR_COLORS[duration] || DUR_COLORS[30];
  return (
    <span style={{ fontSize: 11, fontWeight: 650, padding: '2px 7px', borderRadius: 5,
      background: style.bg, color: style.text, border: `1px solid ${style.border}`,
      whiteSpace: 'nowrap', flexShrink: 0 }}>
      {duration}m max
    </span>
  );
}

// ── Duration Filter ──────────────────────────────────────────────
// Only shown when slots > 8. Filters slots by maxDuration >= selected.
function DurationFilter({ availableDurations, active, onChange }) {
  const durations = [null, ...availableDurations.sort((a, b) => a - b)];
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: c.textTertiary, fontWeight: 500, marginRight: 2 }}>Filter:</span>
        {durations.map(d => {
          const isActive = d === active;
          const style = d ? DUR_COLORS[d] : null;
          return (
            <button key={d ?? 'all'} onClick={() => onChange(d)}
              style={{ padding: '4px 11px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                border: isActive ? 'none' : `1px solid ${d ? style.border : c.border}`,
                background: isActive ? (d ? style.text : c.primary) : (d ? style.bg : c.surface),
                color: isActive ? 'white' : (d ? style.text : c.textSecondary),
                cursor: 'pointer', transition: 'all 0.15s' }}>
              {d ? `${d} min` : 'All'}
            </button>
          );
        })}
      </div>
      <p style={{ fontSize: 11, color: c.textTertiary, margin: '5px 0 0' }}>
        Showing slots where at least <strong style={{ fontWeight: 600 }}>{active ? `${active} min` : 'any duration'}</strong> can be booked
      </p>
    </div>
  );
}

// ── Slot List ─────────────────────────────────────────────────────
// Right panel — shows slots for selected day + duration filter + confirmation
function SlotList({ dayKey, viewerTz = 'Australia/Sydney', onConfirm }) {
  const [durFilter, setDurFilter] = useState(null);
  const [selSlot, setSelSlot] = useState(null);
  const [confirmStep, setConfirmStep] = useState(false);
  const [chosenDur, setChosenDur] = useState(null);

  const slots = SLOTS_BY_DAY[dayKey] || [];
  const SHOW_FILTER = slots.length > 8;

  const availableDurations = [...new Set(slots.map(s => s.maxDuration))];
  const filtered = durFilter ? slots.filter(s => s.maxDuration >= durFilter) : slots;

  // Day heading
  const dt = new Date(dayKey);
  const today = new Date();
  const isToday = dt.toDateString() === today.toDateString();
  const headingDate = dt.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });

  const handleSelectSlot = (slot) => {
    setSelSlot(slot);
    setConfirmStep(false);
    setChosenDur(null);
  };

  if (!dayKey) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100%', minHeight: 300, textAlign: 'center', padding: '40px 24px' }}>
      <div style={{ width: 48, height: 48, borderRadius: 13, margin: '0 auto 14px',
        background: c.surfaceSubtle, border: `1px solid ${c.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={c.textTertiary} strokeWidth={2}>
          <rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>
        </svg>
      </div>
      <p style={{ fontSize: 14, fontWeight: 600, color: c.textSecondary, margin: '0 0 5px' }}>Select a date</p>
      <p style={{ fontSize: 13, color: c.textTertiary, margin: 0 }}>Pick a day on the calendar to see available times</p>
    </div>
  );

  // Confirmation step
  if (confirmStep && selSlot) {
    const availDurs = [15, 30, 45, 60].filter(d => d <= selSlot.maxDuration);
    return (
      <div>
        <button onClick={() => { setConfirmStep(false); setChosenDur(null); }}
          style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: 'none',
            cursor: 'pointer', fontSize: 13, fontWeight: 500, color: c.primary, padding: '0 0 14px' }}>
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={c.primary} strokeWidth={2}><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          Back to slots
        </button>
        <div style={{ padding: '14px 16px', borderRadius: 10, background: c.primaryLight,
          border: `1px solid ${c.primaryBorder}`, marginBottom: 20 }}>
          <p style={{ fontSize: 13, fontWeight: 650, color: c.primary, margin: '0 0 2px' }}>
            {fmtTime(selSlot.start, viewerTz)}
          </p>
          <p style={{ fontSize: 12, color: c.primary, margin: 0, opacity: 0.8 }}>
            {isToday ? 'Today' : ''} {headingDate} · Up to {selSlot.maxDuration} min available
          </p>
        </div>
        <p style={{ fontSize: 12, fontWeight: 700, color: c.textTertiary, textTransform: 'uppercase',
          letterSpacing: '0.07em', margin: '0 0 12px' }}>How long do you need?</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
          {availDurs.map(d => {
            const style = DUR_COLORS[d];
            const isChosen = chosenDur === d;
            return (
              <button key={d} onClick={() => setChosenDur(d)}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
                  borderRadius: 10, border: isChosen ? 'none' : `1.5px solid ${c.border}`,
                  background: isChosen ? c.primary : c.surface,
                  cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s',
                  boxShadow: isChosen ? `0 2px 8px ${c.primaryGlow}` : 'none' }}>
                <div style={{ width: 18, height: 18, borderRadius: '50%',
                  background: isChosen ? 'rgba(255,255,255,0.25)' : c.surfaceSubtle,
                  border: `2px solid ${isChosen ? 'rgba(255,255,255,0.6)' : c.border}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {isChosen && <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'white' }} />}
                </div>
                <div>
                  <span style={{ fontSize: 14, fontWeight: 600, color: isChosen ? 'white' : c.text,
                    display: 'block' }}>{d} minutes</span>
                  <span style={{ fontSize: 12, color: isChosen ? 'rgba(255,255,255,0.7)' : c.textTertiary }}>
                    {fmtTime(selSlot.start, viewerTz)} – {(() => {
                      const end = new Date(selSlot.start);
                      end.setMinutes(end.getMinutes() + d);
                      return fmtTime(end.toISOString(), viewerTz);
                    })()}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
        <button disabled={!chosenDur} onClick={onConfirm}
          style={{ width: '100%', padding: '11px', borderRadius: 10, fontSize: 14, fontWeight: 650,
            background: chosenDur ? c.primary : c.border, color: 'white', border: 'none',
            cursor: chosenDur ? 'pointer' : 'not-allowed', transition: 'all 0.2s',
            boxShadow: chosenDur ? `0 2px 10px ${c.primaryGlow}` : 'none' }}>
          {chosenDur ? `Confirm ${chosenDur}-min consultation` : 'Select a duration'}
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* Day heading */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: c.text, margin: 0 }}>
            {isToday ? 'Today' : ''} {headingDate}
          </h3>
          {isToday && <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 5,
            background: c.primaryLight, color: c.primary, border: `1px solid ${c.primaryBorder}` }}>Today</span>}
        </div>
        <p style={{ fontSize: 12, color: c.textTertiary, margin: '3px 0 0' }}>
          {filtered.length} slot{filtered.length !== 1 ? 's' : ''} available
        </p>
      </div>

      {/* Duration filter — only shown when >8 slots */}
      {SHOW_FILTER && (
        <DurationFilter availableDurations={availableDurations} active={durFilter}
          onChange={d => { setDurFilter(d); setSelSlot(null); }} />
      )}

      {/* Slot grid */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {filtered.map((slot, i) => {
          const isSel = selSlot === slot;
          const durStyle = DUR_COLORS[slot.maxDuration] || DUR_COLORS[30];
          return (
            <button key={i} onClick={() => handleSelectSlot(slot)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
                borderRadius: 10, border: isSel ? 'none' : `1.5px solid ${c.border}`,
                background: isSel ? c.primary : c.surface,
                cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s',
                boxShadow: isSel ? `0 2px 8px ${c.primaryGlow}` : 'none' }}>
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: isSel ? 'white' : c.text }}>
                  {fmtTime(slot.start, viewerTz)}
                </span>
              </div>
              <span style={{ fontSize: 11, fontWeight: 650, padding: '2px 7px', borderRadius: 5,
                background: isSel ? 'rgba(255,255,255,0.2)' : durStyle.bg,
                color: isSel ? 'white' : durStyle.text,
                border: `1px solid ${isSel ? 'rgba(255,255,255,0.3)' : durStyle.border}`,
                whiteSpace: 'nowrap', flexShrink: 0 }}>
                {slot.maxDuration}m max
              </span>
            </button>
          );
        })}
        {filtered.length === 0 && durFilter && (
          <div style={{ padding: '24px 16px', textAlign: 'center' }}>
            <p style={{ fontSize: 13, color: c.textSecondary, margin: '0 0 8px' }}>
              No {durFilter}-min slots on this day
            </p>
            <button onClick={() => setDurFilter(null)}
              style={{ fontSize: 13, color: c.primary, background: 'none', border: 'none',
                cursor: 'pointer', fontWeight: 600 }}>
              Show all slots
            </button>
          </div>
        )}
      </div>

      {/* Confirm CTA */}
      {selSlot && (
        <div style={{ marginTop: 16, animation: 'slideUp 0.25s ease-out' }}>
          <button onClick={() => setConfirmStep(true)}
            style={{ width: '100%', padding: '11px', borderRadius: 10, fontSize: 14, fontWeight: 650,
              background: c.primary, color: 'white', border: 'none', cursor: 'pointer',
              boxShadow: `0 2px 10px ${c.primaryGlow}` }}>
            Continue — {fmtTime(selSlot.start, viewerTz)}
          </button>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN — ExpertAvailabilityCalendar
// Props: expertId, mode, viewerTimezone, onSlotSelect, daysAhead
// ══════════════════════════════════════════════════════════════════
export default function ExpertAvailabilityCalendar({
  viewerTimezone = 'Australia/Sydney',
  expertTimezone = 'Australia/Melbourne',
  demoState = 'has_slots',
}) {
  const [selectedDay, setSelectedDay] = useState(null);
  const [booked, setBooked] = useState(false);

  const tzLabel = viewerTimezone.split('/')[1]?.replace('_', ' ') || viewerTimezone;

  if (demoState === 'loading') return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
      {[1, 2].map(n => <div key={n} style={{ height: 320, borderRadius: 14, background: 'linear-gradient(90deg, #E0E4EB 25%, #EEF1F6 50%, #E0E4EB 75%)', backgroundSize: '400px 100%', animation: 'shimmer 1.4s ease-in-out infinite' }} />)}
    </div>
  );

  if (demoState === 'empty_nc' || demoState === 'empty_ns') return (
    <div style={{ padding: '40px 24px', textAlign: 'center', background: c.surface, borderRadius: 14, border: `1px solid ${c.border}` }}>
      <p style={{ fontSize: 14, fontWeight: 600, color: c.textSecondary, margin: '0 0 5px' }}>
        {demoState === 'empty_nc' ? 'Schedule not set up yet' : 'No availability in the next 30 days'}
      </p>
      <p style={{ fontSize: 13, color: c.textTertiary, margin: 0 }}>Check back soon</p>
    </div>
  );

  if (booked) return (
    <div style={{ padding: '48px 32px', textAlign: 'center', background: c.surface, borderRadius: 14, border: `1px solid ${c.border}` }}>
      <div style={{ width: 60, height: 60, borderRadius: '50%', margin: '0 auto 18px',
        background: 'linear-gradient(135deg, #059669 0%, #0891B2 100%)',
        display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2.5}><path d="M20 6L9 17l-5-5"/></svg>
      </div>
      <h3 style={{ fontSize: 20, fontWeight: 700, color: c.text, margin: '0 0 8px' }}>Consultation booked!</h3>
      <p style={{ fontSize: 14, color: c.textSecondary, margin: 0 }}>You'll receive a confirmation email shortly.</p>
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 16 }}>
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke={c.textTertiary} strokeWidth={2}><circle cx={12} cy={12} r={10}/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10A15.3 15.3 0 0112 2z"/></svg>
        <span style={{ fontSize: 12, color: c.textTertiary }}>
          Times in <strong style={{ fontWeight: 600, color: c.textSecondary }}>{tzLabel}</strong>
          {viewerTimezone !== expertTimezone && ` · Expert is in ${expertTimezone.split('/')[1]?.replace('_', ' ')}`}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 24, alignItems: 'start' }}>
        {/* Left: Month Calendar */}
        <div style={{ background: c.surface, borderRadius: 14, border: `1px solid ${c.border}`, padding: '16px' }}>
          <MonthCalendar selectedDay={selectedDay} onSelectDay={setSelectedDay} viewerTz={viewerTimezone} />
        </div>

        {/* Right: Slot list */}
        <div style={{ background: c.surface, borderRadius: 14, border: `1px solid ${c.border}`, padding: '16px', minHeight: 320 }}>
          <SlotList dayKey={selectedDay} viewerTz={viewerTimezone} onConfirm={() => setBooked(true)} />
        </div>
      </div>
    </div>
  );
}
