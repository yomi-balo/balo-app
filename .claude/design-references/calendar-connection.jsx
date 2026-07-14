import { useState } from 'react';
import {
  Calendar,
  Clock,
  MoreHorizontal,
  RefreshCw,
  Check,
  ChevronDown,
  Plus,
  AlertTriangle,
  CalendarCheck,
  Info,
  Sparkles,
  X,
} from 'lucide-react';

/**
 * Balo · Design reference — Calendar connection & selection (expert)
 * Covers BAL-232 / BAL-233. Source of truth for CC implementation.
 *
 * SCOPE: the expert's "Calendar" area inside Schedule settings —
 * connecting a calendar (Google / Microsoft), connection states, choosing
 * which calendars block time, and where bookings are written.
 * Apple/iCloud is intentionally parked (see ADR-1021); a friendly note stands
 * in for it. The weekly availability editor (BAL-195) and the client booking
 * flow are separate references.
 *
 * The segmented "preview state" control at the top is a REVIEW AFFORDANCE ONLY
 * — remove it in implementation. Everything below it is real UI.
 */

// Hex approximations of the app's OKLCH design tokens (src/app/globals.css).
// In implementation these are the real Tailwind v4 tokens, NOT literals:
//   bg/surface → --background/--card (white) · subtle → --muted (slate-100) · border → --border
//   ink → --foreground · muted → --muted-foreground · primary → --primary (SOLID blue, no gradient)
//   success/warn/err → --success/--warning/--destructive
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
  successDot: '#16A34A',
  warnInk: '#B45309',
  warnBg: '#FFFBEB',
  warnBorder: '#FDE68A',
  warnDot: '#F59E0B',
  errInk: '#B91C1C',
  errBg: '#FEF2F2',
  errBorder: '#FECACA',
  errDot: '#EF4444',
};

const GoogleLogo = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="#4285F4"
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.74 3.28-8.09Z"
    />
    <path
      fill="#34A853"
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.98.66-2.24 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
    />
    <path
      fill="#FBBC05"
      d="M5.84 14.09a6.6 6.6 0 0 1 0-4.18V7.07H2.18a11 11 0 0 0 0 9.86l3.66-2.84Z"
    />
    <path
      fill="#EA4335"
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z"
    />
  </svg>
);
const MicrosoftLogo = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#F25022" d="M1 1h10.2v10.2H1z" />
    <path fill="#7FBA00" d="M12.8 1H23v10.2H12.8z" />
    <path fill="#00A4EF" d="M1 12.8h10.2V23H1z" />
    <path fill="#FFB900" d="M12.8 12.8H23V23H12.8z" />
  </svg>
);

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

const StatusPill = ({ tone, children }) => {
  const m = {
    success: { bg: t.successBg, ink: t.successInk, dot: t.successDot, bd: t.successBorder },
    warn: { bg: t.warnBg, ink: t.warnInk, dot: t.warnDot, bd: t.warnBorder },
    err: { bg: t.errBg, ink: t.errInk, dot: t.errDot, bd: t.errBorder },
    neutral: { bg: t.primaryLight, ink: t.primary, dot: t.primary, bd: t.primaryBorder },
  }[tone];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        fontWeight: 600,
        color: m.ink,
        background: m.bg,
        border: `1px solid ${m.bd}`,
        padding: '3px 9px',
        borderRadius: 999,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 999, background: m.dot }} />
      {children}
    </span>
  );
};

const Btn = ({ children, variant = 'primary', onClick, icon: Icon, full, size = 'md' }) => {
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
    warn: {
      ...base,
      color: '#fff',
      background: t.warnDot,
      boxShadow: '0 1px 2px rgba(15,23,41,.08)',
    },
  }[variant];
  return (
    <button className="balo-btn" style={v} onClick={onClick}>
      {Icon && <Icon size={size === 'sm' ? 15 : 16} />}
      {children}
    </button>
  );
};

const Card = ({ children, style, hover }) => (
  <div
    className={hover ? 'balo-card balo-hover' : 'balo-card'}
    style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 14, ...style }}
  >
    {children}
  </div>
);

const Toggle = ({ on, onChange, disabled }) => (
  <button
    role="switch"
    aria-checked={on}
    disabled={disabled}
    onClick={() => onChange(!on)}
    style={{
      width: 38,
      height: 22,
      borderRadius: 999,
      padding: 2,
      border: 'none',
      cursor: disabled ? 'not-allowed' : 'pointer',
      background: on ? t.primary : '#CBD5E1',
      opacity: disabled ? 0.45 : 1,
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

/* ---------------- Provider cards (connect entry point) ---------------- */
const ProviderCard = ({ logo, name, sub }) => (
  <Card hover style={{ padding: 18, display: 'flex', alignItems: 'center', gap: 14 }}>
    <div
      style={{
        width: 42,
        height: 42,
        borderRadius: 11,
        border: `1px solid ${t.borderSubtle}`,
        display: 'grid',
        placeItems: 'center',
        flexShrink: 0,
      }}
    >
      {logo}
    </div>
    <div style={{ minWidth: 0, flex: 1 }}>
      <div style={{ fontWeight: 600, color: t.ink, fontSize: 15 }}>{name}</div>
      <div style={{ color: t.muted, fontSize: 13, marginTop: 1 }}>{sub}</div>
    </div>
    <Btn size="sm">Connect</Btn>
  </Card>
);

/* ---------------- Connected account header card ---------------- */
const AccountCard = ({ state }) => {
  const [menu, setMenu] = useState(false);
  const pill =
    state === 'syncing' ? (
      <StatusPill tone="neutral">Setting up</StatusPill>
    ) : state === 'reconnect' ? (
      <StatusPill tone="warn">Reconnect needed</StatusPill>
    ) : (
      <StatusPill tone="success">Connected</StatusPill>
    );
  return (
    <Card style={{ padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div
          style={{
            width: 42,
            height: 42,
            borderRadius: 11,
            border: `1px solid ${t.borderSubtle}`,
            display: 'grid',
            placeItems: 'center',
            flexShrink: 0,
          }}
        >
          <GoogleLogo />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, color: t.ink, fontSize: 15 }}>
              jordan@brightpath.co
            </span>
            {pill}
          </div>
          <div
            style={{
              color: t.muted,
              fontSize: 13,
              marginTop: 2,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {state === 'syncing' ? (
              <>
                <RefreshCw size={13} className="balo-spin" /> Reading your calendars…
              </>
            ) : state === 'reconnect' ? (
              <>Last synced 3 days ago</>
            ) : (
              <>
                <Clock size={13} /> Synced just now · Google Calendar
              </>
            )}
          </div>
        </div>
        <div style={{ position: 'relative' }}>
          <button
            className="balo-icon-btn"
            onClick={() => setMenu((m) => !m)}
            aria-label="Calendar options"
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
            <MoreHorizontal size={17} />
          </button>
          {menu && (
            <div
              style={{
                position: 'absolute',
                right: 0,
                top: 40,
                background: '#fff',
                border: `1px solid ${t.border}`,
                borderRadius: 11,
                boxShadow: '0 12px 32px -12px rgba(15,23,41,.2)',
                padding: 6,
                width: 168,
                zIndex: 5,
              }}
            >
              {['Reconnect', 'Disconnect'].map((o, i) => (
                <button
                  key={o}
                  className="balo-menu-item"
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '8px 10px',
                    borderRadius: 7,
                    border: 'none',
                    background: 'none',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    fontSize: 13.5,
                    color: i === 1 ? t.errInk : t.ink2,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 9,
                  }}
                >
                  {i === 0 ? <RefreshCw size={14} /> : <X size={14} />}
                  {o}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {state === 'reconnect' && (
        <div
          style={{
            marginTop: 14,
            padding: 14,
            borderRadius: 11,
            background: t.warnBg,
            border: `1px solid ${t.warnBorder}`,
            display: 'flex',
            gap: 11,
          }}
        >
          <AlertTriangle size={17} color={t.warnInk} style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ flex: 1 }}>
            <div style={{ color: t.warnInk, fontSize: 13.5, lineHeight: 1.5 }}>
              We've lost access to this calendar — this usually happens after a password change or
              when calendar access is turned off. Your current availability still shows, but new
              changes won't sync until you reconnect.
            </div>
            <div style={{ marginTop: 11 }}>
              <Btn size="sm" variant="warn" icon={RefreshCw}>
                Reconnect
              </Btn>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
};

/* ---------------- Calendars: busy sources + book-into ---------------- */
const CALS = [
  {
    id: 'primary',
    name: 'Jordan Ellis',
    color: '#2563EB',
    primary: true,
    readOnly: false,
    busy: true,
  },
  {
    id: 'work',
    name: 'Client Work',
    color: '#7C3AED',
    primary: false,
    readOnly: false,
    busy: true,
  },
  {
    id: 'personal',
    name: 'Personal',
    color: '#10B981',
    primary: false,
    readOnly: false,
    busy: true,
  },
  {
    id: 'holidays',
    name: 'Holidays in United States',
    color: '#94A3B8',
    primary: false,
    readOnly: true,
    busy: false,
  },
];

const CalendarsPanel = ({ dimmed }) => {
  const [cals, setCals] = useState(CALS);
  const writable = cals.filter((c) => !c.readOnly);
  // Default bookings to the detected primary calendar; fall back to the first writable one.
  const primaryCal =
    CALS.find((c) => c.primary && !c.readOnly) || CALS.filter((c) => !c.readOnly)[0];
  const [bookInto, setBookInto] = useState(primaryCal ? primaryCal.id : '');
  const toggle = (id) =>
    setCals((cs) => cs.map((c) => (c.id === id ? { ...c, busy: !c.busy } : c)));

  return (
    <div style={{ opacity: dimmed ? 0.5 : 1, pointerEvents: dimmed ? 'none' : 'auto' }}>
      <Card style={{ padding: 18, marginTop: 14 }}>
        <SectionLabel icon={Calendar}>Busy calendars</SectionLabel>
        <div style={{ color: t.muted, fontSize: 13.5, lineHeight: 1.5, marginBottom: 14 }}>
          When one of these has an event, that time won't be offered to clients.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {cals.map((c, i) => (
            <div
              key={c.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 0',
                borderTop: i ? `1px solid ${t.borderSubtle}` : 'none',
              }}
            >
              <span
                style={{
                  width: 11,
                  height: 11,
                  borderRadius: 4,
                  background: c.color,
                  flexShrink: 0,
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 500, color: t.ink, fontSize: 14 }}>{c.name}</span>
                  {c.primary && <Tag>Primary</Tag>}
                  {c.readOnly && <Tag>View-only</Tag>}
                </div>
              </div>
              <Toggle on={c.busy} onChange={() => toggle(c.id)} />
            </div>
          ))}
        </div>
      </Card>

      <Card style={{ padding: 18, marginTop: 14 }}>
        <SectionLabel icon={CalendarCheck}>Where bookings go</SectionLabel>
        <div style={{ color: t.muted, fontSize: 13.5, lineHeight: 1.5, marginBottom: 14 }}>
          Confirmed consultations are added to this calendar. We start with your primary one —
          change it any time.
        </div>
        <div style={{ position: 'relative', maxWidth: 340 }}>
          <select
            value={bookInto}
            onChange={(e) => setBookInto(e.target.value)}
            style={{
              width: '100%',
              appearance: 'none',
              WebkitAppearance: 'none',
              padding: '11px 38px 11px 13px',
              borderRadius: 10,
              border: `1px solid ${t.border}`,
              background: '#fff',
              fontFamily: 'inherit',
              fontSize: 14,
              color: t.ink,
              cursor: 'pointer',
            }}
          >
            {writable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.primary ? ' (Primary)' : ''}
              </option>
            ))}
          </select>
          <ChevronDown
            size={17}
            color={t.muted}
            style={{ position: 'absolute', right: 12, top: 12, pointerEvents: 'none' }}
          />
        </div>
      </Card>
    </div>
  );
};

const Tag = ({ children }) => (
  <span
    style={{
      fontSize: 11,
      fontWeight: 600,
      color: t.muted,
      background: t.subtle,
      border: `1px solid ${t.borderSubtle}`,
      padding: '2px 7px',
      borderRadius: 6,
    }}
  >
    {children}
  </span>
);

/* ---------------- Add-another + Apple note ---------------- */
const AddAnother = () => (
  <button
    className="balo-hover"
    style={{
      width: '100%',
      marginTop: 14,
      padding: 14,
      borderRadius: 12,
      border: `1px dashed ${t.primaryBorder}`,
      background: t.primaryLight,
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 9,
      color: t.primary,
      fontWeight: 600,
      fontSize: 13.5,
      fontFamily: 'inherit',
    }}
  >
    <Plus size={16} /> Connect another calendar
    <span style={{ display: 'inline-flex', gap: 5, marginLeft: 2 }}>
      <GoogleLogo size={16} />
      <MicrosoftLogo size={16} />
    </span>
  </button>
);

const AppleNote = () => (
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
      On iCloud? Apple calendar sync is coming soon. In the meantime you can set your weekly
      availability by hand — clients can still book you.
    </span>
  </div>
);

/* ---------------- Skeleton (loading) ---------------- */
const Sk = ({ w, h = 14, r = 8, style }) => (
  <div className="balo-shimmer" style={{ width: w, height: h, borderRadius: r, ...style }} />
);
const LoadingView = () => (
  <>
    <Card style={{ padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <Sk w={42} h={42} r={11} />
        <div style={{ flex: 1 }}>
          <Sk w="55%" />
          <Sk w="35%" h={11} style={{ marginTop: 9 }} />
        </div>
        <Sk w={34} h={34} r={9} />
      </div>
    </Card>
    <Card style={{ padding: 18, marginTop: 14 }}>
      <Sk w={110} h={11} />
      <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 18 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Sk w={11} h={11} r={4} />
            <Sk w={`${45 + i * 12}%`} />
            <div style={{ flex: 1 }} />
            <Sk w={38} h={22} r={999} />
          </div>
        ))}
      </div>
    </Card>
  </>
);

/* ---------------- Error ---------------- */
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
    <div style={{ fontWeight: 600, color: t.ink, fontSize: 16 }}>
      We couldn't load your calendars
    </div>
    <div
      style={{
        color: t.muted,
        fontSize: 14,
        lineHeight: 1.55,
        maxWidth: 340,
        margin: '8px auto 18px',
      }}
    >
      Something went wrong on our end. Try again in a moment — if it keeps happening, we're already
      looking into it.
    </div>
    <Btn icon={RefreshCw}>Try again</Btn>
  </Card>
);

/* ---------------- Empty ---------------- */
const EmptyView = () => (
  <>
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
        <Calendar size={26} color={t.primary} />
      </div>
      <div style={{ fontWeight: 600, color: t.ink, fontSize: 18 }}>Connect your calendar</div>
      <div
        style={{
          color: t.muted,
          fontSize: 14,
          lineHeight: 1.55,
          maxWidth: 380,
          margin: '8px auto 0',
        }}
      >
        Sync your work calendar so clients only see the times you're actually free — and confirmed
        bookings land straight on your schedule.
      </div>
    </Card>
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: 14,
        marginTop: 14,
      }}
    >
      <ProviderCard logo={<GoogleLogo />} name="Google Calendar" sub="Google Workspace or Gmail" />
      <ProviderCard
        logo={<MicrosoftLogo />}
        name="Microsoft Outlook"
        sub="Microsoft 365 or Outlook.com"
      />
    </div>
    <AppleNote />
  </>
);

/* ---------------- Connected (with success banner) ---------------- */
const ConnectedView = ({ syncing, reconnect }) => {
  const [banner, setBanner] = useState(!syncing && !reconnect);
  return (
    <>
      {banner && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 11,
            padding: '12px 14px',
            borderRadius: 12,
            background: t.successBg,
            border: `1px solid ${t.successBorder}`,
            marginBottom: 14,
          }}
        >
          <Sparkles size={17} color={t.successInk} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1, fontSize: 13.5, color: t.successInk, lineHeight: 1.5 }}>
            You're all set — clients will now only see times you're free.
          </span>
          <button
            onClick={() => setBanner(false)}
            aria-label="Dismiss"
            style={{
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              color: t.successInk,
              display: 'grid',
              placeItems: 'center',
              padding: 2,
            }}
          >
            <X size={15} />
          </button>
        </div>
      )}
      <AccountCard state={syncing ? 'syncing' : reconnect ? 'reconnect' : 'active'} />
      {syncing ? (
        <Card style={{ padding: 18, marginTop: 14 }}>
          <SectionLabel icon={Calendar}>Busy calendars</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18, marginTop: 6 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Sk w={11} h={11} r={4} />
                <Sk w={`${45 + i * 12}%`} />
                <div style={{ flex: 1 }} />
                <Sk w={38} h={22} r={999} />
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <>
          <CalendarsPanel dimmed={reconnect} />
          {!reconnect && <AddAnother />}
        </>
      )}
      {!syncing && <AppleNote />}
    </>
  );
};

/* ---------------- Shell + preview switcher ---------------- */
const STATES = [
  { id: 'empty', label: 'Empty' },
  { id: 'loading', label: 'Loading' },
  { id: 'syncing', label: 'Syncing' },
  { id: 'connected', label: 'Connected' },
  { id: 'reconnect', label: 'Reconnect' },
  { id: 'error', label: 'Error' },
];

export default function CalendarConnection() {
  const [view, setView] = useState('connected');
  return (
    <div
      className="balo-root"
      style={{ background: t.bg, minHeight: '100vh', padding: '28px 20px 64px' }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap');
        .balo-root, .balo-root * { box-sizing:border-box; font-family:'Geist', ui-sans-serif, system-ui, -apple-system, sans-serif; }
        .balo-hover { transition: box-shadow .2s, border-color .2s, transform .2s; }
        .balo-hover:hover { box-shadow: 0 8px 24px -14px rgba(37,99,235,.28); border-color:#BFDBFE; transform: translateY(-1px); }
        .balo-btn:hover { filter:brightness(1.03); transform:translateY(-1px); }
        .balo-btn:active { transform:translateY(0); }
        .balo-icon-btn:hover { background:#F1F5F9; }
        .balo-menu-item:hover { background:#F1F5F9; }
        @keyframes balo-spin { to { transform:rotate(360deg) } }
        .balo-spin { animation: balo-spin 1s linear infinite; }
        .balo-shimmer { background:linear-gradient(90deg,#EEF2F6 25%,#E2E8F0 37%,#EEF2F6 63%); background-size:400% 100%; animation:balo-shimmer 1.4s ease infinite; }
        @keyframes balo-shimmer { 0%{background-position:100% 0} 100%{background-position:0 0} }
        @media (prefers-reduced-motion: reduce) { .balo-spin,.balo-shimmer { animation:none } .balo-btn:hover,.balo-hover:hover { transform:none } }
      `}</style>

      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        {/* PREVIEW-ONLY control — remove in implementation */}
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

        {/* Real header */}
        <div style={{ marginBottom: 20 }}>
          <SectionLabel icon={Calendar}>Schedule</SectionLabel>
          <h1
            style={{
              fontSize: 24,
              fontWeight: 700,
              color: t.ink,
              margin: 0,
              letterSpacing: '-.01em',
            }}
          >
            Calendar
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
            Connect a calendar to keep your availability accurate and send confirmed bookings
            straight to your schedule.
          </p>
        </div>

        {view === 'empty' && <EmptyView />}
        {view === 'loading' && <LoadingView />}
        {view === 'error' && <ErrorView />}
        {view === 'connected' && <ConnectedView />}
        {view === 'syncing' && <ConnectedView syncing />}
        {view === 'reconnect' && <ConnectedView reconnect />}
      </div>
    </div>
  );
}
