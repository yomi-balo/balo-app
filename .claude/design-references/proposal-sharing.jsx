import React, { useState, useRef, useEffect, useCallback } from 'react';

// ─────────────────────────────────────────────────────────────────────
// Balo — Proposal sharing (BAL-386, consumes BAL-385 PDF)
// Design reference covering four surfaces:
//   1. CLIENT VIEW — Share menu (Download PDF / Share with a colleague),
//      share modal (default / submitting / success / error),
//      "Shared with" list (loaded / loading / error / empty) + inline revoke.
//   2. RECIPIENT VIEW — /shared/proposals/{token}: read-only client-facing
//      proposal, state banners (active / accepted / withdrawn),
//      domain-matched Join CTA.
//   3. LINK NOT ACTIVE — one generic page for invalid / expired / revoked
//      (no information leak about which, or whether the proposal exists).
//
// HARD RULES ENCODED HERE
//   • Everything the recipient sees is CLIENT-priced (BAL-357 serializer).
//   • No "100% yours" pill anywhere — that is expert-facing only.
//   • No bare copyable link exists in any state. Email-bound only.
//   • Expiry is framed as a helpful fact, never a countdown.
// ─────────────────────────────────────────────────────────────────────

const c = {
  bg: '#F8FAFB',
  surface: '#FFFFFF',
  border: '#E0E4EB',
  ink: '#0F1729',
  sub: '#5B6472',
  faint: '#8B93A1',
  accent: '#2563EB',
  accentSoft: '#EFF4FF',
  green: '#0E9F6E',
  greenSoft: '#ECFBF4',
  amber: '#B45309',
  amberSoft: '#FEF6E7',
  red: '#DC2626',
  redSoft: '#FDF1F1',
  heroA: '#0F1729',
  heroB: '#1E293B',
};

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
  download: (p) => (
    <Ic {...p}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </Ic>
  ),
  send: (p) => (
    <Ic {...p}>
      <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
      <path d="m21.854 2.147-10.94 10.939" />
    </Ic>
  ),
  mail: (p) => (
    <Ic {...p}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </Ic>
  ),
  x: (p) => (
    <Ic {...p}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Ic>
  ),
  check: (p) => (
    <Ic {...p}>
      <path d="M20 6 9 17l-5-5" />
    </Ic>
  ),
  checkCircle: (p) => (
    <Ic {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </Ic>
  ),
  eye: (p) => (
    <Ic {...p}>
      <path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0" />
      <circle cx="12" cy="12" r="3" />
    </Ic>
  ),
  clock: (p) => (
    <Ic {...p}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </Ic>
  ),
  alert: (p) => (
    <Ic {...p}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </Ic>
  ),
  userPlus: (p) => (
    <Ic {...p}>
      <path d="M2 21a8 8 0 0 1 13.29-6" />
      <circle cx="10" cy="8" r="5" />
      <line x1="19" y1="16" x2="19" y2="22" />
      <line x1="16" y1="19" x2="22" y2="19" />
    </Ic>
  ),
  fileText: (p) => (
    <Ic {...p}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <line x1="10" y1="9" x2="8" y2="9" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </Ic>
  ),
  chevDown: (p) => (
    <Ic {...p}>
      <path d="m6 9 6 6 6-6" />
    </Ic>
  ),
  linkOff: (p) => (
    <Ic {...p}>
      <path d="M9 17H7A5 5 0 0 1 7 7" />
      <path d="M15 7h2a5 5 0 0 1 4 8" />
      <line x1="8" y1="12" x2="12" y2="12" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </Ic>
  ),
  share: (p) => (
    <Ic {...p}>
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
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
@keyframes slideUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
@keyframes popIn { from { opacity: 0; transform: translateY(6px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes shimmer { 0% { background-position: -400px 0; } 100% { background-position: 400px 0; } }
@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
}
`;
const slideUp = (d = 0) => ({ animation: `slideUp 0.4s ease-out ${d}s both` });

const Spinner = ({ size = 14, color = '#fff' }) => (
  <span
    style={{
      display: 'inline-block',
      width: size,
      height: size,
      borderRadius: '50%',
      border: `2px solid ${color}`,
      borderTopColor: 'transparent',
      animation: 'spin 0.7s linear infinite',
    }}
    aria-label="Loading"
  />
);

const Ghost = ({ w = '100%', h = 12, r = 6, style }) => (
  <div
    style={{
      width: w,
      height: h,
      borderRadius: r,
      background: `linear-gradient(90deg, #EEF1F5 25%, #F7F9FB 50%, #EEF1F5 75%)`,
      backgroundSize: '400px 100%',
      animation: 'shimmer 1.4s ease-in-out infinite',
      ...style,
    }}
  />
);

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

const Pill = ({ children, tone = 'neutral' }) => {
  const tones = {
    neutral: { bg: c.bg, bd: c.border, fg: c.sub },
    green: { bg: c.greenSoft, bd: '#BEEBD8', fg: c.green },
    amber: { bg: c.amberSoft, bd: '#F3DFB8', fg: c.amber },
    blue: { bg: c.accentSoft, bd: '#D6E3FB', fg: c.accent },
  }[tone];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 9px',
        borderRadius: 999,
        background: tones.bg,
        border: `1px solid ${tones.bd}`,
        fontSize: 11,
        fontWeight: 700,
        color: tones.fg,
      }}
    >
      {children}
    </span>
  );
};

const Btn = ({ children, kind = 'primary', onClick, disabled, style, ...rest }) => {
  const kinds = {
    primary: {
      background: c.accent,
      color: '#fff',
      border: 'none',
      boxShadow: '0 2px 8px rgba(37,99,235,0.25)',
    },
    ghost: { background: c.surface, color: c.ink, border: `1px solid ${c.border}` },
    danger: { background: c.red, color: '#fff', border: 'none' },
    dangerGhost: { background: c.surface, color: c.red, border: `1px solid #F3C6C6` },
  }[kind];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      {...rest}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
        padding: '9px 16px',
        borderRadius: 10,
        fontSize: 13.5,
        fontWeight: 600,
        cursor: disabled ? 'default' : 'pointer',
        fontFamily: 'inherit',
        opacity: disabled ? 0.6 : 1,
        transition: 'all 0.15s ease',
        ...kinds,
        ...style,
      }}
    >
      {children}
    </button>
  );
};

// ── Fixture data ─────────────────────────────────────────────────────
const P = {
  title: 'Salesforce CPQ Implementation — Phase 1',
  expert: 'Priya Raman',
  expertOrg: 'Meridian Consulting',
  client: 'Acme Industrial',
  sharer: 'Dana Okafor',
  version: 'v3',
  clientTotal: '$15,625',
  deliverables: [
    ['Discovery & solution design', '$3,125'],
    ['CPQ configuration & pricing rules', '$6,250'],
    ['Data migration & validation', '$3,125'],
    ['UAT support & team training', '$3,125'],
  ],
  docs: ['Solution architecture overview.pdf', 'Reference implementation — case study.pdf'],
  expiry: '13 August 2026',
};

const sharedRows = [
  {
    email: 'alex.chen@acme-industrial.com',
    shared: '10 Jul 2026',
    opened: 'Last opened 12 Jul 2026',
  },
  { email: 'm.osei@acme-industrial.com', shared: '14 Jul 2026', opened: 'Not opened yet' },
];

// ─────────────────────────────────────────────────────────────────────
// SURFACE 1a — Share menu (on the client proposal header)
// ─────────────────────────────────────────────────────────────────────
function ShareMenu({ onShare }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const Item = ({ icon, title, sub, onClick }) => (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        gap: 11,
        alignItems: 'flex-start',
        width: '100%',
        textAlign: 'left',
        background: 'none',
        border: 'none',
        padding: '10px 12px',
        borderRadius: 10,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = c.bg)}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: 9,
          background: c.accentSoft,
          color: c.accent,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: c.ink }}>{title}</div>
        <div style={{ fontSize: 12, color: c.sub, lineHeight: 1.45, marginTop: 1 }}>{sub}</div>
      </div>
    </button>
  );

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <Btn kind="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <I.share size={15} /> Share{' '}
        <I.chevDown
          size={14}
          style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
        />
      </Btn>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 8px)',
            width: 316,
            zIndex: 40,
            background: c.surface,
            border: `1px solid ${c.border}`,
            borderRadius: 14,
            padding: 6,
            boxShadow: '0 12px 32px rgba(15,23,41,0.14)',
            animation: 'popIn 0.16s ease-out both',
          }}
        >
          <Item
            icon={<I.download size={16} />}
            title="Download PDF"
            sub={`The proposal as a file (${P.version}) — ready to save or print.`}
            onClick={() => setOpen(false)}
          />
          <Item
            icon={<I.mail size={16} />}
            title="Share with a colleague"
            sub="Sends the PDF and a private view link to their email."
            onClick={() => {
              setOpen(false);
              onShare();
            }}
          />
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// SURFACE 1b — Share modal (default / submitting / success / error)
// ─────────────────────────────────────────────────────────────────────
function ShareModal({ open, onClose, forcedState }) {
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [state, setState] = useState('default'); // default | submitting | success | error
  useEffect(() => {
    if (open) {
      setState(forcedState || 'default');
      if (!forcedState) {
        setEmail('');
        setNote('');
      }
    }
  }, [open, forcedState]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape' && state !== 'submitting') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, state, onClose]);

  const submit = () => {
    setState('submitting');
    setTimeout(() => setState('success'), 900); // prototype simulation
  };

  if (!open) return null;
  const shownEmail = email || 'alex.chen@acme-industrial.com';

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 50,
        background: 'rgba(15,23,41,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'fadeIn 0.15s ease-out both',
        borderRadius: 18,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && state !== 'submitting') onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Share this proposal"
        style={{
          width: 420,
          maxWidth: 'calc(100% - 32px)',
          background: c.surface,
          borderRadius: 16,
          boxShadow: '0 20px 48px rgba(15,23,41,0.22)',
          padding: 22,
          animation: 'popIn 0.18s ease-out both',
        }}
      >
        {state !== 'success' ? (
          <>
            <div
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}
            >
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: c.ink }}>
                  Share this proposal
                </div>
                <div
                  style={{
                    fontSize: 12.5,
                    color: c.sub,
                    lineHeight: 1.5,
                    marginTop: 4,
                    maxWidth: 330,
                  }}
                >
                  Your colleague gets the proposal as a PDF and a private link to view it online —
                  no Balo account needed.
                </div>
              </div>
              <button
                onClick={onClose}
                disabled={state === 'submitting'}
                aria-label="Close"
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 4,
                  color: c.faint,
                  display: 'flex',
                }}
              >
                <I.x size={16} />
              </button>
            </div>

            {state === 'error' && (
              <div
                style={{
                  display: 'flex',
                  gap: 9,
                  alignItems: 'flex-start',
                  marginTop: 14,
                  padding: '10px 12px',
                  background: c.redSoft,
                  border: '1px solid #F3C6C6',
                  borderRadius: 10,
                }}
              >
                <I.alert size={15} color={c.red} style={{ flexShrink: 0, marginTop: 1 }} />
                <div style={{ fontSize: 12.5, color: c.ink, lineHeight: 1.5 }}>
                  We couldn’t send that just now. Your note is safe — try again.
                </div>
              </div>
            )}

            <div style={{ marginTop: 16 }}>
              <label
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: c.ink,
                  display: 'block',
                  marginBottom: 6,
                }}
              >
                Colleague’s email
              </label>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={state === 'submitting'}
                placeholder="name@company.com"
                type="email"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: `1px solid ${c.border}`,
                  fontSize: 13.5,
                  fontFamily: 'inherit',
                  color: c.ink,
                  background: state === 'submitting' ? c.bg : c.surface,
                  outline: 'none',
                }}
                onFocus={(e) => (e.target.style.borderColor = c.accent)}
                onBlur={(e) => (e.target.style.borderColor = c.border)}
              />
            </div>

            <div style={{ marginTop: 12 }}>
              <label
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: c.ink,
                  display: 'block',
                  marginBottom: 6,
                }}
              >
                Add a note <span style={{ fontWeight: 400, color: c.faint }}>(optional)</span>
              </label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={state === 'submitting'}
                placeholder="Here’s the proposal from Meridian we discussed…"
                rows={3}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '10px 12px',
                  borderRadius: 10,
                  resize: 'vertical',
                  border: `1px solid ${c.border}`,
                  fontSize: 13.5,
                  fontFamily: 'inherit',
                  color: c.ink,
                  background: state === 'submitting' ? c.bg : c.surface,
                  outline: 'none',
                  lineHeight: 1.5,
                }}
                onFocus={(e) => (e.target.style.borderColor = c.accent)}
                onBlur={(e) => (e.target.style.borderColor = c.border)}
              />
            </div>

            <div
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                marginTop: 12,
                color: c.sub,
              }}
            >
              <I.clock size={14} style={{ flexShrink: 0, marginTop: 2 }} />
              <div style={{ fontSize: 12, lineHeight: 1.55 }}>
                The link works until {P.expiry} and only opens for this email address. You can
                withdraw access anytime.
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <Btn kind="ghost" onClick={onClose} disabled={state === 'submitting'}>
                Cancel
              </Btn>
              <Btn onClick={submit} disabled={state === 'submitting'} style={{ minWidth: 96 }}>
                {state === 'submitting' ? (
                  <Spinner />
                ) : (
                  <>
                    <I.send size={14} /> Send
                  </>
                )}
              </Btn>
            </div>
          </>
        ) : (
          <div style={{ textAlign: 'center', padding: '10px 4px 4px' }}>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                background: c.greenSoft,
                margin: '0 auto',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <I.checkCircle size={24} color={c.green} />
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: c.ink, marginTop: 12 }}>
              Sent to {shownEmail}
            </div>
            <div style={{ fontSize: 12.5, color: c.sub, lineHeight: 1.55, marginTop: 6 }}>
              They’ll receive an email from Balo with the proposal attached and a private link to
              view it online.
            </div>
            <Btn onClick={onClose} style={{ marginTop: 16, minWidth: 96 }}>
              Done
            </Btn>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// SURFACE 1c — "Shared with" list (loaded / loading / error / empty)
// ─────────────────────────────────────────────────────────────────────
function SharedWithCard({ state }) {
  const [confirming, setConfirming] = useState(null);
  const [revoked, setRevoked] = useState([]);
  useEffect(() => {
    setConfirming(null);
    setRevoked([]);
  }, [state]);
  const rows = sharedRows.filter((r) => !revoked.includes(r.email));

  return (
    <div
      style={{
        background: c.surface,
        border: `1px solid ${c.border}`,
        borderRadius: 16,
        padding: 18,
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
        <SectionLabel>Shared with</SectionLabel>
        {state === 'loaded' && rows.length > 0 && (
          <Pill tone="blue">
            {rows.length} active link{rows.length > 1 ? 's' : ''}
          </Pill>
        )}
      </div>

      {state === 'loading' && (
        <div style={{ paddingTop: 10 }}>
          {[0, 1].map((i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '12px 0',
                borderBottom: i === 0 ? `1px solid ${c.border}` : 'none',
              }}
            >
              <div style={{ flex: 1 }}>
                <Ghost w="55%" h={13} />
                <Ghost w="35%" h={10} style={{ marginTop: 7 }} />
              </div>
              <Ghost w={64} h={28} r={9} />
            </div>
          ))}
        </div>
      )}

      {state === 'error' && (
        <div
          style={{
            display: 'flex',
            gap: 9,
            alignItems: 'flex-start',
            marginTop: 10,
            padding: '11px 12px',
            background: c.redSoft,
            border: '1px solid #F3C6C6',
            borderRadius: 10,
          }}
        >
          <I.alert size={15} color={c.red} style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 12.5, color: c.ink, lineHeight: 1.5 }}>
            We couldn’t load who this proposal is shared with.{' '}
            <button
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                font: 'inherit',
                fontWeight: 600,
                color: c.accent,
                cursor: 'pointer',
                textDecoration: 'underline',
                textUnderlineOffset: 2,
              }}
            >
              Try again
            </button>
          </div>
        </div>
      )}

      {state === 'empty' && (
        <div style={{ textAlign: 'center', padding: '18px 12px 10px' }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              background: c.bg,
              border: `1px dashed ${c.border}`,
              margin: '0 auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <I.mail size={17} color={c.faint} />
          </div>
          <div style={{ fontSize: 13, color: c.sub, marginTop: 10, lineHeight: 1.5 }}>
            No one outside your team has access yet.
          </div>
        </div>
      )}

      {state === 'loaded' && rows.length === 0 && (
        <div style={{ fontSize: 13, color: c.sub, padding: '14px 0 6px', textAlign: 'center' }}>
          No one outside your team has access yet.
        </div>
      )}

      {state === 'loaded' &&
        rows.map((r, i) => (
          <div
            key={r.email}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              padding: '12px 0',
              borderBottom: i < rows.length - 1 ? `1px solid ${c.border}` : 'none',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13.5,
                  fontWeight: 600,
                  color: c.ink,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {r.email}
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 3, fontSize: 12, color: c.faint }}>
                <span>Shared {r.shared}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <I.eye size={12} /> {r.opened}
                </span>
              </div>
            </div>
            {confirming === r.email ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <span style={{ fontSize: 12.5, color: c.ink, fontWeight: 600 }}>
                  Withdraw access?
                </span>
                <Btn
                  kind="danger"
                  style={{ padding: '6px 12px', fontSize: 12.5 }}
                  onClick={() => {
                    setRevoked((v) => [...v, r.email]);
                    setConfirming(null);
                  }}
                >
                  Withdraw
                </Btn>
                <Btn
                  kind="ghost"
                  style={{ padding: '6px 12px', fontSize: 12.5 }}
                  onClick={() => setConfirming(null)}
                >
                  Keep
                </Btn>
              </div>
            ) : (
              <Btn
                kind="dangerGhost"
                style={{ padding: '6px 12px', fontSize: 12.5, flexShrink: 0 }}
                onClick={() => setConfirming(r.email)}
              >
                Revoke
              </Btn>
            )}
          </div>
        ))}

      {state === 'loaded' && (
        <div
          style={{
            fontSize: 11.5,
            color: c.faint,
            lineHeight: 1.5,
            marginTop: 12,
            paddingTop: 12,
            borderTop: `1px solid ${c.border}`,
          }}
        >
          Each link works only for the email it was sent to, until {P.expiry}. Recipients can view
          the proposal but can’t accept it or see your team’s activity.
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// TAB 1 — Client view: proposal header + Share menu + modal + list
// ─────────────────────────────────────────────────────────────────────
function ClientViewTab() {
  const [modalOpen, setModalOpen] = useState(false);
  const [modalState, setModalState] = useState(null); // null = interactive
  const [listState, setListState] = useState('loaded');

  const openForced = (s) => {
    setModalState(s);
    setModalOpen(true);
  };

  return (
    <div>
      <div
        style={{
          position: 'relative',
          background: c.surface,
          border: `1px solid ${c.border}`,
          borderRadius: 18,
          overflow: 'visible',
          ...slideUp(0.05),
        }}
      >
        {/* Compact client proposal header for context */}
        <div
          style={{
            padding: '20px 22px',
            borderBottom: `1px solid ${c.border}`,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 14,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Pill tone="blue">Proposal {P.version}</Pill>
              <Pill tone="neutral">Awaiting your review</Pill>
            </div>
            <div
              style={{
                fontSize: 19,
                fontWeight: 700,
                color: c.ink,
                marginTop: 9,
                letterSpacing: '-0.01em',
              }}
            >
              {P.title}
            </div>
            <div style={{ fontSize: 12.5, color: c.sub, marginTop: 4 }}>
              Prepared by <span style={{ fontWeight: 600, color: c.ink }}>{P.expert}</span> @{' '}
              {P.expertOrg} · Total {P.clientTotal}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <ShareMenu
              onShare={() => {
                setModalState(null);
                setModalOpen(true);
              }}
            />
            <Btn>Review proposal</Btn>
          </div>
        </div>
        <div style={{ padding: '14px 22px', fontSize: 12.5, color: c.faint }}>
          … proposal content (overview, deliverables, terms) continues below — unchanged by this
          feature …
        </div>
        <ShareModal open={modalOpen} onClose={() => setModalOpen(false)} forcedState={modalState} />
      </div>

      <div
        style={{
          display: 'flex',
          gap: 8,
          margin: '18px 0 10px',
          flexWrap: 'wrap',
          alignItems: 'center',
          ...slideUp(0.1),
        }}
      >
        <SectionLabel style={{ marginRight: 4 }}>Modal states</SectionLabel>
        {['default', 'submitting', 'success', 'error'].map((s) => (
          <StateChip key={s} active={false} onClick={() => openForced(s)}>
            {s}
          </StateChip>
        ))}
        <SectionLabel style={{ margin: '0 4px 0 14px' }}>List states</SectionLabel>
        {['loaded', 'loading', 'error', 'empty'].map((s) => (
          <StateChip key={s} active={listState === s} onClick={() => setListState(s)}>
            {s}
          </StateChip>
        ))}
      </div>

      <div style={{ maxWidth: 520, ...slideUp(0.15) }}>
        <SharedWithCard state={listState} />
      </div>
    </div>
  );
}

const StateChip = ({ children, active, onClick }) => (
  <button
    onClick={onClick}
    style={{
      padding: '5px 12px',
      borderRadius: 999,
      fontSize: 12,
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: 'inherit',
      border: `1px solid ${active ? c.accent : c.border}`,
      background: active ? c.accentSoft : c.surface,
      color: active ? c.accent : c.sub,
      transition: 'all 0.12s ease',
    }}
  >
    {children}
  </button>
);

// ─────────────────────────────────────────────────────────────────────
// TAB 2 — Recipient view (/shared/proposals/{token})
// ─────────────────────────────────────────────────────────────────────
function RecipientViewTab() {
  const [variant, setVariant] = useState('active'); // active | accepted | withdrawn
  const [domainMatch, setDomainMatch] = useState(true);

  return (
    <div>
      <div
        style={{
          display: 'flex',
          gap: 8,
          marginBottom: 16,
          flexWrap: 'wrap',
          alignItems: 'center',
          ...slideUp(0),
        }}
      >
        <SectionLabel style={{ marginRight: 4 }}>Proposal state</SectionLabel>
        {['active', 'accepted', 'withdrawn'].map((s) => (
          <StateChip key={s} active={variant === s} onClick={() => setVariant(s)}>
            {s}
          </StateChip>
        ))}
        <SectionLabel style={{ margin: '0 4px 0 14px' }}>Recipient domain</SectionLabel>
        <StateChip active={domainMatch} onClick={() => setDomainMatch(true)}>
          matches client company
        </StateChip>
        <StateChip active={!domainMatch} onClick={() => setDomainMatch(false)}>
          external
        </StateChip>
      </div>

      <div
        style={{
          background: c.surface,
          border: `1px solid ${c.border}`,
          borderRadius: 18,
          overflow: 'hidden',
          ...slideUp(0.08),
        }}
      >
        {/* Header strip — establishes provenance and view-only nature */}
        <div
          style={{
            background: `linear-gradient(135deg, ${c.heroA}, ${c.heroB})`,
            padding: '14px 22px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 30,
                height: 30,
                borderRadius: 9,
                background: 'rgba(255,255,255,0.12)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontWeight: 800,
                fontSize: 14,
              }}
            >
              b
            </div>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: '#fff' }}>Shared proposal</div>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>
                Shared with you by {P.sharer} at {P.client}
              </div>
            </div>
          </div>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '4px 10px',
              borderRadius: 999,
              background: 'rgba(255,255,255,0.1)',
              border: '1px solid rgba(255,255,255,0.25)',
              fontSize: 11,
              fontWeight: 700,
              color: 'rgba(255,255,255,0.85)',
            }}
          >
            <I.eye size={12} /> View only
          </span>
        </div>

        {/* State banners */}
        {variant === 'accepted' && (
          <div
            style={{
              display: 'flex',
              gap: 9,
              alignItems: 'center',
              padding: '11px 22px',
              background: c.greenSoft,
              borderBottom: '1px solid #BEEBD8',
            }}
          >
            <I.checkCircle size={15} color={c.green} />
            <div style={{ fontSize: 12.5, color: c.ink }}>
              This proposal was accepted by {P.client} on 12 July 2026.
            </div>
          </div>
        )}
        {variant === 'withdrawn' && (
          <div
            style={{
              display: 'flex',
              gap: 9,
              alignItems: 'center',
              padding: '11px 22px',
              background: c.amberSoft,
              borderBottom: '1px solid #F3DFB8',
            }}
          >
            <I.alert size={15} color={c.amber} />
            <div style={{ fontSize: 12.5, color: c.ink }}>
              This proposal has been withdrawn by {P.expertOrg}. It’s shown here for reference only.
            </div>
          </div>
        )}

        <div style={{ padding: '22px', opacity: variant === 'withdrawn' ? 0.75 : 1 }}>
          <div style={{ fontSize: 21, fontWeight: 700, color: c.ink, letterSpacing: '-0.01em' }}>
            {P.title}
          </div>
          <div style={{ fontSize: 12.5, color: c.sub, marginTop: 5 }}>
            Prepared by <span style={{ fontWeight: 600, color: c.ink }}>{P.expert}</span> @{' '}
            {P.expertOrg} · for <span style={{ fontWeight: 600, color: c.ink }}>{P.client}</span>
          </div>

          {/* Total — CLIENT price. No payout pill: that is expert-facing only. */}
          <div
            style={{
              marginTop: 16,
              padding: '14px 18px',
              borderRadius: 14,
              background: c.bg,
              border: `1px solid ${c.border}`,
              display: 'flex',
              alignItems: 'baseline',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <div>
              <SectionLabel>Total amount</SectionLabel>
              <div
                style={{
                  fontSize: 28,
                  fontWeight: 700,
                  color: c.ink,
                  letterSpacing: '-0.02em',
                  marginTop: 3,
                }}
              >
                {P.clientTotal}
              </div>
            </div>
            <div style={{ fontSize: 12.5, color: c.faint }}>
              Fixed price · est. 8 weeks · 30% upfront
            </div>
          </div>

          <SectionLabel style={{ marginTop: 20, marginBottom: 6 }}>Deliverables</SectionLabel>
          {P.deliverables.map(([name, value], i) => (
            <div
              key={name}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 10,
                padding: '10px 0',
                borderBottom: i < P.deliverables.length - 1 ? `1px solid ${c.border}` : 'none',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  gap: 9,
                  alignItems: 'center',
                  color: c.ink,
                  fontSize: 13.5,
                }}
              >
                <I.layers size={14} color={c.faint} /> {name}
              </div>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: c.ink }}>{value}</div>
            </div>
          ))}

          <SectionLabel style={{ marginTop: 20, marginBottom: 6 }}>Documents</SectionLabel>
          {P.docs.map((d) => (
            <div
              key={d}
              style={{
                display: 'flex',
                gap: 9,
                alignItems: 'center',
                padding: '8px 0',
                fontSize: 13,
                color: c.ink,
              }}
            >
              <I.fileText size={14} color={c.faint} /> {d}
            </div>
          ))}

          {/* Join CTA — only on client-domain match (ADR-1031 auto-join) */}
          {domainMatch && variant !== 'withdrawn' && (
            <div
              style={{
                marginTop: 22,
                padding: '15px 18px',
                borderRadius: 14,
                background: c.accentSoft,
                border: '1px solid #D6E3FB',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', gap: 11, alignItems: 'center' }}>
                <div
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 10,
                    background: c.surface,
                    border: `1px solid ${c.border}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <I.userPlus size={16} color={c.accent} />
                </div>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: c.ink }}>
                    Work at {P.client}?
                  </div>
                  <div style={{ fontSize: 12.5, color: c.sub, marginTop: 1 }}>
                    Join your team on Balo to comment on and act on proposals.
                  </div>
                </div>
              </div>
              <Btn>Join {P.client} on Balo</Btn>
            </div>
          )}
        </div>

        <div
          style={{
            padding: '12px 22px',
            borderTop: `1px solid ${c.border}`,
            display: 'flex',
            justifyContent: 'space-between',
            gap: 10,
            flexWrap: 'wrap',
            fontSize: 11.5,
            color: c.faint,
          }}
        >
          <span>
            You’re viewing the latest version ({P.version}). This link works until {P.expiry}.
          </span>
          <span>
            Powered by <span style={{ fontWeight: 700, color: c.sub }}>Balo</span>
          </span>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// TAB 3 — Link not active (one page for invalid / expired / revoked)
// ─────────────────────────────────────────────────────────────────────
function LinkNotActiveTab() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 26, ...slideUp(0.05) }}>
      <div
        style={{
          width: 440,
          maxWidth: '100%',
          background: c.surface,
          border: `1px solid ${c.border}`,
          borderRadius: 18,
          padding: '34px 30px',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: 16,
            background: c.bg,
            border: `1px solid ${c.border}`,
            margin: '0 auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <I.linkOff size={22} color={c.faint} />
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, color: c.ink, marginTop: 16 }}>
          This link isn’t active
        </div>
        <div style={{ fontSize: 13, color: c.sub, lineHeight: 1.6, marginTop: 8 }}>
          Shared proposal links stop working after a while, or when the sender withdraws access. Ask
          the person who shared this with you to send a fresh one — it only takes a moment.
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: c.faint,
            marginTop: 18,
            paddingTop: 14,
            borderTop: `1px solid ${c.border}`,
          }}
        >
          Powered by <span style={{ fontWeight: 700, color: c.sub }}>Balo</span>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Shell
// ─────────────────────────────────────────────────────────────────────
export default function ProposalSharingPrototype() {
  const [tab, setTab] = useState('client');
  const tabs = [
    { key: 'client', label: 'Client view — share & manage' },
    { key: 'recipient', label: 'Recipient view — shared link' },
    { key: 'inactive', label: 'Link not active' },
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
      <div style={{ maxWidth: 940, margin: '0 auto', padding: '40px 24px 64px' }}>
        <div style={{ ...slideUp(0) }}>
          <SectionLabel>Design reference · BAL-386 (consumes BAL-385)</SectionLabel>
          <h1
            style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.01em', margin: '6px 0 4px' }}
          >
            Proposal sharing
          </h1>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: c.sub, maxWidth: 620, margin: 0 }}>
            Email-bound magic links only — no copyable link exists in any state. Every figure the
            recipient sees is client-priced (BAL-357 serializer); the expert payout pill never
            appears on these surfaces. Expiry is stated as a helpful fact, never a countdown.
          </p>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 8,
            margin: '22px 0 24px',
            flexWrap: 'wrap',
            ...slideUp(0.05),
          }}
        >
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                padding: '8px 15px',
                borderRadius: 999,
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
                border: `1px solid ${tab === t.key ? 'transparent' : c.border}`,
                background: tab === t.key ? c.ink : c.surface,
                color: tab === t.key ? '#fff' : c.sub,
                transition: 'all 0.15s ease',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'client' && <ClientViewTab />}
        {tab === 'recipient' && <RecipientViewTab />}
        {tab === 'inactive' && <LinkNotActiveTab />}
      </div>
    </div>
  );
}
