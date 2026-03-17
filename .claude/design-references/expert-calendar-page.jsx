import { useState } from 'react';

// ── Design Tokens (shared across Balo) ────────────────────────────
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
  errorBorder: '#FECACA',
  gradient: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
  gradientSubtle: 'linear-gradient(135deg, #EFF6FF 0%, #F5F3FF 100%)',
};

// ── Animations ────────────────────────────────────────────────────
const keyframes = `
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
@keyframes scaleIn { from { transform: scale(0.96); opacity: 0; } to { transform: scale(1); opacity: 1; } }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
@keyframes dotPulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.4); opacity: 0.7; } }
@keyframes checkPop { 0% { transform: scale(0); } 60% { transform: scale(1.3); } 100% { transform: scale(1); } }
@keyframes dropIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
@keyframes confirmIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
`;

const slideUp = (delay = 0) => ({ animation: `slideUp 0.4s ease-out ${delay}s both` });

// ── Provider SVG Icons ────────────────────────────────────────────
const GoogleIcon = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
  </svg>
);

const MicrosoftIcon = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24">
    <rect x="1" y="1" width="10.5" height="10.5" fill="#F25022"/>
    <rect x="12.5" y="1" width="10.5" height="10.5" fill="#7FBA00"/>
    <rect x="1" y="12.5" width="10.5" height="10.5" fill="#00A4EF"/>
    <rect x="12.5" y="12.5" width="10.5" height="10.5" fill="#FFB900"/>
  </svg>
);

// ── Lucide-style Icons ────────────────────────────────────────────
const Icon = ({ d, size = 16, color = 'currentColor', style: xs }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={xs}><path d={d} /></svg>
);
const Icons = {
  check:      (p) => <Icon {...p} d="M20 6L9 17l-5-5" />,
  calendar:   (p) => <svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" fill="none" stroke={p.color||'currentColor'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={p.style}><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>,
  plus:       (p) => <Icon {...p} d="M12 5v14M5 12h14" />,
  x:          (p) => <Icon {...p} d="M18 6L6 18M6 6l12 12" />,
  alertCircle:(p) => <svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" fill="none" stroke={p.color||'currentColor'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={p.style}><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>,
  refreshCw:  (p) => <svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" fill="none" stroke={p.color||'currentColor'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={p.style}><path d="M21 2v6h-6M3 12a9 9 0 0115-6.7L21 8M3 22v-6h6M21 12a9 9 0 01-15 6.7L3 16"/></svg>,
  shield:     (p) => <Icon {...p} d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  info:       (p) => <svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" fill="none" stroke={p.color||'currentColor'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={p.style}><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>,
  link:       (p) => <Icon {...p} d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />,
  trash:      (p) => <svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" fill="none" stroke={p.color||'currentColor'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={p.style}><path d="M3 6h18M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2"/></svg>,
  chevDown:   (p) => <Icon {...p} d="M6 9l6 6 6-6" />,
  zap:        (p) => <svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" fill="none" stroke={p.color||'currentColor'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={p.style}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  eye:        (p) => <svg width={p.size||16} height={p.size||16} viewBox="0 0 24 24" fill="none" stroke={p.color||'currentColor'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={p.style}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
};

// ── Shared Components ─────────────────────────────────────────────
function Card({ children, style: xs }) {
  return (
    <div style={{
      background: c.surface, borderRadius: 16,
      border: `1px solid ${c.border}`,
      boxShadow: '0 1px 3px rgba(0,0,0,0.04)', ...xs,
    }}>{children}</div>
  );
}

function SectionLabelRow({ children, color = c.textTertiary, icon: Ic, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Ic size={13} color={color} />
        <span style={{ fontSize: 11, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{children}</span>
      </div>
      {right}
    </div>
  );
}

function Toggle({ checked, onChange, disabled }) {
  return (
    <div
      onClick={disabled ? undefined : () => onChange(!checked)}
      style={{
        width: 36, height: 20, borderRadius: 10,
        background: checked ? c.primary : c.border,
        position: 'relative', cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background 0.2s', flexShrink: 0,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <div style={{
        position: 'absolute', top: 2,
        left: checked ? 18 : 2,
        width: 16, height: 16, borderRadius: '50%',
        background: 'white', boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
        transition: 'left 0.18s',
      }} />
    </div>
  );
}

// ── Mock Data ─────────────────────────────────────────────────────
const GOOGLE_CONNECTION = {
  id: 'google-1', provider: 'google', email: 'yomi@gmail.com',
  status: 'synced', lastSynced: '2 min ago',
  calendars: [
    { id: 'g-primary',   name: 'Yomi Joseph',    color: '#4285F4', primary: true,  conflictCheck: true  },
    { id: 'g-work',      name: 'Work',            color: '#33B679', primary: false, conflictCheck: true  },
    { id: 'g-personal',  name: 'Personal',        color: '#E67C73', primary: false, conflictCheck: false },
    { id: 'g-birthdays', name: 'Birthdays',       color: '#F6BF26', primary: false, conflictCheck: false },
  ],
};
const MICROSOFT_CONNECTION = {
  id: 'microsoft-1', provider: 'microsoft', email: 'yomi@balo.expert',
  status: 'synced', lastSynced: '5 min ago',
  calendars: [
    { id: 'ms-primary', name: 'Calendar',       color: '#0078D4', primary: true,  conflictCheck: true  },
    { id: 'ms-team',    name: 'Team Meetings',  color: '#7719AA', primary: false, conflictCheck: true  },
  ],
};
const ERROR_CONNECTION = {
  ...GOOGLE_CONNECTION,
  status: 'error', lastSynced: '2 hours ago',
  errorMsg: 'Authorization has expired. Reconnect your Google account to resume sync.',
};

// ── Sync Status Badge ─────────────────────────────────────────────
function SyncBadge({ status, lastSynced }) {
  if (status === 'synced') return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <div style={{ width: 7, height: 7, borderRadius: '50%', background: c.success, animation: 'dotPulse 3s ease-in-out infinite' }} />
      <span style={{ fontSize: 12, color: c.success, fontWeight: 600 }}>Synced</span>
      <span style={{ fontSize: 12, color: c.textTertiary }}>· {lastSynced}</span>
    </div>
  );
  if (status === 'syncing') return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <Icons.refreshCw size={12} color={c.primary} style={{ animation: 'spin 1.2s linear infinite' }} />
      <span style={{ fontSize: 12, color: c.primary, fontWeight: 600 }}>Syncing…</span>
    </div>
  );
  if (status === 'error') return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <div style={{ width: 7, height: 7, borderRadius: '50%', background: c.error }} />
      <span style={{ fontSize: 12, color: c.error, fontWeight: 600 }}>Sync error</span>
      {lastSynced && <span style={{ fontSize: 12, color: c.textTertiary }}>· last synced {lastSynced}</span>}
    </div>
  );
  return null;
}

// ── Sub-Calendar Row ──────────────────────────────────────────────
function SubCalendarRow({ calendar, onToggle }) {
  const [h, setH] = useState(false);
  return (
    <div
      onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 10px', borderRadius: 8,
        background: h ? c.surfaceSubtle : 'transparent',
        transition: 'background 0.15s',
      }}
    >
      <div style={{ width: 9, height: 9, borderRadius: '50%', background: calendar.color, flexShrink: 0 }} />
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ fontSize: 13, color: c.text, fontWeight: calendar.primary ? 600 : 400 }}>{calendar.name}</span>
        {calendar.primary && (
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
            background: c.primaryLight, color: c.primary, border: `1px solid ${c.primaryBorder}`,
          }}>Primary</span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        {calendar.primary && (
          <span style={{ fontSize: 11, color: c.textTertiary, fontStyle: 'italic' }}>Always on</span>
        )}
        <Toggle
          checked={calendar.conflictCheck}
          onChange={(v) => !calendar.primary && onToggle(calendar.id, v)}
          disabled={calendar.primary}
        />
      </div>
    </div>
  );
}

// ── Calendar Card ─────────────────────────────────────────────────
function CalendarCard({ connection, onDisconnect, onToggleCalendar }) {
  const [expanded, setExpanded] = useState(true);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const ProviderIcon = connection.provider === 'google' ? GoogleIcon : MicrosoftIcon;
  const providerLabel = connection.provider === 'google' ? 'Google Calendar' : 'Microsoft 365';
  const isError = connection.status === 'error';
  const activeCount = connection.calendars.filter(cal => cal.conflictCheck).length;

  return (
    <Card style={{ overflow: 'hidden', ...slideUp(0.04) }}>
      {/* Card Header */}
      <div style={{
        padding: '16px 20px',
        background: isError ? c.errorLight : c.gradientSubtle,
        borderBottom: `1px solid ${isError ? c.errorBorder : c.borderSubtle}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Provider logo badge */}
          <div style={{
            width: 38, height: 38, borderRadius: 10,
            background: c.surface, border: `1px solid ${c.border}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 1px 4px rgba(0,0,0,0.06)', flexShrink: 0,
          }}>
            <ProviderIcon size={21} />
          </div>

          {/* Name + status */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 650, color: c.text, display: 'block' }}>{providerLabel}</span>
            <div style={{ marginTop: 2 }}>
              <SyncBadge status={connection.status} lastSynced={connection.lastSynced} />
            </div>
          </div>

          {/* Email + action */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <span style={{ fontSize: 12, color: c.textTertiary }}>{connection.email}</span>
            {isError ? (
              <button style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '5px 12px', borderRadius: 7,
                fontSize: 12, fontWeight: 650,
                background: c.error, color: 'white', border: 'none', cursor: 'pointer',
              }}>
                <Icons.refreshCw size={11} color="white" />
                Reconnect
              </button>
            ) : !confirmDisconnect ? (
              <button
                onClick={() => setConfirmDisconnect(true)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  padding: '5px 12px', borderRadius: 7,
                  fontSize: 12, fontWeight: 550,
                  background: c.surface, color: c.textSecondary,
                  border: `1px solid ${c.border}`, cursor: 'pointer',
                }}
              >
                <Icons.trash size={11} color={c.textSecondary} />
                Disconnect
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {/* Inline Disconnect Confirmation */}
      {confirmDisconnect && (
        <div style={{
          padding: '12px 20px',
          background: c.warningLight,
          borderBottom: `1px solid ${c.warningBorder}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          animation: 'confirmIn 0.15s ease-out',
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
            <Icons.alertCircle size={14} color={c.warning} style={{ marginTop: 1, flexShrink: 0 }} />
            <span style={{ fontSize: 13, color: c.warning, lineHeight: 1.5 }}>
              Disconnecting will stop syncing. Clients may see incorrect availability until you reconnect.
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0, marginLeft: 16 }}>
            <button
              onClick={() => setConfirmDisconnect(false)}
              style={{ padding: '5px 12px', borderRadius: 7, fontSize: 12, fontWeight: 550, background: c.surface, color: c.textSecondary, border: `1px solid ${c.border}`, cursor: 'pointer' }}
            >
              Cancel
            </button>
            <button
              onClick={() => onDisconnect(connection.id)}
              style={{ padding: '5px 12px', borderRadius: 7, fontSize: 12, fontWeight: 650, background: c.error, color: 'white', border: 'none', cursor: 'pointer' }}
            >
              Yes, disconnect
            </button>
          </div>
        </div>
      )}

      {/* Error Message Banner */}
      {isError && (
        <div style={{
          padding: '10px 20px',
          background: '#FFF8F8',
          borderBottom: `1px solid ${c.errorBorder}`,
          display: 'flex', alignItems: 'flex-start', gap: 8,
        }}>
          <Icons.alertCircle size={14} color={c.error} style={{ marginTop: 1, flexShrink: 0 }} />
          <p style={{ fontSize: 13, color: c.error, margin: 0, lineHeight: 1.5 }}>{connection.errorMsg}</p>
        </div>
      )}

      {/* Sub-Calendars Section */}
      {!isError && (
        <>
          {/* Collapsible header */}
          <div
            onClick={() => setExpanded(!expanded)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 20px 0', cursor: 'pointer', userSelect: 'none',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: c.textTertiary, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                Calendars
              </span>
              <span style={{
                fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 4,
                background: c.primaryLight, color: c.primary, border: `1px solid ${c.primaryBorder}`,
              }}>
                {activeCount} blocking conflicts
              </span>
            </div>
            <Icons.chevDown
              size={14} color={c.textTertiary}
              style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', flexShrink: 0 }}
            />
          </div>

          {expanded && (
            <div style={{ padding: '8px 10px 4px', animation: 'dropIn 0.15s ease-out' }}>
              {/* Column label */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '2px 10px 4px' }}>
                <span style={{ fontSize: 10, fontWeight: 600, color: c.textTertiary, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Use for conflicts
                </span>
              </div>

              {connection.calendars.map(cal => (
                <SubCalendarRow
                  key={cal.id}
                  calendar={cal}
                  onToggle={(id, v) => onToggleCalendar(connection.id, id, v)}
                />
              ))}

              {/* Explanation */}
              <div style={{
                display: 'flex', alignItems: 'flex-start', gap: 6,
                padding: '8px 10px 10px',
              }}>
                <Icons.info size={12} color={c.textTertiary} style={{ marginTop: 1, flexShrink: 0 }} />
                <span style={{ fontSize: 11, color: c.textTertiary, lineHeight: 1.45 }}>
                  Events on enabled calendars will block that time slot from client bookings. Event titles and details are never visible to clients.
                </span>
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// ── Provider Button ───────────────────────────────────────────────
function ProviderButton({ provider, onClick, alreadyConnected }) {
  const [h, setH] = useState(false);
  const ProviderIcon = provider === 'google' ? GoogleIcon : MicrosoftIcon;
  const name = provider === 'google' ? 'Google Calendar' : 'Microsoft 365';
  const desc = provider === 'google' ? 'Gmail or Google Workspace' : 'Outlook or Microsoft 365';

  return (
    <button
      onClick={alreadyConnected ? undefined : onClick}
      onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        width: '100%', padding: '13px 16px', borderRadius: 12,
        border: `1.5px solid ${h && !alreadyConnected ? c.primary : c.border}`,
        background: alreadyConnected ? c.surfaceSubtle : (h ? c.primaryLight : c.surface),
        textAlign: 'left', cursor: alreadyConnected ? 'default' : 'pointer',
        transition: 'all 0.18s',
        boxShadow: h && !alreadyConnected ? `0 0 0 3px ${c.primaryGlow}` : 'none',
        opacity: alreadyConnected ? 0.55 : 1,
      }}
    >
      {/* Provider icon */}
      <div style={{
        width: 40, height: 40, borderRadius: 10,
        background: c.surface, border: `1px solid ${c.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: '0 1px 3px rgba(0,0,0,0.06)', flexShrink: 0,
      }}>
        <ProviderIcon size={22} />
      </div>

      {/* Labels */}
      <div style={{ flex: 1 }}>
        <p style={{ fontSize: 14, fontWeight: 650, color: c.text, margin: 0 }}>{name}</p>
        <p style={{ fontSize: 12, color: c.textTertiary, margin: '2px 0 0' }}>{desc}</p>
      </div>

      {/* CTA or connected badge */}
      {alreadyConnected ? (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '3px 10px', borderRadius: 20,
          background: c.successLight, border: `1px solid ${c.successBorder}`,
          fontSize: 12, fontWeight: 600, color: c.success,
        }}>
          <Icons.check size={11} color={c.success} />
          Connected
        </div>
      ) : (
        <span style={{
          fontSize: 12, fontWeight: 650, padding: '5px 12px', borderRadius: 8,
          background: h ? c.primary : c.primaryLight,
          color: h ? 'white' : c.primary,
          border: `1px solid ${h ? 'transparent' : c.primaryBorder}`,
          transition: 'all 0.15s', flexShrink: 0,
        }}>Connect</span>
      )}
    </button>
  );
}

// ── Connecting / OAuth Wait State ─────────────────────────────────
function ConnectingCard({ provider, onCancel }) {
  const ProviderIcon = provider === 'google' ? GoogleIcon : MicrosoftIcon;
  const name = provider === 'google' ? 'Google Calendar' : 'Microsoft 365';

  return (
    <Card style={{ padding: '40px 32px', textAlign: 'center', ...slideUp(0) }}>
      {/* Provider badge with pulse ring */}
      <div style={{ position: 'relative', width: 64, height: 64, margin: '0 auto 24px' }}>
        <div style={{
          position: 'absolute', inset: -4, borderRadius: 18,
          border: `2px solid ${c.primary}`, opacity: 0.25,
          animation: 'pulse 2s ease-in-out infinite',
        }} />
        <div style={{
          width: 64, height: 64, borderRadius: 16,
          background: c.surface, border: `1px solid ${c.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
        }}>
          <ProviderIcon size={30} />
        </div>
      </div>

      {/* Status pill */}
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 16px', borderRadius: 20, background: c.primaryLight, border: `1px solid ${c.primaryBorder}`, marginBottom: 14 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: c.primary, animation: 'pulse 1.2s ease-in-out infinite' }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: c.primary }}>Waiting for authorization…</span>
      </div>

      <p style={{ fontSize: 14, color: c.textSecondary, margin: '0 auto', lineHeight: 1.6, maxWidth: 380 }}>
        A {name} sign-in window should have opened. Complete authorization there, then return here.
      </p>

      <div style={{ marginTop: 24, display: 'flex', justifyContent: 'center', gap: 8 }}>
        <button style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '9px 20px', borderRadius: 9, fontSize: 13, fontWeight: 650,
          background: c.primary, color: 'white', border: 'none', cursor: 'pointer',
        }}>
          <Icons.link size={13} color="white" />
          Re-open window
        </button>
        <button
          onClick={onCancel}
          style={{
            padding: '9px 18px', borderRadius: 9, fontSize: 13, fontWeight: 550,
            background: c.surface, color: c.textSecondary,
            border: `1px solid ${c.border}`, cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    </Card>
  );
}

// ── Add Another Calendar (inline expand) ─────────────────────────
function AddAnotherCard({ googleConnected, microsoftConnected, onConnect, onClose }) {
  const [h, setH] = useState(false);

  return (
    <Card style={{ overflow: 'hidden', animation: 'dropIn 0.2s ease-out' }}>
      <div style={{ padding: '16px 20px 16px', borderBottom: `1px solid ${c.borderSubtle}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <Icons.plus size={14} color={c.primary} />
          <span style={{ fontSize: 13, fontWeight: 650, color: c.text }}>Connect another calendar</span>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, borderRadius: 6 }}>
          <Icons.x size={14} color={c.textTertiary} />
        </button>
      </div>
      <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <ProviderButton provider="google" onClick={() => onConnect('google')} alreadyConnected={googleConnected} />
        <ProviderButton provider="microsoft" onClick={() => onConnect('microsoft')} alreadyConnected={microsoftConnected} />
      </div>
    </Card>
  );
}

// ── Trust Footer ──────────────────────────────────────────────────
function TrustRow() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 28, padding: '16px 0 0' }}>
      {[
        { icon: Icons.eye,    label: 'Read-only access to events' },
        { icon: Icons.shield, label: 'Details never shared with clients' },
        { icon: Icons.zap,    label: 'Syncs every 5 minutes' },
      ].map(({ icon: Ic, label }) => (
        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <Ic size={12} color={c.textTertiary} />
          <span style={{ fontSize: 12, color: c.textTertiary }}>{label}</span>
        </div>
      ))}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN PAGE
// ══════════════════════════════════════════════════════════════════

export default function ExpertCalendarPage() {
  const [viewState, setViewState] = useState('empty');
  const [connectingProvider, setConnectingProvider] = useState('google');
  const [showAddMore, setShowAddMore] = useState(false);

  // Build connections list from demo state
  const getConnections = () => {
    if (viewState === 'connected')     return [GOOGLE_CONNECTION];
    if (viewState === 'two-connected') return [GOOGLE_CONNECTION, MICROSOFT_CONNECTION];
    if (viewState === 'sync-error')    return [ERROR_CONNECTION];
    return [];
  };

  const connections = getConnections();
  const hasConnections = connections.length > 0;
  const googleConnected = connections.some(cn => cn.provider === 'google');
  const microsoftConnected = connections.some(cn => cn.provider === 'microsoft');
  const bothConnected = googleConnected && microsoftConnected;

  const handleConnect = (provider) => {
    setConnectingProvider(provider);
    setViewState('connecting');
  };

  const DEMO_STATES = [
    { key: 'empty',         label: 'Empty' },
    { key: 'connecting',    label: 'Connecting' },
    { key: 'connected',     label: 'Connected' },
    { key: 'two-connected', label: '2 Connected' },
    { key: 'sync-error',    label: 'Sync Error' },
  ];

  return (
    <div style={{
      minHeight: '100vh', background: c.bg,
      fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif",
      padding: '32px 40px',
    }}>
      <style>{keyframes}</style>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />

      {/* State Switcher */}
      <div style={{
        display: 'inline-flex', gap: 4, padding: 4, borderRadius: 10,
        background: c.surfaceSubtle, border: `1px solid ${c.borderSubtle}`,
        marginBottom: 32,
      }}>
        {DEMO_STATES.map(s => (
          <button key={s.key} onClick={() => { setViewState(s.key); setShowAddMore(false); }} style={{
            padding: '6px 14px', borderRadius: 7, fontSize: 12, fontWeight: 550,
            border: 'none', cursor: 'pointer',
            background: viewState === s.key ? c.surface : 'transparent',
            color: viewState === s.key ? c.text : c.textTertiary,
            boxShadow: viewState === s.key ? '0 1px 3px rgba(0,0,0,0.06)' : 'none',
            transition: 'all 0.15s',
          }}>{s.label}</button>
        ))}
      </div>

      <div style={{ maxWidth: 620, margin: '0 auto' }}>
        {/* Page Header */}
        <div style={{ marginBottom: 32, ...slideUp(0) }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <div style={{
              width: 40, height: 40, borderRadius: 11,
              background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(124,58,237,0.15)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Icons.calendar size={20} color={c.accent} />
            </div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: c.text, margin: 0 }}>Calendar</h1>
          </div>
          <p style={{ fontSize: 14, color: c.textSecondary, margin: 0, lineHeight: 1.6 }}>
            Connect your calendar so Balo only shows clients times when you're genuinely free. Your event details are never shared.
          </p>
        </div>

        {/* ── EMPTY STATE ───────────────────────────────── */}
        {viewState === 'empty' && (
          <Card style={{ padding: '24px 24px 20px', ...slideUp(0.05) }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
              <Icons.link size={13} color={c.primary} />
              <span style={{ fontSize: 11, fontWeight: 700, color: c.primary, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                Connect a calendar
              </span>
            </div>
            <p style={{ fontSize: 13, color: c.textSecondary, margin: '0 0 18px', lineHeight: 1.6 }}>
              Balo reads your calendar events to calculate your real availability. Clients will only see open slots, never your event titles or details.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <ProviderButton provider="google" onClick={() => handleConnect('google')} />
              <ProviderButton provider="microsoft" onClick={() => handleConnect('microsoft')} />
            </div>
          </Card>
        )}

        {/* ── CONNECTING STATE ──────────────────────────── */}
        {viewState === 'connecting' && (
          <ConnectingCard provider={connectingProvider} onCancel={() => setViewState('empty')} />
        )}

        {/* ── CONNECTED / TWO-CONNECTED / ERROR ─────────── */}
        {hasConnections && (
          <div>
            {connections.map((conn, i) => (
              <div key={conn.id} style={{ marginBottom: i < connections.length - 1 ? 12 : 0 }}>
                <CalendarCard
                  connection={conn}
                  onDisconnect={() => setViewState('empty')}
                  onToggleCalendar={() => {}}
                />
              </div>
            ))}

            {/* Add another (only when not both connected and no error) */}
            {!bothConnected && viewState !== 'sync-error' && (
              <div style={{ marginTop: 12 }}>
                {showAddMore ? (
                  <AddAnotherCard
                    googleConnected={googleConnected}
                    microsoftConnected={microsoftConnected}
                    onConnect={handleConnect}
                    onClose={() => setShowAddMore(false)}
                  />
                ) : (
                  <AddAnotherButton onClick={() => setShowAddMore(true)} />
                )}
              </div>
            )}
          </div>
        )}

        {/* Trust Row */}
        {viewState !== 'connecting' && <TrustRow />}
      </div>
    </div>
  );
}

// ── Add Another Calendar ghost button ────────────────────────────
function AddAnotherButton({ onClick }) {
  const [h, setH] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
        width: '100%', padding: '12px 16px', borderRadius: 12,
        border: `1.5px dashed ${h ? c.primary : c.border}`,
        background: h ? c.primaryLight : 'transparent',
        fontSize: 13, fontWeight: 550,
        color: h ? c.primary : c.textTertiary,
        cursor: 'pointer', transition: 'all 0.18s',
      }}
    >
      <Icons.plus size={14} color={h ? c.primary : c.textTertiary} />
      Connect another calendar
    </button>
  );
}
