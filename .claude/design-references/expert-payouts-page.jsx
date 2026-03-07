import { useState, useEffect, useRef } from 'react';

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
  cyan: '#0891B2',
  cyanLight: '#ECFEFF',
  emerald: '#059669',
  pink: '#DB2777',
  gradient: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
  gradientSubtle: 'linear-gradient(135deg, #EFF6FF 0%, #F5F3FF 100%)',
  gradientWarm: 'linear-gradient(135deg, #059669 0%, #0891B2 100%)',
};

// ── Icons ─────────────────────────────────────────────────────────
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
  check: (p) => <Icon {...p} d="M20 6L9 17l-5-5" />,
  creditCard: (p) => (
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
      <rect x="1" y="4" width="22" height="16" rx="2" />
      <path d="M1 10h22" />
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
  shield: (p) => <Icon {...p} d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  lock: (p) => (
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
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0110 0v4" />
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
  chevDown: (p) => <Icon {...p} d="M6 9l6 6 6-6" />,
  chevRight: (p) => <Icon {...p} d="M9 18l6-6-6-6" />,
  x: (p) => <Icon {...p} d="M18 6L6 18M6 6l12 12" />,
  edit: (p) => (
    <Icon
      {...p}
      d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"
    />
  ),
  zap: (p) => (
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
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
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

// ── Animations ────────────────────────────────────────────────────
const keyframes = `
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
@keyframes scaleIn { from { transform: scale(0.96); opacity: 0; } to { transform: scale(1); opacity: 1; } }
@keyframes shimmer {
  0% { background-position: -400px 0; }
  100% { background-position: 400px 0; }
}
@keyframes checkPop { 0% { transform: scale(0); } 60% { transform: scale(1.3); } 100% { transform: scale(1); } }
@keyframes dropIn { from { opacity: 0; transform: translateY(-8px) scaleY(0.95); transform-origin: top; } to { opacity: 1; transform: translateY(0) scaleY(1); } }
`;

const slideUp = (delay = 0) => ({
  animation: `slideUp 0.4s ease-out ${delay}s both`,
});

// ── Shared Components ─────────────────────────────────────────────

function Card({ children, style: xs }) {
  return (
    <div
      style={{
        background: c.surface,
        borderRadius: 16,
        border: `1px solid ${c.border}`,
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        ...xs,
      }}
    >
      {children}
    </div>
  );
}

function SectionLabel({ children, icon: IconComp, color = c.textTertiary }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 16 }}>
      <IconComp size={14} color={color} />
      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          color,
          textTransform: 'uppercase',
          letterSpacing: '0.07em',
        }}
      >
        {children}
      </span>
    </div>
  );
}

function Button({ children, onClick, variant = 'primary', style: xs, disabled }) {
  const [h, setH] = useState(false);
  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 22px',
    borderRadius: 10,
    fontSize: 14,
    fontWeight: 650,
    cursor: disabled ? 'not-allowed' : 'pointer',
    border: 'none',
    transition: 'all 0.2s',
    opacity: disabled ? 0.5 : 1,
  };
  const styles = {
    primary: {
      background: h ? c.primaryDark : c.primary,
      color: 'white',
      boxShadow: h ? `0 4px 14px ${c.primaryGlow}` : `0 2px 8px ${c.primaryGlow}`,
    },
    ghost: {
      background: h ? c.surfaceSubtle : 'transparent',
      color: c.textSecondary,
      border: `1px solid ${c.border}`,
    },
  };
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      disabled={disabled}
      style={{ ...base, ...styles[variant], ...xs }}
    >
      {children}
    </button>
  );
}

function Badge({ children, color, bg, border }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '3px 10px',
        borderRadius: 20,
        fontSize: 12,
        fontWeight: 600,
        color,
        background: bg,
        border: `1px solid ${border}`,
      }}
    >
      {children}
    </span>
  );
}

// ── Country data ──────────────────────────────────────────────────

const POPULAR_COUNTRIES = [
  { code: 'AU', name: 'Australia', flag: '🇦🇺' },
  { code: 'NZ', name: 'New Zealand', flag: '🇳🇿' },
  { code: 'US', name: 'United States', flag: '🇺🇸' },
  { code: 'GB', name: 'United Kingdom', flag: '🇬🇧' },
  { code: 'CA', name: 'Canada', flag: '🇨🇦' },
  { code: 'SG', name: 'Singapore', flag: '🇸🇬' },
];

const ALL_COUNTRIES = [
  { code: 'AR', name: 'Argentina', flag: '🇦🇷' },
  { code: 'AU', name: 'Australia', flag: '🇦🇺' },
  { code: 'AT', name: 'Austria', flag: '🇦🇹' },
  { code: 'BE', name: 'Belgium', flag: '🇧🇪' },
  { code: 'BR', name: 'Brazil', flag: '🇧🇷' },
  { code: 'CA', name: 'Canada', flag: '🇨🇦' },
  { code: 'CN', name: 'China', flag: '🇨🇳' },
  { code: 'DK', name: 'Denmark', flag: '🇩🇰' },
  { code: 'FI', name: 'Finland', flag: '🇫🇮' },
  { code: 'FR', name: 'France', flag: '🇫🇷' },
  { code: 'DE', name: 'Germany', flag: '🇩🇪' },
  { code: 'HK', name: 'Hong Kong', flag: '🇭🇰' },
  { code: 'IN', name: 'India', flag: '🇮🇳' },
  { code: 'ID', name: 'Indonesia', flag: '🇮🇩' },
  { code: 'IE', name: 'Ireland', flag: '🇮🇪' },
  { code: 'IT', name: 'Italy', flag: '🇮🇹' },
  { code: 'JP', name: 'Japan', flag: '🇯🇵' },
  { code: 'MY', name: 'Malaysia', flag: '🇲🇾' },
  { code: 'MX', name: 'Mexico', flag: '🇲🇽' },
  { code: 'NL', name: 'Netherlands', flag: '🇳🇱' },
  { code: 'NZ', name: 'New Zealand', flag: '🇳🇿' },
  { code: 'NO', name: 'Norway', flag: '🇳🇴' },
  { code: 'PH', name: 'Philippines', flag: '🇵🇭' },
  { code: 'PL', name: 'Poland', flag: '🇵🇱' },
  { code: 'PT', name: 'Portugal', flag: '🇵🇹' },
  { code: 'SG', name: 'Singapore', flag: '🇸🇬' },
  { code: 'ZA', name: 'South Africa', flag: '🇿🇦' },
  { code: 'KR', name: 'South Korea', flag: '🇰🇷' },
  { code: 'ES', name: 'Spain', flag: '🇪🇸' },
  { code: 'SE', name: 'Sweden', flag: '🇸🇪' },
  { code: 'CH', name: 'Switzerland', flag: '🇨🇭' },
  { code: 'TW', name: 'Taiwan', flag: '🇹🇼' },
  { code: 'TH', name: 'Thailand', flag: '🇹🇭' },
  { code: 'AE', name: 'UAE', flag: '🇦🇪' },
  { code: 'GB', name: 'United Kingdom', flag: '🇬🇧' },
  { code: 'US', name: 'United States', flag: '🇺🇸' },
  { code: 'VN', name: 'Vietnam', flag: '🇻🇳' },
];

// ── Mock Airwallex schema by country ─────────────────────────────
const SCHEMAS = {
  AU: {
    methods: ['LOCAL'],
    fields: [
      { key: 'account_name', label: 'Account Name', type: 'text', required: true },
      {
        key: 'bsb_number',
        label: 'BSB Number',
        type: 'text',
        required: true,
        hint: '6 digits — e.g. 062-000',
      },
      {
        key: 'account_number',
        label: 'Account Number',
        type: 'text',
        required: true,
        hint: '6–10 digits',
      },
    ],
  },
  US: {
    methods: ['LOCAL', 'SWIFT'],
    fields: [
      { key: 'account_name', label: 'Account Holder Name', type: 'text', required: true },
      {
        key: 'routing_number',
        label: 'Routing Number (ABA)',
        type: 'text',
        required: true,
        hint: '9 digits',
      },
      { key: 'account_number', label: 'Account Number', type: 'text', required: true },
      {
        key: 'account_type',
        label: 'Account Type',
        type: 'enum',
        required: true,
        options: [
          { value: 'checking', label: 'Checking' },
          { value: 'savings', label: 'Savings' },
        ],
      },
    ],
  },
  GB: {
    methods: ['LOCAL', 'SWIFT'],
    fields: [
      { key: 'account_name', label: 'Account Name', type: 'text', required: true },
      {
        key: 'sort_code',
        label: 'Sort Code',
        type: 'text',
        required: true,
        hint: '6 digits — e.g. 20-00-00',
      },
      {
        key: 'account_number',
        label: 'Account Number',
        type: 'text',
        required: true,
        hint: '8 digits',
      },
    ],
  },
  DE: {
    methods: ['LOCAL'],
    fields: [
      { key: 'account_name', label: 'Account Holder', type: 'text', required: true },
      {
        key: 'iban',
        label: 'IBAN',
        type: 'text',
        required: true,
        hint: 'e.g. DE89 3704 0044 0532 0130 00',
        wide: true,
      },
      {
        key: 'swift_bic',
        label: 'BIC / SWIFT Code',
        type: 'text',
        required: false,
        hint: '8 or 11 characters',
      },
    ],
  },
  SG: {
    methods: ['LOCAL', 'SWIFT'],
    fields: [
      { key: 'account_name', label: 'Account Name', type: 'text', required: true },
      {
        key: 'bank_code',
        label: 'Bank Code',
        type: 'enum',
        required: true,
        options: [
          { value: '7171', label: 'DBS Bank (7171)' },
          { value: '7339', label: 'OCBC Bank (7339)' },
          { value: '7375', label: 'UOB Bank (7375)' },
          { value: '9496', label: 'Standard Chartered (9496)' },
        ],
      },
      { key: 'account_number', label: 'Account Number', type: 'text', required: true },
    ],
  },
};

const DEFAULT_SCHEMA = SCHEMAS['AU'];

// ── Country Combobox ──────────────────────────────────────────────

function CountryCombobox({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef(null);
  const containerRef = useRef(null);

  const selected = ALL_COUNTRIES.find((c) => c.code === value) || POPULAR_COUNTRIES[0];

  const filteredPopular = query ? [] : POPULAR_COUNTRIES;

  const filteredAll = query
    ? ALL_COUNTRIES.filter(
        (c) =>
          c.name.toLowerCase().includes(query.toLowerCase()) ||
          c.code.toLowerCase().includes(query.toLowerCase())
      )
    : ALL_COUNTRIES.filter((c) => !POPULAR_COUNTRIES.find((p) => p.code === c.code));

  function highlight(text, q) {
    if (!q) return text;
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark
          style={{
            background: `${c.primary}20`,
            color: c.primary,
            borderRadius: 2,
            padding: '0 1px',
          }}
        >
          {text.slice(idx, idx + q.length)}
        </mark>
        {text.slice(idx + q.length)}
      </>
    );
  }

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  useEffect(() => {
    function handleClick(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function select(code) {
    onChange(code);
    setOpen(false);
    setQuery('');
  }

  const CountryOption = ({ country }) => {
    const [h, setH] = useState(false);
    const isSelected = country.code === value;
    return (
      <div
        onMouseEnter={() => setH(true)}
        onMouseLeave={() => setH(false)}
        onClick={() => select(country.code)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 12px',
          borderRadius: 8,
          cursor: 'pointer',
          background: isSelected ? c.primaryLight : h ? c.surfaceSubtle : 'transparent',
          transition: 'background 0.12s',
        }}
      >
        <span style={{ fontSize: 18, lineHeight: 1 }}>{country.flag}</span>
        <span
          style={{
            fontSize: 14,
            color: isSelected ? c.primary : c.text,
            fontWeight: isSelected ? 600 : 400,
            flex: 1,
          }}
        >
          {highlight(country.name, query)}
        </span>
        <span style={{ fontSize: 11, color: c.textTertiary, fontFamily: 'monospace' }}>
          {country.code}
        </span>
        {isSelected && <Icons.check size={14} color={c.primary} />}
      </div>
    );
  };

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      {/* Trigger */}
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
        <span style={{ fontSize: 20 }}>{selected.flag}</span>
        <span style={{ fontSize: 14, fontWeight: 500, color: c.text, flex: 1 }}>
          {selected.name}
        </span>
        <span
          style={{ fontSize: 11, color: c.textTertiary, fontFamily: 'monospace', marginRight: 4 }}
        >
          {selected.code}
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

      {/* Dropdown */}
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            right: 0,
            background: c.surface,
            borderRadius: 12,
            border: `1px solid ${c.border}`,
            boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
            zIndex: 50,
            overflow: 'hidden',
            animation: 'dropIn 0.18s ease-out both',
          }}
        >
          {/* Search input */}
          <div style={{ padding: '10px 10px 6px', borderBottom: `1px solid ${c.borderSubtle}` }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 12px',
                borderRadius: 8,
                background: c.surfaceSubtle,
                border: `1px solid ${c.borderSubtle}`,
              }}
            >
              <Icons.search size={14} color={c.textTertiary} />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder='Search by country or code (e.g. "DE")'
                style={{
                  flex: 1,
                  fontSize: 13,
                  color: c.text,
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                }}
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 0,
                    display: 'flex',
                  }}
                >
                  <Icons.x size={12} color={c.textTertiary} />
                </button>
              )}
            </div>
          </div>

          {/* Results */}
          <div style={{ maxHeight: 280, overflowY: 'auto', padding: '6px 8px 8px' }}>
            {query === '' ? (
              <>
                <p
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: c.textTertiary,
                    textTransform: 'uppercase',
                    letterSpacing: '0.07em',
                    padding: '4px 12px 2px',
                  }}
                >
                  Popular
                </p>
                {filteredPopular.map((country) => (
                  <CountryOption key={country.code} country={country} />
                ))}
                <div style={{ height: 1, background: c.borderSubtle, margin: '6px 12px' }} />
                <p
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: c.textTertiary,
                    textTransform: 'uppercase',
                    letterSpacing: '0.07em',
                    padding: '4px 12px 2px',
                  }}
                >
                  All Countries
                </p>
                {filteredAll.map((country) => (
                  <CountryOption key={country.code} country={country} />
                ))}
              </>
            ) : filteredAll.length > 0 ? (
              filteredAll.map((country) => <CountryOption key={country.code} country={country} />)
            ) : (
              <div style={{ padding: '24px 16px', textAlign: 'center' }}>
                <p style={{ fontSize: 13, color: c.textSecondary, margin: 0 }}>
                  No results for "{query}"
                </p>
                <p style={{ fontSize: 12, color: c.textTertiary, margin: '4px 0 0' }}>
                  Try the ISO code (e.g. DE for Germany)
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Schema Loading Skeleton ───────────────────────────────────────

function FieldSkeleton({ wide }) {
  return (
    <div style={{ gridColumn: wide ? '1 / -1' : 'span 1' }}>
      <div
        style={{
          height: 12,
          width: '40%',
          borderRadius: 4,
          background: 'linear-gradient(90deg, #E0E4EB 25%, #EEF1F6 50%, #E0E4EB 75%)',
          backgroundSize: '400px 100%',
          animation: 'shimmer 1.4s ease-in-out infinite',
          marginBottom: 8,
        }}
      />
      <div
        style={{
          height: 42,
          borderRadius: 8,
          background: 'linear-gradient(90deg, #E0E4EB 25%, #EEF1F6 50%, #E0E4EB 75%)',
          backgroundSize: '400px 100%',
          animation: 'shimmer 1.4s ease-in-out infinite',
        }}
      />
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      <FieldSkeleton />
      <FieldSkeleton />
      <FieldSkeleton />
      <FieldSkeleton />
    </div>
  );
}

// ── Method Pill Selector ──────────────────────────────────────────

function MethodPills({ methods, value, onChange }) {
  if (methods.length <= 1) return null;
  const labels = { LOCAL: 'Local Transfer', SWIFT: 'SWIFT / International' };
  const descriptions = { LOCAL: 'Faster · Lower fees', SWIFT: 'Works globally' };
  return (
    <div style={{ marginBottom: 24 }}>
      <SectionLabel icon={Icons.globe} color={c.primary}>
        Transfer Method
      </SectionLabel>
      <div style={{ display: 'flex', gap: 10 }}>
        {methods.map((m) => {
          const active = value === m;
          return (
            <button
              key={m}
              onClick={() => onChange(m)}
              style={{
                flex: 1,
                padding: '12px 16px',
                borderRadius: 10,
                cursor: 'pointer',
                border: `1.5px solid ${active ? c.primary : c.border}`,
                background: active ? c.primaryLight : c.surface,
                textAlign: 'left',
                transition: 'all 0.2s',
                boxShadow: active ? `0 0 0 3px ${c.primaryGlow}` : 'none',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 2,
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 650, color: active ? c.primary : c.text }}>
                  {labels[m]}
                </span>
                {active && (
                  <div
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: '50%',
                      background: c.gradient,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Icons.check size={10} color="white" />
                  </div>
                )}
              </div>
              <span style={{ fontSize: 11, color: active ? c.primary : c.textTertiary }}>
                {descriptions[m]}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Dynamic Form Fields ───────────────────────────────────────────

function DynamicField({ field, value, onChange }) {
  const [focused, setFocused] = useState(false);

  const inputStyle = {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 8,
    fontSize: 14,
    border: `1px solid ${focused ? c.primary : c.border}`,
    boxShadow: focused ? `0 0 0 3px ${c.primaryGlow}` : 'none',
    outline: 'none',
    background: c.surface,
    color: c.text,
    transition: 'all 0.2s',
    boxSizing: 'border-box',
  };

  return (
    <div style={{ gridColumn: field.wide ? '1 / -1' : 'span 1' }}>
      {/* Label row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <label style={{ fontSize: 13, fontWeight: 550, color: c.text }}>{field.label}</label>
        {!field.required && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              padding: '1px 6px',
              borderRadius: 4,
              background: c.surfaceSubtle,
              color: c.textTertiary,
              border: `1px solid ${c.borderSubtle}`,
            }}
          >
            optional
          </span>
        )}
      </div>

      {field.type === 'enum' ? (
        <div style={{ position: 'relative' }}>
          <select
            value={value || ''}
            onChange={(e) => onChange(field.key, e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            style={{
              ...inputStyle,
              appearance: 'none',
              paddingRight: 36,
              color: value ? c.text : c.textTertiary,
              cursor: 'pointer',
            }}
          >
            <option value="" disabled>
              Select {field.label.toLowerCase()}...
            </option>
            {field.options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <Icons.chevDown
            size={14}
            color={c.textTertiary}
            style={{
              position: 'absolute',
              right: 12,
              top: '50%',
              transform: 'translateY(-50%)',
              pointerEvents: 'none',
            }}
          />
        </div>
      ) : (
        <input
          type="text"
          value={value || ''}
          onChange={(e) => onChange(field.key, e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={field.hint || `Enter ${field.label.toLowerCase()}`}
          style={inputStyle}
        />
      )}

      {field.hint && field.type !== 'enum' && (
        <p style={{ fontSize: 11, color: c.textTertiary, margin: '4px 0 0' }}>{field.hint}</p>
      )}
    </div>
  );
}

// ── Saved / Masked State ──────────────────────────────────────────

function SavedState({ country, method, verified, onEdit }) {
  const countryInfo = ALL_COUNTRIES.find((c) => c.code === country) || {
    name: country,
    flag: '🌍',
    code: country,
  };

  return (
    <Card style={{ overflow: 'hidden', ...slideUp(0.05) }}>
      {/* Header bar */}
      <div
        style={{
          padding: '16px 24px',
          background: verified ? c.successLight : c.gradientSubtle,
          borderBottom: `1px solid ${verified ? c.successBorder : c.accentBorder}40`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {verified ? (
            <>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: c.success + '15',
                  border: `1px solid ${c.success}30`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icons.shield size={14} color={c.success} />
              </div>
              <div>
                <p style={{ fontSize: 13, fontWeight: 700, color: c.success, margin: 0 }}>
                  Verified by Balo
                </p>
                <p style={{ fontSize: 11, color: c.success + 'AA', margin: 0 }}>
                  Your payout details have been verified
                </p>
              </div>
            </>
          ) : (
            <>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: c.accent + '12',
                  border: `1px solid ${c.accent}22`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icons.creditCard size={14} color={c.accent} />
              </div>
              <div>
                <p style={{ fontSize: 13, fontWeight: 700, color: c.accent, margin: 0 }}>
                  Payout Details Saved
                </p>
                <p style={{ fontSize: 11, color: c.textTertiary, margin: 0 }}>
                  Pending verification by Balo admin
                </p>
              </div>
            </>
          )}
        </div>

        <button
          onClick={onEdit}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 14px',
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 550,
            background: 'white',
            border: `1px solid ${c.border}`,
            cursor: 'pointer',
            color: c.textSecondary,
          }}
        >
          <Icons.edit size={13} color={c.textSecondary} /> Edit
        </button>
      </div>

      {/* Fields */}
      <div style={{ padding: '20px 24px' }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          <Badge color={c.primary} bg={c.primaryLight} border={c.primaryBorder}>
            <span style={{ fontSize: 16 }}>{countryInfo.flag}</span>
            {countryInfo.name}
          </Badge>
          {method && (
            <Badge color={c.accent} bg={c.accentLight} border={c.accentBorder}>
              {method === 'LOCAL' ? 'Local Transfer' : 'SWIFT'}
            </Badge>
          )}
        </div>

        {/* Masked fields */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          {[
            { label: 'Account Name', value: 'Jane Doe' },
            { label: 'BSB Number', value: '•••-•••' },
            { label: 'Account Number', value: '•••• •••• 4521' },
          ].map((f) => (
            <div key={f.label}>
              <p
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: c.textTertiary,
                  margin: '0 0 4px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                {f.label}
              </p>
              <p
                style={{
                  fontSize: 14,
                  fontWeight: 500,
                  color: c.text,
                  margin: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {f.value.startsWith('•') && <Icons.lock size={12} color={c.textTertiary} />}
                {f.value}
              </p>
            </div>
          ))}
        </div>

        {!verified && (
          <div
            style={{
              marginTop: 16,
              padding: '10px 14px',
              borderRadius: 8,
              background: c.warningLight,
              border: `1px solid ${c.warningBorder}`,
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
            }}
          >
            <Icons.zap size={13} color={c.warning} style={{ marginTop: 1, flexShrink: 0 }} />
            <p style={{ fontSize: 12, color: c.warning, margin: 0, lineHeight: 1.5 }}>
              Editing your details will require re-verification before payouts resume.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}

// ── Trust Row ─────────────────────────────────────────────────────

function TrustRow() {
  const items = [
    { icon: Icons.lock, label: 'Bank details encrypted at rest' },
    { icon: Icons.shield, label: 'Never shared with third parties' },
    { icon: Icons.zap, label: 'Used only for payout disbursements' },
  ];
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 28,
        padding: '16px 0 0',
      }}
    >
      {items.map(({ icon: IconComp, label }) => (
        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <IconComp size={13} color={c.textTertiary} />
          <span style={{ fontSize: 12, color: c.textTertiary }}>{label}</span>
        </div>
      ))}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN PAYOUTS PAGE
// ══════════════════════════════════════════════════════════════════

export default function ExpertPayoutsPage() {
  // 'empty' | 'form' | 'saved' | 'verified'
  const [viewState, setViewState] = useState('empty');
  const [country, setCountry] = useState('AU');
  const [method, setMethod] = useState('LOCAL');
  const [loadingSchema, setLoadingSchema] = useState(false);
  const [schema, setSchema] = useState(DEFAULT_SCHEMA);
  const [formValues, setFormValues] = useState({});
  const [saving, setSaving] = useState(false);

  function handleCountryChange(code) {
    setCountry(code);
    setLoadingSchema(true);
    setFormValues({});
    setTimeout(() => {
      const s = SCHEMAS[code] || {
        methods: ['SWIFT'],
        fields: [
          { key: 'account_name', label: 'Account Holder Name', type: 'text', required: true },
          {
            key: 'iban',
            label: 'IBAN',
            type: 'text',
            required: true,
            wide: true,
            hint: 'International Bank Account Number',
          },
          {
            key: 'swift_bic',
            label: 'BIC / SWIFT Code',
            type: 'text',
            required: true,
            hint: '8 or 11 characters',
          },
        ],
      };
      setSchema(s);
      setMethod(s.methods[0]);
      setLoadingSchema(false);
    }, 900);
  }

  function handleFieldChange(key, value) {
    setFormValues((prev) => ({ ...prev, [key]: value }));
  }

  function handleSave() {
    setSaving(true);
    setTimeout(() => {
      setSaving(false);
      setViewState('saved');
    }, 1200);
  }

  const isFormValid = schema.fields
    .filter((f) => f.required)
    .every((f) => formValues[f.key]?.trim());

  // ── Tab switcher for demo ─────────────────────────────────────
  const states = [
    { key: 'empty', label: 'Empty' },
    { key: 'form', label: 'Form' },
    { key: 'saved', label: 'Saved' },
    { key: 'verified', label: 'Verified' },
  ];

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

      {/* State switcher (for design reference navigation) */}
      <div
        style={{
          display: 'inline-flex',
          gap: 4,
          padding: 4,
          borderRadius: 10,
          background: c.surfaceSubtle,
          border: `1px solid ${c.borderSubtle}`,
          marginBottom: 32,
        }}
      >
        {states.map((s) => (
          <button
            key={s.key}
            onClick={() => setViewState(s.key)}
            style={{
              padding: '6px 16px',
              borderRadius: 7,
              fontSize: 12,
              fontWeight: 550,
              border: 'none',
              cursor: 'pointer',
              background: viewState === s.key ? c.surface : 'transparent',
              color: viewState === s.key ? c.text : c.textTertiary,
              boxShadow: viewState === s.key ? '0 1px 3px rgba(0,0,0,0.06)' : 'none',
              transition: 'all 0.15s',
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div style={{ maxWidth: 620, margin: '0 auto' }}>
        {/* Page header */}
        <div style={{ marginBottom: 32, ...slideUp(0) }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 11,
                background: `${c.warning}12`,
                border: `1px solid ${c.warning}22`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icons.creditCard size={20} color={c.warning} />
            </div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: c.text, margin: 0 }}>
              Payout Details
            </h1>
          </div>
          <p style={{ fontSize: 14, color: c.textSecondary, margin: 0, lineHeight: 1.6 }}>
            Where you want to receive your earnings. Balo admin disburses payouts manually after
            each payout cycle.
          </p>
        </div>

        {/* ── SAVED STATE ───────────────────────────────────── */}
        {(viewState === 'saved' || viewState === 'verified') && (
          <SavedState
            country="AU"
            method="LOCAL"
            verified={viewState === 'verified'}
            onEdit={() => setViewState('form')}
          />
        )}

        {/* ── FORM STATE ────────────────────────────────────── */}
        {viewState === 'form' && (
          <Card style={{ ...slideUp(0.05) }}>
            <div style={{ padding: '24px 28px 28px' }}>
              {/* Country selector */}
              <div style={{ marginBottom: 24 }}>
                <SectionLabel icon={Icons.globe} color={c.primary}>
                  Country
                </SectionLabel>
                <CountryCombobox value={country} onChange={handleCountryChange} />
              </div>

              {/* Method pills (only when >1 method) */}
              {!loadingSchema && schema.methods.length > 1 && (
                <MethodPills methods={schema.methods} value={method} onChange={setMethod} />
              )}

              {/* Fields */}
              <div>
                <SectionLabel icon={Icons.creditCard} color={c.warning}>
                  Bank Details
                </SectionLabel>
                {loadingSchema ? (
                  <LoadingSkeleton />
                ) : (
                  <div
                    key={country}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      gap: 16,
                      animation: 'fadeIn 0.3s ease-out',
                    }}
                  >
                    {schema.fields.map((field) => (
                      <DynamicField
                        key={`${country}-${method}-${field.key}`}
                        field={field}
                        value={formValues[field.key]}
                        onChange={handleFieldChange}
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* Save button */}
              <div style={{ marginTop: 28, display: 'flex', justifyContent: 'flex-end' }}>
                <Button
                  onClick={handleSave}
                  disabled={loadingSchema || saving || !isFormValid}
                  style={{ minWidth: 140 }}
                >
                  {saving ? (
                    <>
                      <span style={{ fontSize: 13 }}>Saving…</span>
                    </>
                  ) : (
                    <>
                      <Icons.check size={15} color="white" />
                      Save Details
                    </>
                  )}
                </Button>
              </div>
            </div>
          </Card>
        )}

        {/* ── EMPTY STATE ───────────────────────────────────── */}
        {viewState === 'empty' && (
          <Card style={{ ...slideUp(0.05) }}>
            <div style={{ padding: '24px 28px 28px' }}>
              {/* Country selector */}
              <div style={{ marginBottom: 24 }}>
                <SectionLabel icon={Icons.globe} color={c.primary}>
                  Country
                </SectionLabel>
                <CountryCombobox value={country} onChange={handleCountryChange} />
              </div>

              {/* Fields — empty */}
              <div>
                <SectionLabel icon={Icons.creditCard} color={c.warning}>
                  Bank Details
                </SectionLabel>
                {loadingSchema ? (
                  <LoadingSkeleton />
                ) : (
                  <div
                    key={country}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      gap: 16,
                      animation: 'fadeIn 0.3s ease-out',
                    }}
                  >
                    {(SCHEMAS[country] || SCHEMAS['AU']).fields.map((field) => (
                      <DynamicField
                        key={field.key}
                        field={field}
                        value={formValues[field.key]}
                        onChange={handleFieldChange}
                      />
                    ))}
                  </div>
                )}
              </div>

              <div style={{ marginTop: 28, display: 'flex', justifyContent: 'flex-end' }}>
                <Button disabled={true} style={{ minWidth: 140 }}>
                  <Icons.check size={15} color="white" />
                  Save Details
                </Button>
              </div>
            </div>
          </Card>
        )}

        {/* Trust row */}
        <TrustRow />
      </div>
    </div>
  );
}
