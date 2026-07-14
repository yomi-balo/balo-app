import React, { useState, useRef, useEffect, useCallback } from 'react';

// ─────────────────────────────────────────────────────────────────────
// Balo — Payout assurance notice (proposal builder, Quote Summary sidebar)
// Design reference for: Balo fee tickets (expert disclosure surface)
//
// PLACEMENT
//   1. PRIMARY — composer Quote Summary sidebar, fused to the Total block.
//      Persistent across all four composer tabs.
//   2. REUSE  — expert's submitted-proposal read view, same component
//      beneath the total. No input-level repeats (rate / milestone fields).
//
// PRINCIPLE — benefit, not disclaimer. The pill leads with "100% yours";
// the popover discloses that a margin exists and that its percentage is
// not shown. The percentage never renders anywhere expert-facing.
// ─────────────────────────────────────────────────────────────────────

const c = {
  bg: '#F8FAFB',
  surface: '#FFFFFF',
  border: '#E0E4EB',
  ink: '#0F1729',
  sub: '#5B6472',
  faint: '#8B93A1',
  accent: '#2563EB',
  accentB: '#7C3AED',
  accentSoft: '#EFF4FF',
  green: '#0E9F6E',
  greenSoft: '#ECFBF4',
  heroA: '#0F1729',
  heroB: '#1E293B',
};

// ── Lucide-style inline icons ────────────────────────────────────────
const Ic = ({ children, size = 16, color = 'currentColor', sw = 2, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={sw}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={style}
    aria-hidden="true"
  >
    {children}
  </svg>
);
const I = {
  shieldCheck: (p) => (
    <Ic {...p}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </Ic>
  ),
  info: (p) => (
    <Ic {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </Ic>
  ),
  x: (p) => (
    <Ic {...p}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Ic>
  ),
  wallet: (p) => (
    <Ic {...p}>
      <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
      <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
    </Ic>
  ),
  trendUp: (p) => (
    <Ic {...p}>
      <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
      <polyline points="16 7 22 7 22 13" />
    </Ic>
  ),
  clock: (p) => (
    <Ic {...p}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </Ic>
  ),
  layers: (p) => (
    <Ic {...p}>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </Ic>
  ),
  calendar: (p) => (
    <Ic {...p}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </Ic>
  ),
  receipt: (p) => (
    <Ic {...p}>
      <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
      <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
    </Ic>
  ),
  user: (p) => (
    <Ic {...p}>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </Ic>
  ),
};

const keyframes = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&display=swap');
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
@keyframes popIn { from { opacity: 0; transform: translateY(6px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
}
`;
const slideUp = (d = 0) => ({ animation: `slideUp 0.4s ease-out ${d}s both` });

const fmt = (cents) =>
  '$' +
  (cents / 100).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

// ── Shared bits ──────────────────────────────────────────────────────
const SectionLabel = ({ children, style }) => (
  <div
    style={{
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      color: c.faint,
      ...style,
    }}
  >
    {children}
  </div>
);

const MetaRow = ({ icon, label, value }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '9px 0',
      borderBottom: `1px solid ${c.border}`,
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: c.sub, fontSize: 13 }}>
      {icon}
      <span>{label}</span>
    </div>
    <div style={{ fontSize: 13, fontWeight: 600, color: c.ink }}>{value}</div>
  </div>
);

// ── THE COMPONENT — PayoutAssuranceNote ──────────────────────────────
// Pill fused to the total + one supporting line + "How pricing works"
// popover. `pricingMethod` only changes one popover row (T&M rate note).
function PayoutAssuranceNote({ pricingMethod }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const closeBtnRef = useRef(null);
  const triggerRef = useRef(null);

  const onDocClick = useCallback((e) => {
    if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
  }, []);
  useEffect(() => {
    if (!open) return;
    document.addEventListener('mousedown', onDocClick);
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    closeBtnRef.current?.focus();
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onDocClick]);

  const rows = [
    {
      icon: <I.wallet size={15} color={c.green} />,
      title: 'Your quote is yours',
      body: 'The amount you set here is exactly what you\u2019re paid \u2014 no deductions.',
    },
    {
      icon: <I.trendUp size={15} color={c.accent} />,
      title: 'Balo adds a margin',
      body: 'We add a service margin on top of your quote. That combined figure is the only price your client sees.',
    },
    ...(pricingMethod === 'tm'
      ? [
          {
            icon: <I.clock size={15} color={c.accentB} />,
            title: 'Rates too',
            body: 'On time & materials work, the margin also applies to your hourly rate and deposit.',
          },
        ]
      : []),
  ];

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 10 }}>
        <I.shieldCheck size={15} color={c.green} style={{ flexShrink: 0, marginTop: 1 }} />
        <div style={{ fontSize: 12.5, lineHeight: 1.5, color: c.sub }}>
          You receive this full amount. Balo adds a service margin to the price your client sees.{' '}
          <button
            ref={triggerRef}
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              font: 'inherit',
              fontWeight: 600,
              color: c.accent,
              textDecoration: 'underline',
              textUnderlineOffset: 2,
              borderRadius: 3,
            }}
          >
            How pricing works
          </button>
        </div>
      </div>

      {open && (
        <div
          role="dialog"
          aria-label="How pricing works"
          style={{
            position: 'absolute',
            zIndex: 30,
            left: 0,
            right: 0,
            top: 'calc(100% + 8px)',
            background: c.surface,
            border: `1px solid ${c.border}`,
            borderRadius: 14,
            boxShadow: '0 12px 32px rgba(15,23,41,0.14), 0 2px 8px rgba(15,23,41,0.06)',
            padding: 16,
            animation: 'popIn 0.18s ease-out both',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 12,
            }}
          >
            <div style={{ fontSize: 13.5, fontWeight: 700, color: c.ink }}>How pricing works</div>
            <button
              ref={closeBtnRef}
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
              aria-label="Close"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 4,
                borderRadius: 6,
                color: c.faint,
                display: 'flex',
              }}
            >
              <I.x size={14} />
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {rows.map((r) => (
              <div key={r.title} style={{ display: 'flex', gap: 10 }}>
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 8,
                    background: c.bg,
                    border: `1px solid ${c.border}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  {r.icon}
                </div>
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: c.ink, marginBottom: 2 }}>
                    {r.title}
                  </div>
                  <div style={{ fontSize: 12.5, lineHeight: 1.5, color: c.sub }}>{r.body}</div>
                </div>
              </div>
            ))}
          </div>

          <div
            style={{
              marginTop: 14,
              paddingTop: 12,
              borderTop: `1px solid ${c.border}`,
              fontSize: 12,
              lineHeight: 1.5,
              color: c.faint,
            }}
          >
            The margin percentage isn’t shown to you, and it isn’t itemised for your client — they
            simply see one total price.
          </div>
        </div>
      )}
    </div>
  );
}

// ── Quote Summary sidebar (composer context) ─────────────────────────
function QuoteSummary({ variant }) {
  const isTm = variant === 'tm';
  const isEmpty = variant === 'empty';

  return (
    <div
      style={{
        background: c.surface,
        border: `1px solid ${c.border}`,
        borderRadius: 18,
        overflow: 'visible',
        boxShadow: '0 1px 3px rgba(15,23,41,0.05)',
        width: 340,
      }}
    >
      {/* Total block — dark hero treatment, pill fused to the number */}
      <div
        style={{
          background: `linear-gradient(135deg, ${c.heroA}, ${c.heroB})`,
          borderRadius: '18px 18px 0 0',
          padding: '18px 20px 16px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <SectionLabel style={{ color: 'rgba(255,255,255,0.55)' }}>
            {isTm ? 'Estimated total' : 'Total amount'}
          </SectionLabel>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '3px 9px',
              borderRadius: 999,
              background: 'rgba(14,159,110,0.18)',
              border: '1px solid rgba(14,159,110,0.45)',
            }}
          >
            <I.shieldCheck size={12} color="#4ADE9E" />
            <span
              style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.02em', color: '#4ADE9E' }}
            >
              100% yours
            </span>
          </div>
        </div>
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 32, fontWeight: 700, color: '#fff', letterSpacing: '-0.02em' }}>
            {isEmpty ? '\u2014' : isTm ? fmt(1710000) : fmt(1250000)}
          </span>
          {isTm && !isEmpty && (
            <span style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.55)' }}>
              non-binding estimate
            </span>
          )}
        </div>
        {isEmpty && (
          <div style={{ marginTop: 4, fontSize: 12.5, color: 'rgba(255,255,255,0.55)' }}>
            Add deliverables to build your quote.
          </div>
        )}
      </div>

      <div style={{ padding: '4px 20px 18px' }}>
        {/* ★ THE NOTICE — fused to the total, persistent across tabs */}
        <PayoutAssuranceNote pricingMethod={isTm ? 'tm' : 'fixed'} />

        <div style={{ height: 1, background: c.border, margin: '14px 0 4px' }} />

        {isTm ? (
          <>
            <MetaRow
              icon={<I.receipt size={14} />}
              label="Pricing method"
              value="Time & materials"
            />
            <MetaRow icon={<I.clock size={14} />} label="Your hourly rate" value="$150 / hr" />
            <MetaRow icon={<I.wallet size={14} />} label="Deposit" value="$2,500" />
            <MetaRow
              icon={<I.layers size={14} />}
              label="Deliverables"
              value={isEmpty ? '0' : '4'}
            />
            <MetaRow icon={<I.calendar size={14} />} label="Billing cadence" value="Fortnightly" />
          </>
        ) : (
          <>
            <MetaRow icon={<I.receipt size={14} />} label="Pricing method" value="Fixed price" />
            <MetaRow
              icon={<I.layers size={14} />}
              label="Deliverables"
              value={isEmpty ? '0' : '4'}
            />
            <MetaRow
              icon={<I.calendar size={14} />}
              label="Est. completion"
              value={isEmpty ? '\u2014' : '~8 weeks'}
            />
            <MetaRow
              icon={<I.receipt size={14} />}
              label="Payment terms"
              value={isEmpty ? '\u2014' : '30% upfront'}
            />
          </>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 12 }}>
          <div
            style={{
              width: 26,
              height: 26,
              borderRadius: '50%',
              background: `linear-gradient(135deg, ${c.accent}, ${c.accentB})`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <I.user size={13} color="#fff" />
          </div>
          <div style={{ fontSize: 12.5, color: c.sub }}>
            Prepared by <span style={{ fontWeight: 600, color: c.ink }}>Priya Raman</span>
          </div>
        </div>

        <button
          style={{
            marginTop: 14,
            width: '100%',
            padding: '11px 0',
            borderRadius: 12,
            border: 'none',
            cursor: 'pointer',
            background: `linear-gradient(135deg, ${c.accent}, ${c.accentB})`,
            color: '#fff',
            fontSize: 14,
            fontWeight: 600,
            fontFamily: 'inherit',
            boxShadow: '0 4px 14px rgba(37,99,235,0.28)',
          }}
        >
          Finalise and send
        </button>
      </div>
    </div>
  );
}

// ── Prototype shell: variant switcher + placement annotations ────────
export default function PayoutAssuranceNotePrototype() {
  const [variant, setVariant] = useState('fixed');
  const variants = [
    { key: 'fixed', label: 'Fixed price' },
    { key: 'tm', label: 'Time & materials' },
    { key: 'empty', label: 'New draft (no price yet)' },
  ];

  return (
    <div
      style={{
        minHeight: '100vh',
        background: c.bg,
        fontFamily: "'DM Sans', system-ui, sans-serif",
        color: c.ink,
      }}
    >
      <style>{keyframes}</style>

      <div style={{ maxWidth: 880, margin: '0 auto', padding: '40px 24px 64px' }}>
        <div style={{ ...slideUp(0) }}>
          <SectionLabel>Design reference · Proposal builder</SectionLabel>
          <h1
            style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.01em', margin: '6px 0 4px' }}
          >
            Payout assurance notice
          </h1>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: c.sub, maxWidth: 560, margin: 0 }}>
            Expert-facing disclosure that their quote is paid in full and Balo adds an undisclosed
            service margin to the client price. Lives in the Quote Summary sidebar, fused to the
            total.
          </p>
        </div>

        {/* Variant toggle */}
        <div style={{ display: 'flex', gap: 8, margin: '24px 0 28px', ...slideUp(0.06) }}>
          {variants.map((v) => (
            <button
              key={v.key}
              onClick={() => setVariant(v.key)}
              style={{
                padding: '7px 14px',
                borderRadius: 999,
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
                border: `1px solid ${variant === v.key ? 'transparent' : c.border}`,
                background:
                  variant === v.key
                    ? `linear-gradient(135deg, ${c.accent}, ${c.accentB})`
                    : c.surface,
                color: variant === v.key ? '#fff' : c.sub,
                transition: 'all 0.15s ease',
              }}
            >
              {v.label}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 32, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ ...slideUp(0.12) }}>
            <QuoteSummary variant={variant} />
          </div>

          {/* Placement annotations */}
          <div style={{ flex: 1, minWidth: 280, maxWidth: 400, ...slideUp(0.18) }}>
            <div
              style={{
                background: c.surface,
                border: `1px solid ${c.border}`,
                borderRadius: 14,
                padding: 18,
              }}
            >
              <SectionLabel style={{ marginBottom: 12 }}>Placement notes</SectionLabel>
              {[
                [
                  'Primary',
                  'Quote Summary sidebar, directly beneath the total. Persistent across all four composer tabs \u2014 present even before a price is entered.',
                ],
                [
                  'Reused',
                  'Expert\u2019s submitted-proposal read view, same component beneath the total. One component, one copy source.',
                ],
                [
                  'Deliberately absent',
                  'No repeats at input level (rate field, milestone values, deposit). The popover\u2019s \u201cRates too\u201d row covers T&M specifics instead.',
                ],
                [
                  'Never rendered',
                  'The margin percentage. Expert-facing serialization excludes balo_fee_bps and all client-priced figures.',
                ],
              ].map(([t, b]) => (
                <div
                  key={t}
                  style={{
                    display: 'flex',
                    gap: 10,
                    padding: '9px 0',
                    borderBottom: `1px solid ${c.border}`,
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 700, color: c.accent, minWidth: 118 }}>
                    {t}
                  </div>
                  <div style={{ fontSize: 12.5, lineHeight: 1.55, color: c.sub }}>{b}</div>
                </div>
              ))}
              <div style={{ fontSize: 12, color: c.faint, paddingTop: 10, lineHeight: 1.5 }}>
                Open “How pricing works” to review the full disclosure copy, including the footer
                line stating the percentage isn’t disclosed.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
