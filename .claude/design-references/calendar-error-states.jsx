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
  warning: '#D97706', warningLight: '#FFFBEB', warningBorder: '#FDE68A',
  warningDark: '#92400E',
  error: '#DC2626', errorLight: '#FEF2F2', errorBorder: '#FECACA',
  gradient: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
  gradientSubtle: 'linear-gradient(135deg, #EFF6FF 0%, #F5F3FF 100%)',
};

const keyframes = `
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
@keyframes scaleIn { from { transform: scale(0.97); opacity: 0; } to { transform: scale(1); opacity: 1; } }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes shimmer { 0% { background-position: -400px 0; } 100% { background-position: 400px 0; } }
`;
const slideUp = (d = 0) => ({ animation: `slideUp 0.4s ease-out ${d}s both` });

// ── Icons ────────────────────────────────────────────────────────
const Icon = ({ d, size = 16, color = 'currentColor', style: xs }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
    strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={xs}><path d={d} /></svg>
);
const Icons = {
  alertTriangle: (p) => <Icon {...p} d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01" />,
  alertCircle: (p) => <svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" fill="none" stroke={p.color||'currentColor'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={p.style}><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>,
  refreshCw: (p) => <Icon {...p} d="M21 2v6h-6M3 12a9 9 0 0115-6.7L21 8M3 22v-6h6M21 12a9 9 0 01-15 6.7L3 16" />,
  externalLink: (p) => <Icon {...p} d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />,
  info: (p) => <svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" fill="none" stroke={p.color||'currentColor'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={p.style}><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>,
  check: (p) => <Icon {...p} d="M20 6L9 17l-5-5" />,
  arrowRight: (p) => <Icon {...p} d="M5 12h14M12 5l7 7-7 7" />,
  shield: (p) => <Icon {...p} d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  lock: (p) => <svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" fill="none" stroke={p.color||'currentColor'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={p.style}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>,
  clock: (p) => <svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" fill="none" stroke={p.color||'currentColor'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={p.style}><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>,
  x: (p) => <Icon {...p} d="M18 6L6 18M6 6l12 12" />,
};

const MicrosoftIcon = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24">
    <rect x="1" y="1" width="10.5" height="10.5" fill="#F25022" />
    <rect x="12.5" y="1" width="10.5" height="10.5" fill="#7FBA00" />
    <rect x="1" y="12.5" width="10.5" height="10.5" fill="#00A4EF" />
    <rect x="12.5" y="12.5" width="10.5" height="10.5" fill="#FFB900" />
  </svg>
);
const GoogleIcon = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
  </svg>
);

function Card({ children, style: xs }) {
  return (
    <div style={{ background: c.surface, borderRadius: 16, border: `1px solid ${c.border}`,
      boxShadow: '0 1px 3px rgba(0,0,0,0.04)', ...xs }}>{children}</div>
  );
}

// ══════════════════════════════════════════════════════════════════
// STATE 1: SYNC PENDING
// When: OAuth completed but profile_initial_sync_required === true
// (User didn't grant all Google/Outlook calendar permissions)
// ══════════════════════════════════════════════════════════════════
function SyncPendingCard({ provider = 'google' }) {
  const [showDetail, setShowDetail] = useState(false);
  const ProviderIcon = provider === 'google' ? GoogleIcon : MicrosoftIcon;
  const providerName = provider === 'google' ? 'Google Calendar' : 'Microsoft 365';
  const email = provider === 'google' ? 'yomi@gmail.com' : 'yomi@balo.expert';

  return (
    <Card style={{ overflow: 'hidden', ...slideUp(0.05) }}>
      {/* Header — amber tone, distinct from both connected (green) and auth_error (red) */}
      <div style={{ padding: '16px 20px', background: c.warningLight,
        borderBottom: `1px solid ${c.warningBorder}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, background: c.surface,
            border: `1px solid ${c.border}`, display: 'flex', alignItems: 'center',
            justifyContent: 'center', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', flexShrink: 0 }}>
            <ProviderIcon size={21} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 650, color: c.text, display: 'block' }}>
              {providerName}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: c.warning }} />
              <span style={{ fontSize: 12, color: c.warning, fontWeight: 600 }}>
                Permissions incomplete
              </span>
            </div>
          </div>
          <span style={{ fontSize: 12, color: c.textTertiary }}>{email}</span>
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: '18px 20px' }}>
        {/* Warning message */}
        <div style={{ display: 'flex', gap: 10, padding: '12px 14px', borderRadius: 10,
          background: '#FFFCF0', border: `1px solid ${c.warningBorder}`, marginBottom: 16 }}>
          <Icons.alertTriangle size={15} color={c.warning} style={{ marginTop: 1, flexShrink: 0 }} />
          <div>
            <p style={{ fontSize: 13, fontWeight: 600, color: c.warningDark, margin: '0 0 4px' }}>
              We couldn't read your calendar
            </p>
            <p style={{ fontSize: 13, color: c.warning, margin: 0, lineHeight: 1.55 }}>
              Your calendar was connected but some permissions weren't granted. Balo needs full
              access to calculate your real availability.
            </p>
          </div>
        </div>

        {/* Expandable explanation */}
        <button onClick={() => setShowDetail(!showDetail)}
          style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: 'none',
            cursor: 'pointer', padding: '0 0 12px', fontSize: 12, fontWeight: 600,
            color: c.textSecondary }}>
          <Icons.info size={12} color={c.textTertiary} />
          Why did this happen?
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke={c.textTertiary}
            strokeWidth={2} style={{ transform: showDetail ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>

        {showDetail && (
          <div style={{ padding: '10px 14px', borderRadius: 8, background: c.surfaceSubtle,
            marginBottom: 14, animation: 'fadeIn 0.2s ease-out' }}>
            <p style={{ fontSize: 13, color: c.textSecondary, margin: 0, lineHeight: 1.6 }}>
              During the {providerName} connection step, your calendar provider shows permission
              toggles that need to be manually turned on. If you clicked through quickly, some
              toggles may have been left off. Clicking "Fix permissions" will let you re-grant
              them without creating a new account.
            </p>
          </div>
        )}

        {/* CTAs */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 18px',
            borderRadius: 9, fontSize: 13, fontWeight: 650,
            background: c.warning, color: 'white', border: 'none', cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(217,119,6,0.25)' }}>
            <Icons.refreshCw size={13} color="white" />
            Fix permissions
          </button>
          <a href="#" style={{ fontSize: 13, color: c.textTertiary, textDecoration: 'none',
            display: 'flex', alignItems: 'center', gap: 4 }}>
            Learn more
            <Icons.externalLink size={11} color={c.textTertiary} />
          </a>
        </div>

        {/* Self-healing note */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 14,
          padding: '8px 12px', borderRadius: 8,
          background: `${c.success}08`, border: `1px solid ${c.success}20` }}>
          <Icons.check size={12} color={c.success} style={{ marginTop: 1, flexShrink: 0 }} />
          <span style={{ fontSize: 12, color: c.success, lineHeight: 1.5 }}>
            Once permissions are granted, your calendar will sync automatically — no further action needed.
          </span>
        </div>
      </div>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════
// STATE 2: O365 GUIDANCE MODAL
// When: User selects Microsoft 365 in the empty state
// Shows pre-emptive admin approval info before redirecting
// ══════════════════════════════════════════════════════════════════
function O365GuidanceModal({ onContinue, onCancel }) {
  return (
    <Card style={{ overflow: 'hidden', ...slideUp(0) }}>
      {/* Header */}
      <div style={{ padding: '18px 22px 16px', background: c.gradientSubtle,
        borderBottom: `1px solid ${c.accentBorder}50` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 40, height: 40, borderRadius: 11, background: c.surface,
            border: `1px solid ${c.border}`, display: 'flex', alignItems: 'center',
            justifyContent: 'center', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
            <MicrosoftIcon size={22} />
          </div>
          <div>
            <p style={{ fontSize: 14, fontWeight: 700, color: c.text, margin: 0 }}>
              Connect Microsoft 365
            </p>
            <p style={{ fontSize: 12, color: c.textSecondary, margin: '2px 0 0' }}>
              Outlook or Microsoft 365 work account
            </p>
          </div>
        </div>
      </div>

      <div style={{ padding: '20px 22px' }}>
        {/* Admin approval callout */}
        <div style={{ padding: '14px 16px', borderRadius: 10,
          background: c.primaryLight, border: `1px solid ${c.primaryBorder}`,
          marginBottom: 18 }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <Icons.info size={15} color={c.primary} style={{ flexShrink: 0, marginTop: 1 }} />
            <div>
              <p style={{ fontSize: 13, fontWeight: 650, color: c.primary, margin: '0 0 5px' }}>
                Your IT admin may need to approve this once
              </p>
              <p style={{ fontSize: 13, color: c.textSecondary, margin: 0, lineHeight: 1.6 }}>
                If your organization uses a managed Microsoft 365 account, you may see an
                "Admin approval required" screen. This only needs to happen{' '}
                <strong>once for your entire company</strong> — after your IT admin approves,
                all colleagues can connect without this step.
              </p>
            </div>
          </div>
        </div>

        {/* What they'll see */}
        <p style={{ fontSize: 12, fontWeight: 700, color: c.textTertiary, textTransform: 'uppercase',
          letterSpacing: '0.07em', margin: '0 0 10px' }}>What to expect</p>
        {[
          { step: '1', text: 'A Microsoft sign-in window opens' },
          { step: '2', text: 'Sign in with your work account' },
          { step: '3', text: 'If prompted for admin approval, click "Request approval" and ask your IT admin' },
          { step: '4', text: 'Once approved, click "Connect" again to complete the setup' },
        ].map(({ step, text }) => (
          <div key={step} style={{ display: 'flex', gap: 10, marginBottom: 8, alignItems: 'flex-start' }}>
            <div style={{ width: 20, height: 20, borderRadius: '50%', background: c.surfaceSubtle,
              border: `1px solid ${c.border}`, display: 'flex', alignItems: 'center',
              justifyContent: 'center', flexShrink: 0, fontSize: 10, fontWeight: 700, color: c.textTertiary }}>
              {step}
            </div>
            <span style={{ fontSize: 13, color: c.textSecondary, lineHeight: 1.5, paddingTop: 2 }}>{text}</span>
          </div>
        ))}

        <a href="https://docs.cronofy.com/calendar-admins/faqs/need-admin-approval-error/"
          target="_blank" rel="noreferrer"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12,
            color: c.primary, textDecoration: 'none', marginTop: 4, marginBottom: 20 }}>
          Admin approval guide
          <Icons.externalLink size={11} color={c.primary} />
        </a>

        {/* CTAs */}
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onContinue}
            style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: 8, padding: '10px 18px', borderRadius: 10, fontSize: 13, fontWeight: 650,
              background: c.primary, color: 'white', border: 'none', cursor: 'pointer',
              boxShadow: `0 2px 10px ${c.primaryGlow}` }}>
            Continue to Microsoft 365
            <Icons.arrowRight size={13} color="white" />
          </button>
          <button onClick={onCancel}
            style={{ padding: '10px 16px', borderRadius: 10, fontSize: 13, fontWeight: 550,
              background: c.surface, color: c.textSecondary,
              border: `1px solid ${c.border}`, cursor: 'pointer' }}>
            Cancel
          </button>
        </div>
      </div>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════
// STATE 3: O365 ADMIN APPROVAL WAITING
// When: User attempted O365 OAuth but returned without a token
// (admin hasn't approved yet — or they abandoned during the approval flow)
// ══════════════════════════════════════════════════════════════════
function O365WaitingCard({ onTryAgain, onCancel }) {
  return (
    <Card style={{ padding: '40px 32px', textAlign: 'center', ...slideUp(0) }}>
      {/* Microsoft badge with clock overlay */}
      <div style={{ position: 'relative', width: 68, height: 68, margin: '0 auto 22px' }}>
        <div style={{ width: 68, height: 68, borderRadius: 18, background: c.surface,
          border: `1px solid ${c.border}`, display: 'flex', alignItems: 'center',
          justifyContent: 'center', boxShadow: '0 2px 12px rgba(0,0,0,0.08)' }}>
          <MicrosoftIcon size={32} />
        </div>
        <div style={{ position: 'absolute', bottom: -4, right: -4, width: 24, height: 24,
          borderRadius: '50%', background: c.warningLight, border: `2px solid ${c.surface}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icons.clock size={12} color={c.warning} />
        </div>
      </div>

      {/* Status */}
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8,
        padding: '6px 16px', borderRadius: 20, background: c.warningLight,
        border: `1px solid ${c.warningBorder}`, marginBottom: 14 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: c.warning,
          animation: 'pulse 2s ease-in-out infinite' }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: c.warning }}>
          Waiting for IT admin approval
        </span>
      </div>

      <h3 style={{ fontSize: 17, fontWeight: 700, color: c.text, margin: '0 0 10px' }}>
        Your IT admin needs to take action
      </h3>
      <p style={{ fontSize: 14, color: c.textSecondary, margin: '0 auto', lineHeight: 1.6,
        maxWidth: 400 }}>
        You've requested access, but your company's Microsoft administrator needs to approve
        the Balo calendar integration in their admin portal.
      </p>

      {/* Instructions box */}
      <div style={{ margin: '20px auto', maxWidth: 400, padding: '14px 16px', borderRadius: 10,
        background: c.surfaceSubtle, border: `1px solid ${c.borderSubtle}`, textAlign: 'left' }}>
        <p style={{ fontSize: 12, fontWeight: 700, color: c.textTertiary, textTransform: 'uppercase',
          letterSpacing: '0.07em', margin: '0 0 10px' }}>What to do next</p>
        {[
          'Ask your IT admin to approve "Balo" in the Microsoft Entra admin center',
          'This approval only needs to happen once — all colleagues at your company can connect after',
          'Once approved, click "Try connecting again" below',
        ].map((text, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, marginBottom: i < 2 ? 8 : 0 }}>
            <div style={{ width: 16, height: 16, borderRadius: '50%', background: c.primaryLight,
              border: `1px solid ${c.primaryBorder}`, display: 'flex', alignItems: 'center',
              justifyContent: 'center', flexShrink: 0, fontSize: 9, fontWeight: 700,
              color: c.primary, marginTop: 1 }}>{i + 1}</div>
            <span style={{ fontSize: 13, color: c.textSecondary, lineHeight: 1.5 }}>{text}</span>
          </div>
        ))}
      </div>

      <a href="https://docs.cronofy.com/calendar-admins/faqs/need-admin-approval-error/"
        target="_blank" rel="noreferrer"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13,
          color: c.primary, textDecoration: 'none', marginBottom: 20 }}>
        View admin approval guide
        <Icons.externalLink size={12} color={c.primary} />
      </a>

      <div style={{ display: 'flex', justifyContent: 'center', gap: 10 }}>
        <button onClick={onTryAgain}
          style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 20px',
            borderRadius: 9, fontSize: 13, fontWeight: 650,
            background: c.primary, color: 'white', border: 'none', cursor: 'pointer',
            boxShadow: `0 2px 10px ${c.primaryGlow}` }}>
          <Icons.refreshCw size={13} color="white" />
          Try connecting again
        </button>
        <button onClick={onCancel}
          style={{ padding: '9px 16px', borderRadius: 9, fontSize: 13, fontWeight: 550,
            background: c.surface, color: c.textSecondary,
            border: `1px solid ${c.border}`, cursor: 'pointer' }}>
          Cancel
        </button>
      </div>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════
// STATE 4: SESSION EXPIRED
// When: User spent >5 min in OAuth flow (link token expired)
// or returned from a failed OAuth attempt with no token
// ══════════════════════════════════════════════════════════════════
function SessionExpiredCard({ provider = 'google', onTryAgain }) {
  const ProviderIcon = provider === 'google' ? GoogleIcon : MicrosoftIcon;
  const providerName = provider === 'google' ? 'Google Calendar' : 'Microsoft 365';

  return (
    <Card style={{ padding: '40px 32px', textAlign: 'center', ...slideUp(0) }}>
      {/* Provider badge — greyed, no pulse ring */}
      <div style={{ width: 64, height: 64, borderRadius: 16, margin: '0 auto 20px',
        background: c.surface, border: `1px solid ${c.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: '0 2px 8px rgba(0,0,0,0.06)', opacity: 0.6 }}>
        <ProviderIcon size={28} />
      </div>

      {/* Session expired pill */}
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7,
        padding: '5px 14px', borderRadius: 20, background: c.surfaceSubtle,
        border: `1px solid ${c.border}`, marginBottom: 14 }}>
        <Icons.clock size={12} color={c.textTertiary} />
        <span style={{ fontSize: 13, fontWeight: 600, color: c.textSecondary }}>
          Connection attempt timed out
        </span>
      </div>

      <p style={{ fontSize: 14, color: c.textSecondary, margin: '0 auto 6px',
        lineHeight: 1.6, maxWidth: 360 }}>
        The {providerName} sign-in session expired before completing.
        This usually happens if the window was open for more than a few minutes.
      </p>
      <p style={{ fontSize: 13, color: c.textTertiary, margin: '0 auto 24px', maxWidth: 300 }}>
        No changes were made to your account.
      </p>

      <button onClick={onTryAgain}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 22px',
          borderRadius: 9, fontSize: 13, fontWeight: 650,
          background: c.primary, color: 'white', border: 'none', cursor: 'pointer',
          boxShadow: `0 2px 10px ${c.primaryGlow}` }}>
        <Icons.refreshCw size={13} color="white" />
        Try again
      </button>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN DEMO
// ══════════════════════════════════════════════════════════════════

const DEMO_STATES = [
  { key: 'sync_pending_google', label: 'Sync Pending (Google)' },
  { key: 'sync_pending_ms', label: 'Sync Pending (O365)' },
  { key: 'o365_guidance', label: 'O365 Guidance' },
  { key: 'o365_waiting', label: 'O365 Admin Waiting' },
  { key: 'session_expired', label: 'Session Expired' },
];

export default function CalendarErrorStates() {
  const [state, setState] = useState('sync_pending_google');

  return (
    <div style={{ minHeight: '100vh', background: c.bg,
      fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif",
      padding: '32px 40px' }}>
      <style>{keyframes}</style>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />

      {/* Context note */}
      <div style={{ padding: '10px 14px', borderRadius: 8, background: c.accentLight,
        border: `1px solid ${c.accentBorder}`, marginBottom: 20, maxWidth: 620, margin: '0 auto 20px' }}>
        <p style={{ fontSize: 12, color: c.accent, margin: 0, fontWeight: 500 }}>
          BAL-233 design reference — new error states that extend the existing calendar page
          (expert-calendar-page.jsx). These states sit in the same layout/page context.
        </p>
      </div>

      {/* State switcher */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 28 }}>
        <div style={{ display: 'inline-flex', gap: 4, padding: 4, borderRadius: 10,
          background: c.surfaceSubtle, border: `1px solid ${c.borderSubtle}`, flexWrap: 'wrap' }}>
          {DEMO_STATES.map((s) => (
            <button key={s.key} onClick={() => setState(s.key)}
              style={{ padding: '6px 14px', borderRadius: 7, fontSize: 12, fontWeight: 550,
                border: 'none', cursor: 'pointer',
                background: state === s.key ? c.surface : 'transparent',
                color: state === s.key ? c.text : c.textTertiary,
                boxShadow: state === s.key ? '0 1px 3px rgba(0,0,0,0.06)' : 'none',
                transition: 'all 0.15s' }}>{s.label}</button>
          ))}
        </div>
      </div>

      <div style={{ maxWidth: 620, margin: '0 auto' }} key={state}>
        {/* Page header context — same as calendar page */}
        <div style={{ marginBottom: 24, ...slideUp(0) }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <div style={{ width: 40, height: 40, borderRadius: 11,
              background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(124,58,237,0.15)',
              display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={c.accent}
                strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2"/>
                <path d="M16 2v4M8 2v4M3 10h18"/>
              </svg>
            </div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: c.text, margin: 0 }}>Calendar</h1>
          </div>
          <p style={{ fontSize: 14, color: c.textSecondary, margin: 0, lineHeight: 1.6 }}>
            Connect your calendar so Balo only shows clients times when you're genuinely free.
          </p>
        </div>

        {state === 'sync_pending_google' && <SyncPendingCard provider="google" />}
        {state === 'sync_pending_ms' && <SyncPendingCard provider="microsoft" />}
        {state === 'o365_guidance' && (
          <O365GuidanceModal onContinue={() => setState('o365_waiting')} onCancel={() => {}} />
        )}
        {state === 'o365_waiting' && (
          <O365WaitingCard onTryAgain={() => setState('o365_guidance')} onCancel={() => {}} />
        )}
        {state === 'session_expired' && (
          <SessionExpiredCard provider="google" onTryAgain={() => {}} />
        )}
      </div>
    </div>
  );
}
