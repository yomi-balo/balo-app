import { useState, useEffect } from 'react';

/**
 * BAL-236 — ExpertAvailabilityCalendar design reference
 *
 * IMPLEMENTATION NOTE FOR CC:
 * Use shadcnspace Calendar 03 as the base component:
 *   npx shadcn@shadcn-space add calendar-03
 * This design reference defines the Balo-specific UX and states
 * to layer on top. Do NOT build the calendar grid from scratch.
 *
 * All colors must use CSS variables from globals.css (var(--primary),
 * var(--border), var(--muted), etc.) — never hardcode hex values.
 * The component must support dark mode.
 */

// ── Design tokens (matches globals.css CSS variables) ─────────────
// These are approximations for the prototype only.
// CC must replace with var(--*) Tailwind classes in the real implementation.
const c = {
  bg: '#E2E5EC',
  surface: '#FFFFFF',
  surfaceSubtle: '#F1F3F7',
  border: '#D1D5DB',        // var(--border)
  borderStrong: '#B5BAC4',  // slightly darker for slot rows
  divider: '#C8CBD4',
  text: '#111827',           // var(--foreground)
  textSecondary: '#4B5563',  // var(--muted-foreground)
  textTertiary: '#9CA3AF',
  primary: '#2563EB',        // var(--primary)
  primaryDark: '#1D4ED8',
  primaryLight: '#EEF4FF',
  primaryBorder: '#BFDBFE',
  primaryGlow: 'rgba(37,99,235,0.12)',
  success: '#059669',        // var(--success)
  successLight: '#ECFDF5',
};

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&display=swap');
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'DM Sans', -apple-system, sans-serif; -webkit-font-smoothing: antialiased; background: #E2E5EC; }

/* Two-panel layout: calendar wider, slots panel narrower */
.avail-grid {
  display: grid;
  grid-template-columns: 1fr 300px;
  gap: 1px;
  background: #C8CBD4;
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 2px 16px rgba(0,0,0,0.1);
}
.avail-panel { background: #fff; padding: 22px; }

/* Calendar day cells */
.cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 3px; }
.cell {
  height: 40px;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  border-radius: 9px; position: relative;
  transition: background .1s; user-select: none;
}
.cell.avail { cursor: pointer; }
.cell.avail:hover:not(.sel) { background: #EEF4FF; }
.cell.sel { background: #2563EB; }
.cell.tod:not(.sel) { background: #EEF4FF; }

/* Duration filter pills — high contrast, wrap freely */
.dp {
  padding: 5px 13px; border-radius: 20px;
  font-size: 12px; font-weight: 500;
  border: 1.5px solid #8B9099;
  background: #F1F3F7; cursor: pointer;
  color: #2D3748; transition: all .15s;
  white-space: nowrap; font-family: inherit;
}
.dp:hover { border-color: #2563EB; color: #2563EB; background: #EEF4FF; }
.dp.on { background: #2563EB; border-color: #2563EB; color: #fff; font-weight: 600; }

/* Slot rows — time LEFT, "up to Xm" RIGHT (space-between) */
.slot {
  display: flex; align-items: center; justify-content: space-between;
  width: 100%; padding: 9px 14px; border-radius: 9px;
  border: 1.5px solid #B5BAC4;
  background: #fff; cursor: pointer;
  transition: all .12s; font-family: inherit;
}
.slot:hover { border-color: #2563EB; background: #EEF4FF; }
.slot:hover .st, .slot:hover .sd { color: #1D4ED8; }
.slot.on { border-color: transparent; background: #2563EB; }
.slot.on .st, .slot.on .sd { color: #fff; }
.st { font-size: 14px; font-weight: 500; color: #111827; letter-spacing: -.01em; }
.sd { font-size: 12px; font-weight: 400; color: #9CA3AF; }

.cbtn {
  width: 100%; padding: 11px; border-radius: 10px;
  font-size: 14px; font-weight: 600;
  background: #2563EB; color: #fff; border: none;
  cursor: pointer; font-family: inherit; margin-top: 14px;
  transition: background .15s;
}
.cbtn:hover { background: #1D4ED8; }
.cbtn:disabled { background: #DDE2EA; color: #9CA3AF; cursor: not-allowed; }

.slist {
  display: flex; flex-direction: column; gap: 6px;
  max-height: 340px; overflow-y: auto;
  scrollbar-width: thin; scrollbar-color: #E0E4EB transparent;
}

/* Mobile: stack calendar above slots */
@media (max-width: 560px) {
  .avail-grid { grid-template-columns: 1fr; grid-template-rows: auto auto; }
  .slist { max-height: none; }
}
`;

// ── Mock data ─────────────────────────────────────────────────────
// In production: fetched from GET /api/experts/:expertId/availability
// Each slot has a maxDuration (minutes of contiguous free time from that start)
const DURATION_POOL = [15, 30, 30, 30, 60, 60, 45, 30, 60];
function generateMockSlots() {
  const byDay = {};
  const now = new Date();
  for (let d = 0; d < 28; d++) {
    const dt = new Date(now);
    dt.setDate(dt.getDate() + d + 1);
    if ([0, 6].includes(dt.getDay())) continue;
    if (Math.random() < 0.22) continue;
    const key = dt.toISOString().slice(0, 10);
    const hours = [8, 8.5, 9, 9.5, 10, 10.5, 11, 13, 13.5, 14, 14.5, 15, 15.5, 16]
      .filter(() => Math.random() > 0.4);
    const slots = hours.map(h => {
      const s = new Date(dt);
      s.setHours(Math.floor(h), h % 1 ? 30 : 0, 0, 0);
      return {
        start: s.toISOString(),
        // maxDuration: contiguous free minutes from this slot's start
        maxDuration: DURATION_POOL[Math.floor(Math.random() * DURATION_POOL.length)],
      };
    });
    if (slots.length) byDay[key] = slots;
  }
  return byDay;
}
const MOCK_SLOTS = generateMockSlots();

const fmtTime = iso => new Date(iso).toLocaleTimeString('en-AU', {
  timeZone: 'Australia/Sydney', hour: 'numeric', minute: '2-digit', hour12: true,
});
const fmtEndTime = (iso, minutes) => {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() + minutes);
  return fmtTime(d.toISOString());
};

// ══════════════════════════════════════════════════════════════════
// MONTH CALENDAR
// Left panel. In production: use shadcnspace Calendar 03 base.
// Dots mark days with availability. Disabled dates = past + no slots.
// ══════════════════════════════════════════════════════════════════
function MonthCalendar({ selectedDay, onSelectDay }) {
  const [monthOffset, setMonthOffset] = useState(0);
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const monthLabel = base.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });

  const firstDow = (base.getDay() + 6) % 7; // Mon=0
  const daysInMonth = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(0);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7) cells.push(0);

  const getKey = d => d ? new Date(base.getFullYear(), base.getMonth(), d).toISOString().slice(0, 10) : null;
  const isPast = d => {
    if (!d) return false;
    const t = new Date(); t.setHours(0, 0, 0, 0);
    return new Date(base.getFullYear(), base.getMonth(), d) < t;
  };
  const isToday = d => d ? new Date(base.getFullYear(), base.getMonth(), d).toDateString() === now.toDateString() : false;
  const hasSlots = d => !!(d && MOCK_SLOTS[getKey(d)]);

  return (
    <div>
      {/* Month navigation */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <button onClick={() => setMonthOffset(o => o - 1)} disabled={monthOffset <= 0}
          style={{ width: 32, height: 32, borderRadius: 8, border: '1.5px solid #C2C7D0', background: '#fff',
            cursor: monthOffset <= 0 ? 'not-allowed' : 'pointer', opacity: monthOffset <= 0 ? 0.3 : 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#374151" strokeWidth={2}><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#111827', letterSpacing: '-.01em' }}>{monthLabel}</span>
        <button onClick={() => setMonthOffset(o => o + 1)}
          style={{ width: 32, height: 32, borderRadius: 8, border: '1.5px solid #C2C7D0', background: '#fff',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#374151" strokeWidth={2}><path d="M9 18l6-6-6-6"/></svg>
        </button>
      </div>

      {/* Day-of-week headers */}
      <div className="cal-grid" style={{ marginBottom: 8 }}>
        {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d, i) => (
          <div key={i} style={{ textAlign: 'center', fontSize: 11, fontWeight: 500,
            color: '#9CA3AF', paddingBottom: 6, letterSpacing: '.03em' }}>{d}</div>
        ))}
      </div>

      {/* Day cells */}
      <div className="cal-grid">
        {cells.map((d, i) => {
          const key = getKey(d);
          const isSel = key === selectedDay;
          const today = isToday(d);
          const past = isPast(d);
          const avail = hasSlots(d);
          const wknd = i % 7 >= 5;
          const cls = ['cell', avail && !past ? 'avail' : '', isSel ? 'sel' : '', today && !isSel ? 'tod' : ''].join(' ');
          return (
            <div key={i} className={cls} onClick={avail && !past ? () => onSelectDay(key) : undefined}>
              {d ? (
                <span style={{ fontSize: 13, lineHeight: 1,
                  fontWeight: isSel || today ? 600 : 400,
                  color: isSel ? '#fff' : today ? '#2563EB' : past || wknd ? '#C5C9D0' : '#111827' }}>
                  {d}
                </span>
              ) : null}
              {avail && !past && !isSel ? (
                <div style={{ width: 3, height: 3, borderRadius: '50%', background: '#2563EB', position: 'absolute', bottom: 4 }} />
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16,
        paddingTop: 14, borderTop: '1px solid #EAECF0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{ width: 3, height: 3, borderRadius: '50%', background: '#2563EB' }} />
          <span style={{ fontSize: 10, color: '#9CA3AF' }}>Available</span>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// SLOTS PANEL
// Right panel. Filter always visible. Time LEFT, "up to Xm" RIGHT.
// Duration filter auto-resets + warns when switching to a day with
// no matching slots (instead of showing a blank list).
// Confirmation step asks for duration AFTER slot selection.
// ══════════════════════════════════════════════════════════════════
function SlotsPanel({ dayKey, mode = 'selectable' }) {
  const [durFilter, setDurFilter] = useState(null);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [confirmStep, setConfirmStep] = useState(false);
  const [chosenDuration, setChosenDuration] = useState(null);
  const [booked, setBooked] = useState(false);

  // Reset state on day change + auto-clear stale filter
  useEffect(() => {
    setSelectedSlot(null);
    setConfirmStep(false);
    setChosenDuration(null);
    // Auto-reset filter if it would produce empty results on the new day
    if (durFilter && dayKey) {
      const slots = MOCK_SLOTS[dayKey] || [];
      if (!slots.some(s => s.maxDuration >= durFilter)) {
        setDurFilter(null);
      }
    }
  }, [dayKey]);

  // ── No day selected ───────────────────────────────────────────
  if (!dayKey) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', minHeight: 280, textAlign: 'center', padding: 24 }}>
      <div style={{ width: 44, height: 44, borderRadius: '50%', background: '#F1F3F7',
        border: '1.5px solid #D8DCE5', display: 'flex', alignItems: 'center',
        justifyContent: 'center', margin: '0 auto 14px' }}>
        <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" strokeWidth={1.5}>
          <rect x="3" y="4" width="18" height="18" rx="2"/>
          <path d="M16 2v4M8 2v4M3 10h18"/>
        </svg>
      </div>
      <p style={{ fontSize: 14, fontWeight: 500, color: '#6B7280', margin: '0 0 4px' }}>Select a date</p>
      <p style={{ fontSize: 13, color: '#9CA3AF', margin: 0, lineHeight: 1.5 }}>
        Tap a highlighted day<br/>to see available times
      </p>
    </div>
  );

  // ── Booked confirmation ───────────────────────────────────────
  if (booked) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', minHeight: 280, textAlign: 'center' }}>
      <div style={{ width: 52, height: 52, borderRadius: '50%', background: '#059669',
        display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
        <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2.5}>
          <path d="M20 6L9 17l-5-5"/>
        </svg>
      </div>
      <p style={{ fontSize: 16, fontWeight: 600, color: '#111827', margin: '0 0 5px' }}>Booked!</p>
      <p style={{ fontSize: 13, color: '#6B7280', margin: 0 }}>Confirmation email on its way</p>
    </div>
  );

  const allSlots = MOCK_SLOTS[dayKey] || [];
  const uniqueDurations = [...new Set(allSlots.map(s => s.maxDuration))].sort((a, b) => a - b);
  const filtered = durFilter ? allSlots.filter(s => s.maxDuration >= durFilter) : allSlots;
  const noMatch = durFilter && !filtered.length;
  // Fallback: if filter produces no results, show all slots with a warning
  const showing = noMatch ? allSlots : filtered;

  const dt = new Date(dayKey);
  const isToday = dt.toDateString() === new Date().toDateString();
  const headDate = dt.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });

  // ── Duration confirmation step ────────────────────────────────
  // Triggered after slot selection in selectable mode.
  // User picks exact duration (up to slot's maxDuration) before confirming.
  if (confirmStep && selectedSlot) {
    const availableDurations = [15, 30, 45, 60].filter(d => d <= selectedSlot.maxDuration);
    return (
      <div>
        <button onClick={() => { setConfirmStep(false); setChosenDuration(null); }}
          style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: 'none',
            color: '#2563EB', fontSize: 13, fontWeight: 500, padding: '0 0 18px', cursor: 'pointer',
            fontFamily: 'inherit' }}>
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="#2563EB" strokeWidth={2}>
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
          Back
        </button>

        {/* Selected time recap */}
        <div style={{ padding: '12px 16px', borderRadius: 10, background: '#EEF4FF',
          border: '1.5px solid #BFDBFE', marginBottom: 20 }}>
          <span style={{ fontSize: 16, fontWeight: 600, color: '#1D4ED8' }}>
            {fmtTime(selectedSlot.start)}
          </span>
          <span style={{ fontSize: 13, color: '#6B7280', marginLeft: 8 }}>
            {isToday ? 'Today' : headDate}
          </span>
        </div>

        <p style={{ fontSize: 11, fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase',
          letterSpacing: '.07em', marginBottom: 10 }}>How long do you need?</p>

        {/* Duration options */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 20 }}>
          {availableDurations.map(d => {
            const isChosen = chosenDuration === d;
            return (
              <button key={d} onClick={() => setChosenDuration(d)}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px',
                  borderRadius: 10, border: `1.5px solid ${isChosen ? '#2563EB' : '#C2C7D0'}`,
                  background: isChosen ? '#EEF4FF' : '#fff', cursor: 'pointer',
                  textAlign: 'left', fontFamily: 'inherit', transition: 'all .15s' }}>
                <div style={{ width: 18, height: 18, borderRadius: '50%',
                  border: `2px solid ${isChosen ? '#2563EB' : '#C2C7D0'}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {isChosen && <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#2563EB' }} />}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: isChosen ? 600 : 500,
                    color: isChosen ? '#1D4ED8' : '#111827' }}>{d} minutes</div>
                  <div style={{ fontSize: 12, color: '#9CA3AF', marginTop: 1 }}>
                    {fmtTime(selectedSlot.start)} – {fmtEndTime(selectedSlot.start, d)}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <button className="cbtn" disabled={!chosenDuration} onClick={() => setBooked(true)}>
          {chosenDuration ? `Confirm ${chosenDuration}-min consultation` : 'Select a duration above'}
        </button>
      </div>
    );
  }

  // ── Main slot list ────────────────────────────────────────────
  return (
    <div>
      {/* Day heading */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: '#111827', letterSpacing: '-.01em' }}>
            {isToday ? 'Today' : headDate}
          </span>
          {isToday && (
            <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 5,
              background: '#EEF4FF', color: '#2563EB', border: '1px solid #BFDBFE' }}>Today</span>
          )}
        </div>
        <p style={{ fontSize: 12, color: '#9CA3AF', margin: '3px 0 0' }}>
          {showing.length} time{showing.length !== 1 ? 's' : ''} available
          {durFilter && !noMatch ? ` for ${durFilter}+ min` : ''}
        </p>
      </div>

      {/* Duration filter — ALWAYS VISIBLE, pills can wrap to 2 lines */}
      <div style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 11, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase',
          letterSpacing: '.07em', marginBottom: 8 }}>Duration</p>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {[null, ...uniqueDurations].map(d => (
            <button key={d ?? 'all'} className={`dp${durFilter === d ? ' on' : ''}`}
              onClick={() => { setDurFilter(d); setSelectedSlot(null); }}>
              {d ? `${d} min` : 'Any'}
            </button>
          ))}
        </div>
        {/* Auto-reset warning when filter has no results on this day */}
        {noMatch && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8,
            fontSize: 12, color: '#D97706' }}>
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="#D97706" strokeWidth={2}>
              <circle cx={12} cy={12} r={10}/>
              <path d="M12 8v4M12 16h.01"/>
            </svg>
            No {durFilter}-min slots today.
            <button onClick={() => setDurFilter(null)}
              style={{ background: 'none', border: 'none', color: '#2563EB', fontSize: 12,
                fontWeight: 600, cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>
              Show all →
            </button>
          </div>
        )}
      </div>

      {/* Slot list — time LEFT, "up to Xm" RIGHT */}
      <div className="slist">
        {showing.map((slot, i) => {
          const isSel = selectedSlot === slot;
          return (
            <button key={i} className={`slot${isSel ? ' on' : ''}`} onClick={() => setSelectedSlot(slot)}>
              <span className="st">{fmtTime(slot.start)}</span>
              {/* Only show maxDuration label when "Any" filter — redundant when filtered */}
              {(!durFilter || noMatch) && (
                <span className="sd">up to {slot.maxDuration}m</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Continue CTA — only in selectable mode */}
      {selectedSlot && mode === 'selectable' && (
        <button className="cbtn" onClick={() => setConfirmStep(true)}>
          Continue with {fmtTime(selectedSlot.start)} →
        </button>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN EXPORT — ExpertAvailabilityCalendar
//
// Props:
//   expertId        — fetches from GET /api/experts/:id/availability
//   mode            — 'preview' (read-only) | 'selectable' (booking flow)
//   viewerTimezone  — IANA string, defaults to browser timezone
//   onSlotSelect    — (selectable mode) callback with { start, end, duration }
//   daysAhead       — 14 for preview, 60 for selectable
//
// Component location in codebase:
//   packages/web/src/components/availability/ExpertAvailabilityCalendar.tsx
// ══════════════════════════════════════════════════════════════════
export default function ExpertAvailabilityCalendar({ mode = 'selectable' }) {
  const [selectedDay, setSelectedDay] = useState(null);

  return (
    <div style={{ fontFamily: "'DM Sans', -apple-system, sans-serif" }}>
      <style>{CSS}</style>

      {/* Timezone label */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 12, padding: '0 2px' }}>
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" strokeWidth={1.5}>
          <circle cx={12} cy={12} r={10}/>
          <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10A15.3 15.3 0 0112 2z"/>
        </svg>
        <span style={{ fontSize: 12, color: '#9CA3AF' }}>Sydney time</span>
      </div>

      {/* Two-panel layout */}
      <div className="avail-grid">
        {/* Left: month calendar (wider) */}
        <div className="avail-panel">
          <MonthCalendar selectedDay={selectedDay} onSelectDay={setSelectedDay} />
        </div>
        {/* Right: slot list (narrower, 300px) */}
        <div className="avail-panel" style={{ minWidth: 0 }}>
          <SlotsPanel dayKey={selectedDay} mode={mode} />
        </div>
      </div>

      {/* Demo mode switcher */}
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
        <div style={{ display: 'inline-flex', gap: 4, padding: 4, borderRadius: 10,
          background: '#F1F3F7', border: '1px solid #E0E4EB' }}>
          {['preview', 'selectable'].map(m => (
            <button key={m} style={{ padding: '5px 14px', borderRadius: 7, fontSize: 12,
              fontWeight: 550, border: 'none', cursor: 'pointer',
              background: mode === m ? '#fff' : 'transparent',
              color: mode === m ? '#111827' : '#9CA3AF',
              boxShadow: mode === m ? '0 1px 3px rgba(0,0,0,0.06)' : 'none',
              fontFamily: 'inherit' }}>{m}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
