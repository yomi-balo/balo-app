import { useEffect, useState } from 'react';

// BAL-591 — the public profile's booking card when the expert is paused
// (`available_for_work = false`). Mirrors the shipped booking-card.tsx: rate header →
// availability row → primary CTA → "or" → Start a project → message link → trust card.
//
// Paused rule: never show a disabled "Book a consultation". The card stops offering this
// expert and offers the two honest alternatives instead, so the visitor leaves with a next step.
// The hatched block is the same "paused" motif used on the expert's own Schedule tab.

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
  violet: '#7C3AED',
  success: '#059669',
  pink: '#EC4899',
  slate: '#475569',
  slateLight: '#F1F5F9',
  slateBorder: '#CBD5E1',
  navy: '#16153F',
  hatchTone: 'rgba(100,116,139,0.11)',
};

const FONT = "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const GRADIENT = 'linear-gradient(90deg, #2563EB 0%, #7C3AED 100%)';
const hatch = (tone = c.hatchTone) =>
  `repeating-linear-gradient(135deg, ${tone} 0 6px, transparent 6px 12px)`;

const GLOBAL_CSS = `
.bf:focus-visible { outline: 2px solid ${c.violet}; outline-offset: 2px; }
@keyframes pulseDot { 0%,100% { opacity: 1; } 50% { opacity: .45; } }
@keyframes noteIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

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
  video: (p) => (
    <Svg {...p}>
      <path d="M23 7l-7 5 7 5V7z" />
      <rect x="1" y="5" width="15" height="14" rx="2" />
    </Svg>
  ),
  briefcase: (p) => (
    <Svg {...p}>
      <rect x="2" y="7" width="20" height="14" rx="2" />
      <path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16" />
    </Svg>
  ),
  message: (p) => (
    <Svg {...p}>
      <path d="M21 11.5a8.4 8.4 0 01-9 8.4 8.5 8.5 0 01-3.8-.9L3 21l1.9-5.2A8.4 8.4 0 1121 11.5z" />
    </Svg>
  ),
  chevR: (p) => (
    <Svg {...p}>
      <path d="M9 18l6-6-6-6" />
    </Svg>
  ),
  shield: (p) => (
    <Svg {...p}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </Svg>
  ),
  heart: (p) => (
    <Svg {...p}>
      <path d="M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 00-7.8 7.8L12 21.2l8.8-8.8a5.5 5.5 0 000-7.8z" />
    </Svg>
  ),
  search: (p) => (
    <Svg {...p}>
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </Svg>
  ),
  pause: (p) => (
    <Svg {...p}>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </Svg>
  ),
};

const EXPERT = {
  name: 'Priya Sharma',
  firstName: 'Priya',
  headline: 'Salesforce Solution Architect',
  vertical: 'Salesforce',
  location: 'Melbourne',
  rate: 4.2,
};

// ── Booking card ────────────────────────────────────────────────
function RateHeader() {
  return (
    <div
      style={{
        padding: '24px 24px 20px',
        borderBottom: `1px solid ${c.borderSoft}`,
        background: 'linear-gradient(135deg, rgba(37,99,235,.05), rgba(124,58,237,.05))',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span
          style={{
            fontSize: 32,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          A${EXPERT.rate.toFixed(2)}
        </span>
        <span style={{ fontSize: 15, fontWeight: 600, color: c.text3 }}>/ min</span>
      </div>
      <p style={{ margin: '6px 0 0', fontSize: 13, color: c.text2 }}>
        Pay only for the minutes you use · incl. service fee
      </p>
    </div>
  );
}

function OrDivider() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '16px 0' }}>
      <span style={{ flex: 1, height: 1, background: c.borderSoft }} />
      <span style={{ fontSize: 12, fontWeight: 500, color: c.text3 }}>or</span>
      <span style={{ flex: 1, height: 1, background: c.borderSoft }} />
    </div>
  );
}

function SecondaryRow({ icon, title, sub, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="bf"
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: 14,
        borderRadius: 11,
        border: `1px solid ${c.border}`,
        background: c.surface,
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: FONT,
      }}
    >
      <span
        style={{
          width: 38,
          height: 38,
          borderRadius: 10,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(124,58,237,.1)',
          border: '1px solid rgba(124,58,237,.25)',
        }}
      >
        {icon}
      </span>
      <span style={{ flex: 1 }}>
        <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: c.text }}>
          {title}
        </span>
        <span
          style={{ display: 'block', fontSize: 12, color: c.text3, marginTop: 1, lineHeight: 1.4 }}
        >
          {sub}
        </span>
      </span>
      <I.chevR size={16} color={c.text3} />
    </button>
  );
}

function PrimaryCta({ icon, children, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="bf"
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: '14px 16px',
        borderRadius: 11,
        border: 'none',
        background: GRADIENT,
        color: '#fff',
        fontSize: 15,
        fontWeight: 600,
        cursor: 'pointer',
        boxShadow: '0 2px 8px rgba(37,99,235,.2)',
        fontFamily: FONT,
      }}
    >
      {icon}
      {children}
    </button>
  );
}

function MessageLink({ children, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="bf"
      style={{
        width: '100%',
        marginTop: 12,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: '10px 0',
        borderRadius: 10,
        border: 'none',
        background: 'none',
        color: c.text2,
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: FONT,
      }}
    >
      <I.message size={16} color={c.text2} />
      {children}
    </button>
  );
}

function BookingCard({ paused, onAction }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div
        style={{
          background: c.surface,
          borderRadius: 16,
          border: `1px solid ${c.border}`,
          overflow: 'hidden',
          boxShadow: '0 12px 40px rgba(27,26,68,.12)',
        }}
      >
        <RateHeader />
        <div style={{ padding: '20px 24px 24px' }}>
          {/* Availability row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            {paused ? (
              <>
                <span
                  style={{ width: 8, height: 8, borderRadius: '50%', background: c.slateBorder }}
                />
                <span style={{ fontSize: 13, fontWeight: 500, color: c.text2 }}>
                  Not taking on new work right now
                </span>
              </>
            ) : (
              <>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: c.success,
                    animation: 'pulseDot 2s ease-in-out infinite',
                  }}
                />
                <span style={{ fontSize: 13, fontWeight: 600, color: c.text }}>
                  Available for new work
                </span>
              </>
            )}
          </div>

          {paused ? (
            <>
              <div
                style={{
                  display: 'flex',
                  gap: 11,
                  alignItems: 'flex-start',
                  padding: '13px 14px',
                  marginBottom: 14,
                  borderRadius: 11,
                  border: `1px solid ${c.slateBorder}`,
                  background: `${hatch()}, ${c.slateLight}`,
                }}
              >
                <span
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 8,
                    flexShrink: 0,
                    background: '#E2E8F0',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <I.pause size={13} color={c.slate} />
                </span>
                <div>
                  <p
                    style={{
                      margin: 0,
                      fontSize: 13.5,
                      fontWeight: 600,
                      color: c.text,
                      lineHeight: 1.4,
                    }}
                  >
                    {EXPERT.firstName} isn&apos;t taking on new work right now.
                  </p>
                  <p style={{ margin: '3px 0 0', fontSize: 12.5, color: c.text2, lineHeight: 1.5 }}>
                    We can introduce you to someone with similar {EXPERT.vertical} experience.
                  </p>
                </div>
              </div>

              <PrimaryCta
                icon={<I.search size={16} color="#fff" />}
                onClick={() => onAction('similar')}
              >
                Find a similar expert
              </PrimaryCta>
              <OrDivider />
              <SecondaryRow
                icon={<I.briefcase size={16} color={c.violet} />}
                title="Get matched for a project"
                sub="Our team introduces a matched expert, usually within a day."
                onClick={() => onAction('match')}
              />
              <MessageLink onClick={() => onAction('message')}>
                Send {EXPERT.firstName} a message
              </MessageLink>
            </>
          ) : (
            <>
              <PrimaryCta
                icon={<I.video size={16} color="#fff" />}
                onClick={() => onAction('book')}
              >
                Book a consultation
              </PrimaryCta>
              <OrDivider />
              <SecondaryRow
                icon={<I.briefcase size={16} color={c.violet} />}
                title="Start a project"
                sub="Get a scoped proposal for larger work"
                onClick={() => onAction('project')}
              />
              <MessageLink onClick={() => onAction('message')}>Send a message first</MessageLink>
            </>
          )}
        </div>
      </div>

      {/* Trust card — unchanged in both states */}
      <div
        style={{
          background: c.surface,
          borderRadius: 14,
          border: `1px solid ${c.border}`,
          padding: '14px 20px',
        }}
      >
        {[
          {
            icon: <I.shield size={16} color={c.success} />,
            text: 'Identity & certifications verified by Balo',
          },
          {
            icon: <I.heart size={16} color={c.pink} />,
            text: 'Money-back if your session falls short',
          },
        ].map((row, i) => (
          <div
            key={row.text}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: i === 0 ? '0 0 12px' : '12px 0 0',
              borderBottom: i === 0 ? `1px solid ${c.borderSoft}` : 'none',
            }}
          >
            {row.icon}
            <span style={{ fontSize: 13, color: c.text2 }}>{row.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Page shell (simplified profile) ─────────────────────────────
function Hero({ mobile }) {
  return (
    <div style={{ background: c.navy, color: '#fff' }}>
      <div
        style={{
          maxWidth: 1080,
          margin: '0 auto',
          padding: mobile ? '28px 20px' : '40px 32px 56px',
          display: 'flex',
          gap: 18,
          alignItems: 'center',
        }}
      >
        <div
          aria-hidden="true"
          style={{
            width: mobile ? 64 : 84,
            height: mobile ? 64 : 84,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, #3B82F6, #8B5CF6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 700,
            fontSize: mobile ? 22 : 28,
            flexShrink: 0,
          }}
        >
          PS
        </div>
        <div>
          <h1
            style={{
              margin: 0,
              fontSize: mobile ? 22 : 28,
              fontWeight: 700,
              letterSpacing: '-0.01em',
            }}
          >
            {EXPERT.name}
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 15, color: 'rgba(255,255,255,.75)' }}>
            {EXPERT.headline}
          </p>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'rgba(255,255,255,.55)' }}>
            {EXPERT.location}
          </p>
        </div>
      </div>
    </div>
  );
}

function About() {
  return (
    <section>
      <h2 style={{ margin: '0 0 10px', fontSize: 18, fontWeight: 700, color: c.text }}>About</h2>
      <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.7, color: c.text2, maxWidth: 620 }}>
        I design Salesforce orgs that stay maintainable as teams grow. Most of my work is Sales and
        Service Cloud architecture, Flow rebuilds of legacy automation, and getting messy data
        models back under control before a big rollout.
      </p>
      <p
        style={{
          margin: '12px 0 0',
          fontSize: 14.5,
          lineHeight: 1.7,
          color: c.text2,
          maxWidth: 620,
        }}
      >
        Clients usually bring me in for a scoping call, then a short project to fix the root cause
        rather than the symptom.
      </p>
    </section>
  );
}

const ACTION_NOTES = {
  similar:
    "Find a similar expert → expert search, pre-filtered to this expert's vertical and top expertise, showing only available experts.",
  match:
    'Get matched for a project → opens the project panel already on Match (no Direct card, no unavailable notice to click through).',
  message: 'Send a message → existing messaging flow, unchanged.',
  book: 'Book a consultation → existing BAL-400 booking flow.',
  project: 'Start a project → existing BAL-588 panel, defaulting to Direct.',
};

const NOTES = [
  'Paused never renders a disabled "Book a consultation". The primary slot is reused for "Find a similar expert", keeping the gradient (marketing-surface CTA rule).',
  'Notice copy names the expert by first name and the expert\'s vertical ("similar Salesforce experience"); derive the vertical from the profile, never hard-code it.',
  '"Get matched for a project" opens the panel with routing pre-set to Match. Needs a small `initialRouting` prop on the BAL-588 panel; the server check still guards Direct.',
  'Messaging stays available while paused, so existing clients can still reach the expert. Flagged for Yomi to confirm.',
  'CTA impressions: the paused card fires `profile_cta_impression` with cta values `find_similar`, `match_project` and `message` (new enum values), plus `expert_profile_booking_unavailable_shown { expert_id }` once per view.',
  "Mobile: the card keeps its `order-first` position, so a paused expert's alternatives are the first thing a phone visitor sees.",
  'Rate header and trust card are unchanged in both states.',
];

// ══════════════════════════════════════════════════════════════════
export default function ExpertProfilePaused() {
  const [paused, setPaused] = useState(true);
  const [mobile, setMobile] = useState(false);
  const [note, setNote] = useState(null);

  useEffect(() => {
    if (!note) return undefined;
    const t = setTimeout(() => setNote(null), 5000);
    return () => clearTimeout(t);
  }, [note]);

  const seg = (options, value, onChange, label) => (
    <div
      role="tablist"
      aria-label={label}
      style={{
        display: 'inline-flex',
        gap: 4,
        padding: 4,
        borderRadius: 10,
        background: c.subtle,
        border: `1px solid ${c.borderSoft}`,
      }}
    >
      {options.map(([key, text]) => (
        <button
          key={String(key)}
          type="button"
          role="tab"
          aria-selected={value === key}
          onClick={() => onChange(key)}
          className="bf"
          style={{
            padding: '6px 14px',
            borderRadius: 7,
            border: 'none',
            cursor: 'pointer',
            fontSize: 12.5,
            fontWeight: 600,
            fontFamily: FONT,
            background: value === key ? c.surface : 'transparent',
            color: value === key ? c.text : c.text3,
            boxShadow: value === key ? '0 1px 3px rgba(0,0,0,.06)' : 'none',
          }}
        >
          {text}
        </button>
      ))}
    </div>
  );

  return (
    <div
      style={{
        minHeight: '100vh',
        background: c.bg,
        fontFamily: FONT,
        color: c.text,
        paddingBottom: 100,
      }}
    >
      <style>{GLOBAL_CSS}</style>
      <link
        href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap"
        rel="stylesheet"
      />

      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          gap: 12,
          flexWrap: 'wrap',
          padding: '24px 16px',
        }}
      >
        {seg(
          [
            [false, 'Available'],
            [true, 'Paused'],
          ],
          paused,
          setPaused,
          'Expert state'
        )}
        {seg(
          [
            [false, 'Desktop'],
            [true, 'Mobile'],
          ],
          mobile,
          setMobile,
          'Viewport'
        )}
      </div>

      <div
        style={{
          maxWidth: mobile ? 390 : 1080,
          margin: '0 auto',
          border: mobile ? `1px solid ${c.border}` : 'none',
          borderRadius: mobile ? 24 : 0,
          overflow: 'hidden',
          background: c.bg,
        }}
      >
        <Hero mobile={mobile} />
        <div
          style={{
            maxWidth: 1080,
            margin: '0 auto',
            padding: mobile ? '20px 16px 32px' : '0 32px 48px',
            display: 'grid',
            gridTemplateColumns: mobile ? '1fr' : 'minmax(0, 1fr) 360px',
            gap: mobile ? 24 : 40,
            alignItems: 'start',
          }}
        >
          <div style={{ order: mobile ? 2 : 1, paddingTop: mobile ? 0 : 36 }}>
            <About />
          </div>
          <div style={{ order: mobile ? 1 : 2, marginTop: mobile ? 0 : -40 }}>
            <BookingCard
              paused={paused}
              onAction={(a) => setNote({ key: Date.now(), text: ACTION_NOTES[a] })}
            />
          </div>
        </div>
      </div>

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
        <h2 style={{ margin: '0 0 10px', fontSize: 13.5, fontWeight: 600 }}>
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

      {note && (
        <div
          key={note.key}
          role="status"
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            maxWidth: 'min(560px, calc(100vw - 32px))',
            padding: '11px 16px',
            borderRadius: 11,
            background: c.text,
            color: '#fff',
            fontSize: 13,
            lineHeight: 1.5,
            boxShadow: '0 10px 30px rgba(17,24,39,.25)',
            animation: 'noteIn .2s ease-out',
            zIndex: 50,
          }}
        >
          {note.text}
        </div>
      )}
    </div>
  );
}
