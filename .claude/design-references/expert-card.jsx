import { useState, useMemo } from 'react';

/**
 * ExpertCard — LOCKED design reference (source of truth for BAL-245).
 *
 * Shows the DECIDED design only. Earlier exploration toggles (bio on/off,
 * name overlay vs below, stats placement) are removed — those are decided;
 * do not reintroduce them as options.
 *
 * Locked decisions baked in:
 *   - Header = "name below": clean photo; name + per-minute rate on a white
 *     strip beneath it. Photo corners reserved: agency bottom-right,
 *     rating bottom-left. Availability pill top-left.
 *   - Bio shown, clamped to 4 lines (grid) / 2 lines (list row).
 *   - Stats = horizontal one-row strip directly after the header.
 *   - No verified tick (every searched expert is approved; vetting messaging
 *     lives at page level).
 *   - Availability = solid white next-slot pill (legible over any photo).
 *   - Agency = logo if uploaded, else name pill, else nothing.
 *   - Distinctions = real booleans only (MVP / CTA / Certified Trainer).
 *   - "New" replaces the session stat when sessions = 0.
 *   - Rating is DEFERRED: `rating` is null in v1 and all rating UI is hidden.
 *     RatingBadge is wired but null-gated; it lights up when reviews exist.
 *
 * Two runtime STATES shown (not choices): photo vs initials-fallback header,
 * and grid card vs list row. CC must build both. List row is desktop-only
 * (mobile gate is BAL-247's responsibility).
 */

// -- Tokens (shared app theme) -----------------------------------
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
  primaryGlow: 'rgba(37,99,235,0.12)',
  accent: '#7C3AED',
  success: '#059669',
  successLight: '#ECFDF5',
  successBorder: '#A7F3D0',
  warning: '#D97706',
  warningLight: '#FFFBEB',
  warningBorder: '#FDE68A',
  heroFrom: '#0F1729',
  heroTo: '#1E293B',
  gradient: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
};

const I = {
  star: 'M12 2l2.9 6.3 6.9.6-5.2 4.5 1.6 6.8L12 17.3 5.8 20.8l1.6-6.8L2.2 8.9l6.9-.6z',
  heart:
    'M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.7l-1-1a5.5 5.5 0 00-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 000-7.8z',
  mapPin: 'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z|M12 13a3 3 0 100-6 3 3 0 000 6z',
  award: 'M12 15a7 7 0 100-14 7 7 0 000 14zM8.2 13.9L7 22l5-3 5 3-1.2-8.1',
  video: 'M23 7l-7 5 7 5V7zM1 5h15v14H1z',
  user: 'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z',
  phone:
    'M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6 19.8 19.8 0 01-3.1-8.7A2 2 0 014.1 2h3a2 2 0 012 1.7c.1 1 .4 1.9.7 2.8a2 2 0 01-.5 2.1L8.1 9.9a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.5c.9.3 1.8.6 2.8.7a2 2 0 011.7 2z',
  chevRight: 'M9 18l6-6-6-6',
  clock: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2',
  code: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
  layers: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  settings:
    'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008.6 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 8.6a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z',
  target:
    'M12 22a10 10 0 100-20 10 10 0 000 20zM12 18a6 6 0 100-12 6 6 0 000 12zM12 14a2 2 0 100-4 2 2 0 000 4z',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
};
const Svg = ({ d, size = 16, color = 'currentColor', fill = 'none', sw = 2, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={fill}
    stroke={color}
    strokeWidth={sw}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={style}
  >
    {d.split('|').map((p, i) => (
      <path key={i} d={p} />
    ))}
  </svg>
);

const SKILL_ICON = {
  technical: I.code,
  architecture: I.layers,
  admin: I.settings,
  strategy: I.target,
};
const SKILL_LABEL = {
  technical: 'Technical / Development',
  architecture: 'Architecture / Integrations',
  admin: 'Admin / Configuration',
  strategy: 'Strategy / Consulting',
};
const GRADIENTS = [
  ['#2563EB', '#7C3AED'],
  ['#0891B2', '#2563EB'],
  ['#7C3AED', '#DB2777'],
  ['#059669', '#0891B2'],
  ['#D97706', '#DB2777'],
];
function gradientFromId(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return GRADIENTS[Math.abs(h) % GRADIENTS.length];
}

const SAMPLE_PHOTO =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="500" height="400" viewBox="0 0 500 400">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#A8B5C4"/><stop offset="1" stop-color="#7C8A9B"/></linearGradient>
    <radialGradient id="vig" cx="0.5" cy="0.36" r="0.78"><stop offset="0.5" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.32"/></radialGradient>
  </defs>
  <rect width="500" height="400" fill="url(#bg)"/>
  <path d="M105 400 C105 296 172 266 250 266 C328 266 395 296 395 400 Z" fill="#2B3A4A"/>
  <path d="M150 400 C150 332 196 314 250 314 C304 314 350 332 350 400 Z" fill="#3C4F63"/>
  <rect x="227" y="228" width="46" height="58" rx="21" fill="#E4A57E"/>
  <ellipse cx="250" cy="176" rx="76" ry="86" fill="#EEB98E"/>
  <path d="M174 168 C168 100 214 72 250 72 C286 72 332 100 326 170 C322 132 298 116 286 128 C300 104 268 92 250 92 C210 92 180 120 186 174 Z" fill="#241A14"/>
  <ellipse cx="221" cy="174" rx="7.5" ry="9" fill="#241A14"/><ellipse cx="279" cy="174" rx="7.5" ry="9" fill="#241A14"/>
  <circle cx="223.5" cy="171" r="2.2" fill="#fff" opacity="0.85"/><circle cx="281.5" cy="171" r="2.2" fill="#fff" opacity="0.85"/>
  <path d="M206 156 Q221 149 236 156" stroke="#241A14" stroke-width="4" fill="none" stroke-linecap="round"/>
  <path d="M264 156 Q279 149 294 156" stroke="#241A14" stroke-width="4" fill="none" stroke-linecap="round"/>
  <path d="M250 182 L243 205 Q250 209 257 205" stroke="#C9895F" stroke-width="3.5" fill="none" stroke-linecap="round"/>
  <path d="M226 222 Q250 240 274 222" stroke="#A85540" stroke-width="4.5" fill="none" stroke-linecap="round"/>
  <rect width="500" height="400" fill="url(#vig)"/>
</svg>`);
const SAMPLE_AGENCY_LOGO =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="120" height="44" viewBox="0 0 120 44">
  <rect width="120" height="44" rx="8" fill="#E11D2E"/>
  <text x="60" y="29" font-family="Arial, sans-serif" font-size="18" font-weight="700" fill="#fff" text-anchor="middle" letter-spacing="1">MIDCAI</text>
</svg>`);

// -- Two demo experts (rating null = the v1 state) ---------------
const EXPERT_A = {
  id: 'expert-34',
  name: 'Utkarsh Singh',
  initials: 'US',
  title: 'Salesforce Consultant',
  bio: 'I help mid-market RevOps teams untangle years of accumulated Salesforce debt - turning brittle, over-automated orgs into something their admins can actually maintain.',
  taglineProducts: ['Agentforce', 'Sales Cloud', 'Account Engagement'],
  location: 'Canada',
  yearsExp: 7,
  certifications: 10,
  consultationCount: 0,
  rate: 3.44,
  nextAvailableAt: 'soon',
  rating: null,
  reviewCount: 0,
  agency: { name: 'MIDCAI', logo: SAMPLE_AGENCY_LOGO },
  distinctions: ['mvp', 'certified_trainer'],
  expertise: [
    { product: 'Agentforce', skills: ['strategy'] },
    { product: 'Sales Cloud', skills: ['technical', 'architecture', 'admin'] },
    { product: 'Account Engagement', skills: ['technical', 'admin', 'architecture'] },
    { product: 'CPQ', skills: ['architecture'] },
  ],
};
const EXPERT_B = {
  id: 'expert-7',
  name: 'Scott Reynolds',
  initials: 'SR',
  title: 'Salesforce Simplification Specialist',
  bio: "After 14 years and more rescue projects than I can count, I've learned most orgs don't need more features - they need someone to ruthlessly simplify what's already there. I untangle over-engineered automation, consolidate duplicate processes, and give internal teams a platform they can own and extend without calling a consultant every week.",
  taglineProducts: ['Agentforce', 'Sales Cloud', 'Salesforce Platform'],
  location: 'United Kingdom',
  yearsExp: 14,
  certifications: 6,
  consultationCount: 132,
  rate: 5.0,
  nextAvailableAt: 'today',
  rating: null,
  reviewCount: 0,
  agency: null,
  distinctions: ['cta'],
  expertise: [
    { product: 'Agentforce', skills: ['strategy', 'architecture'] },
    { product: 'Sales Cloud', skills: ['technical', 'admin'] },
    { product: 'Salesforce Platform', skills: ['architecture', 'technical'] },
    { product: 'Service Cloud', skills: ['admin'] },
  ],
};

const DISTINCTION = {
  mvp: { label: 'Salesforce MVP', color: '#D97706', bg: '#FFFBEB', border: '#FDE68A' },
  cta: { label: 'CTA', color: '#7C3AED', bg: '#F5F3FF', border: '#DDD6FE' },
  certified_trainer: {
    label: 'Certified Trainer',
    color: '#0891B2',
    bg: '#ECFEFF',
    border: '#A5F3FC',
  },
};
function availabilityLabel(kind) {
  switch (kind) {
    case 'now-ish':
      return { text: 'Available now', tone: 'live' };
    case 'soon':
      return { text: 'Free in ~2h', tone: 'soon' };
    case 'today':
      return { text: 'Available today', tone: 'soon' };
    case 'tomorrow':
      return { text: 'Next: tomorrow 9 AM', tone: 'later' };
    default:
      return { text: 'No availability', tone: 'none' };
  }
}
function buildTagline(products) {
  if (products.length <= 1) return products[0] || '';
  if (products.length === 2) return `${products[0]} & ${products[1]}`;
  return `${products.slice(0, 2).join(', ')} +${products.length - 2} more`;
}

// -- Sub-parts ---------------------------------------------------
function AvailabilityPill({ kind }) {
  const { text, tone } = availabilityLabel(kind);
  const accent = { live: c.success, soon: c.success, later: c.warning, none: c.textTertiary }[tone];
  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        left: 12,
        zIndex: 3,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 10px',
        borderRadius: 999,
        background: '#fff',
        boxShadow: '0 1px 4px rgba(0,0,0,0.18)',
        border: '1px solid rgba(0,0,0,0.04)',
      }}
    >
      {tone === 'live' ? (
        <span style={{ position: 'relative', display: 'flex', width: 8, height: 8 }}>
          <span
            style={{
              position: 'absolute',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: c.success,
              opacity: 0.75,
            }}
          />
          <span
            style={{
              position: 'relative',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: c.success,
            }}
          />
        </span>
      ) : (
        <Svg d={I.clock} size={11} color={accent} />
      )}
      <span style={{ fontSize: 11, fontWeight: 600, color: accent }}>{text}</span>
    </div>
  );
}

function AgencyBadge({ agency }) {
  if (!agency) return null;
  return (
    <div style={{ position: 'absolute', right: 12, bottom: 12, zIndex: 3 }}>
      {agency.logo ? (
        <div
          style={{
            height: 34,
            padding: '4px 6px',
            display: 'flex',
            alignItems: 'center',
            borderRadius: 9,
            background: '#fff',
            boxShadow: '0 2px 8px rgba(0,0,0,0.22)',
          }}
        >
          <img
            src={agency.logo}
            alt={agency.name}
            style={{ height: 24, width: 'auto', borderRadius: 4, display: 'block' }}
          />
        </div>
      ) : (
        <div
          style={{
            height: 28,
            padding: '0 12px',
            display: 'flex',
            alignItems: 'center',
            borderRadius: 8,
            background: '#fff',
            boxShadow: '0 2px 8px rgba(0,0,0,0.22)',
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 700, color: c.text }}>{agency.name}</span>
        </div>
      )}
    </div>
  );
}

// Bottom-left rating badge; renders ONLY if rating != null. Deferred in v1.
function RatingBadge({ rating, reviewCount }) {
  if (rating == null) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: 12,
        bottom: 12,
        zIndex: 3,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        height: 28,
        padding: '0 10px',
        borderRadius: 8,
        background: '#fff',
        boxShadow: '0 2px 8px rgba(0,0,0,0.22)',
      }}
    >
      <Svg d={I.star} size={12} sw={0} fill={c.warning} color={c.warning} />
      <span style={{ fontSize: 12, fontWeight: 700, color: c.text }}>{rating.toFixed(1)}</span>
      {reviewCount != null && (
        <span style={{ fontSize: 11, color: c.textTertiary }}>({reviewCount})</span>
      )}
    </div>
  );
}

function DistinctionBadges({ distinctions }) {
  if (!distinctions.length) return null;
  return (
    <div style={{ display: 'flex', gap: 5, marginTop: 8, flexWrap: 'wrap' }}>
      {distinctions.map((d) => {
        const cfg = DISTINCTION[d];
        return (
          <span
            key={d}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 8px',
              borderRadius: 6,
              fontSize: 10,
              fontWeight: 600,
              color: cfg.color,
              background: cfg.bg,
              border: `1px solid ${cfg.border}`,
            }}
          >
            <Svg d={I.shield} size={10} color={cfg.color} /> {cfg.label}
          </span>
        );
      })}
    </div>
  );
}

function StatStrip({ expert }) {
  const cols = [
    { icon: I.mapPin, label: expert.location || 'Remote' },
    { icon: I.award, label: `${expert.yearsExp}y exp` },
    ...(expert.certifications > 0
      ? [{ icon: I.shield, label: `${expert.certifications} certs` }]
      : []),
    expert.consultationCount > 0
      ? { icon: I.video, label: `${expert.consultationCount} sessions` }
      : { icon: I.phone, label: 'New' },
  ];
  return (
    <div style={{ margin: '0 16px' }}>
      <div
        style={{
          borderTop: `1px solid ${c.borderSubtle}`,
          borderBottom: `1px solid ${c.borderSubtle}`,
          display: 'grid',
          gridTemplateColumns: `repeat(${cols.length}, 1fr)`,
        }}
      >
        {cols.map((s, i) => (
          <div
            key={s.label}
            style={{
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 5,
              padding: '12px 4px',
            }}
          >
            {i > 0 && (
              <span
                style={{
                  position: 'absolute',
                  top: 8,
                  bottom: 8,
                  left: 0,
                  width: 1,
                  background: c.borderSubtle,
                }}
              />
            )}
            <Svg d={s.icon} size={15} color={c.primary} />
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 500,
                color: c.textTertiary,
                textAlign: 'center',
                lineHeight: 1.2,
              }}
            >
              {s.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProductPills({ expertise, max = 4, showHeading = true, pad = true }) {
  const [tip, setTip] = useState(null);
  const visible = expertise.slice(0, max);
  const overflow = expertise.length - max;
  const px = pad ? 16 : 0;
  return (
    <div>
      {showHeading && (
        <p
          style={{
            margin: '0 0 8px',
            padding: `0 ${px}px`,
            fontSize: 13,
            fontWeight: 600,
            color: c.text,
          }}
        >
          Top expert in
        </p>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: `0 ${px}px` }}>
        {visible.map((item, pi) => (
          <div
            key={item.product}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 10px',
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 600,
              color: c.primary,
              background: 'rgba(37,99,235,0.07)',
              border: '1px solid rgba(37,99,235,0.18)',
            }}
          >
            <span>{item.product}</span>
            {item.skills.length > 0 && (
              <>
                <span style={{ width: 1, height: 13, background: 'rgba(37,99,235,0.2)' }} />
                <span style={{ display: 'flex' }}>
                  {item.skills.map((s) => {
                    const key = `${pi}-${s}`;
                    return (
                      <span
                        key={s}
                        onMouseEnter={() => setTip({ key, label: SKILL_LABEL[s] })}
                        onMouseLeave={() => setTip(null)}
                        style={{
                          position: 'relative',
                          display: 'inline-flex',
                          width: 22,
                          height: 22,
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'default',
                        }}
                      >
                        <Svg d={SKILL_ICON[s]} size={12} color={c.primary} />
                        {tip?.key === key && (
                          <span
                            style={{
                              position: 'absolute',
                              bottom: 'calc(100% + 6px)',
                              left: '50%',
                              transform: 'translateX(-50%)',
                              whiteSpace: 'nowrap',
                              padding: '5px 9px',
                              borderRadius: 7,
                              background: c.text,
                              color: '#fff',
                              fontSize: 11,
                              fontWeight: 500,
                              boxShadow: '0 4px 14px rgba(0,0,0,0.2)',
                              zIndex: 20,
                            }}
                          >
                            {tip.label}
                            <span
                              style={{
                                position: 'absolute',
                                top: '100%',
                                left: '50%',
                                transform: 'translateX(-50%)',
                                width: 0,
                                height: 0,
                                borderLeft: '5px solid transparent',
                                borderRight: '5px solid transparent',
                                borderTop: `5px solid ${c.text}`,
                              }}
                            />
                          </span>
                        )}
                      </span>
                    );
                  })}
                </span>
              </>
            )}
          </div>
        ))}
        {overflow > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '5px 4px' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: c.primary }}>
              +{overflow} more
            </span>
            <Svg d={I.chevRight} size={12} color={c.primary} />
          </div>
        )}
      </div>
    </div>
  );
}

function CtaRow() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        margin: '0 16px',
        padding: '14px 0 16px',
      }}
    >
      <button
        style={{
          flex: 1,
          height: 44,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          borderRadius: 8,
          border: `1px solid ${c.border}`,
          background: c.surface,
          color: c.text,
          fontSize: 13,
          fontWeight: 500,
          cursor: 'pointer',
        }}
      >
        <Svg d={I.user} size={16} color={c.text} /> View profile
      </button>
      <button
        style={{
          flex: 1,
          height: 44,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          borderRadius: 8,
          border: 'none',
          background: c.gradient,
          color: '#fff',
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
          boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
        }}
      >
        <Svg d={I.video} size={16} color="#fff" /> Book a call
      </button>
    </div>
  );
}

const heartBtn = {
  position: 'absolute',
  top: 12,
  right: 12,
  width: 34,
  height: 34,
  borderRadius: '50%',
  background: '#fff',
  boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
  border: 'none',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 3,
};

// -- GRID CARD (name-below, locked) ------------------------------
// `photo`: a real R2 photo, or null -> initials fallback. Both are states.
function ExpertCard({ expert, photo }) {
  const [g1, g2] = gradientFromId(expert.id);
  const tagline = useMemo(() => buildTagline(expert.taglineProducts), [expert.taglineProducts]);
  const showPhoto = !!photo;
  return (
    <div
      style={{
        width: 360,
        background: c.surface,
        borderRadius: 16,
        overflow: 'hidden',
        border: `1px solid ${c.border}`,
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          position: 'relative',
          background: showPhoto ? '#000' : `linear-gradient(135deg, ${c.heroFrom}, ${c.heroTo})`,
          aspectRatio: '5 / 4',
        }}
      >
        {showPhoto ? (
          <img
            src={photo}
            alt={expert.name}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
          />
        ) : (
          <>
            <div
              style={{
                position: 'absolute',
                inset: 0,
                opacity: 0.05,
                backgroundImage: 'radial-gradient(circle, white 1px, transparent 1px)',
                backgroundSize: '26px 26px',
              }}
            />
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <div
                style={{
                  width: 96,
                  height: 96,
                  borderRadius: '50%',
                  background: `linear-gradient(135deg, ${g1}, ${g2})`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 4px 18px rgba(0,0,0,0.3)',
                }}
              >
                <span style={{ fontSize: 30, fontWeight: 600, color: '#fff' }}>
                  {expert.initials}
                </span>
              </div>
            </div>
          </>
        )}
        <AvailabilityPill kind={expert.nextAvailableAt} />
        <button style={heartBtn}>
          <Svg d={I.heart} size={15} color={c.textSecondary} />
        </button>
        <AgencyBadge agency={expert.agency} />
        <RatingBadge rating={expert.rating} reviewCount={expert.reviewCount} />
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          padding: '14px 16px 4px',
        }}
      >
        <div>
          <p style={{ margin: 0, fontSize: 17, fontWeight: 700, color: c.text }}>{expert.name}</p>
          <DistinctionBadges distinctions={expert.distinctions} />
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <p
            style={{
              margin: 0,
              fontSize: 19,
              fontWeight: 700,
              color: c.text,
              fontFamily: 'monospace',
            }}
          >
            A${expert.rate.toFixed(2)}
          </p>
          <p style={{ margin: 0, fontSize: 10, color: c.textTertiary }}>per minute</p>
        </div>
      </div>

      <div style={{ paddingTop: 10, paddingBottom: 4 }}>
        <StatStrip expert={expert} />
      </div>

      <div style={{ padding: '12px 16px 8px' }}>
        <div style={{ fontSize: 13, lineHeight: 1.45 }}>
          <span style={{ fontWeight: 600, color: c.text }}>{expert.title}</span>
          <span style={{ fontSize: 12, color: c.textSecondary }}>
            {' '}
            <span style={{ color: c.textTertiary }}>&middot;</span> {tagline}
          </span>
        </div>
        <p
          style={{
            margin: '8px 0 0',
            fontSize: 12,
            lineHeight: 1.6,
            fontStyle: 'italic',
            color: 'rgba(17,24,39,0.68)',
            display: '-webkit-box',
            WebkitLineClamp: 4,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {expert.bio}
        </p>
      </div>

      <div style={{ marginTop: 'auto' }}>
        <ProductPills expertise={expert.expertise} />
        <CtaRow />
      </div>
    </div>
  );
}

// -- LIST ROW (desktop-only, locked) -----------------------------
function ExpertListRow({ expert, photo }) {
  const [g1, g2] = gradientFromId(expert.id);
  const tagline = useMemo(() => buildTagline(expert.taglineProducts), [expert.taglineProducts]);
  const showPhoto = !!photo;
  const meta = [
    expert.location,
    `${expert.yearsExp}y exp`,
    expert.certifications > 0 ? `${expert.certifications} certs` : null,
    expert.consultationCount > 0 ? `${expert.consultationCount} sessions` : 'New expert',
  ].filter(Boolean);
  return (
    <div
      style={{
        display: 'flex',
        background: c.surface,
        borderRadius: 16,
        overflow: 'hidden',
        border: `1px solid ${c.border}`,
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: 240,
          flexShrink: 0,
          alignSelf: 'stretch',
          background: showPhoto ? '#000' : `linear-gradient(135deg, ${c.heroFrom}, ${c.heroTo})`,
          overflow: 'hidden',
        }}
      >
        {showPhoto ? (
          <img
            src={photo}
            alt={expert.name}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
          />
        ) : (
          <>
            <div
              style={{
                position: 'absolute',
                inset: 0,
                opacity: 0.05,
                backgroundImage: 'radial-gradient(circle, white 1px, transparent 1px)',
                backgroundSize: '26px 26px',
              }}
            />
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <div
                style={{
                  width: 88,
                  height: 88,
                  borderRadius: '50%',
                  background: `linear-gradient(135deg, ${g1}, ${g2})`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 4px 18px rgba(0,0,0,0.3)',
                }}
              >
                <span style={{ fontSize: 28, fontWeight: 600, color: '#fff' }}>
                  {expert.initials}
                </span>
              </div>
            </div>
          </>
        )}
        <AvailabilityPill kind={expert.nextAvailableAt} />
        <AgencyBadge agency={expert.agency} />
        <RatingBadge rating={expert.rating} reviewCount={expert.reviewCount} />
      </div>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          padding: '18px 20px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 16,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: 18, fontWeight: 700, color: c.text }}>{expert.name}</p>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
                marginTop: 4,
              }}
            >
              {meta.map((b, i) => (
                <span key={b} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {i > 0 && <span style={{ color: c.border }}>&middot;</span>}
                  <span style={{ fontSize: 13, color: c.textSecondary }}>{b}</span>
                </span>
              ))}
            </div>
          </div>
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            <p style={{ margin: 0, fontSize: 18, fontWeight: 700, color: c.text }}>
              <span style={{ fontFamily: 'monospace' }}>A${expert.rate.toFixed(2)}</span>
              <span style={{ fontSize: 12, fontWeight: 500, color: c.textTertiary }}>/min</span>
            </p>
          </div>
        </div>
        <p style={{ margin: '12px 0 0', fontSize: 14, color: c.text }}>
          <span style={{ fontWeight: 600 }}>{expert.title}</span>
          <span style={{ color: c.textSecondary }}> &middot; {tagline}</span>
        </p>
        {expert.distinctions.length > 0 && (
          <div style={{ marginTop: 2 }}>
            <DistinctionBadges distinctions={expert.distinctions} />
          </div>
        )}
        <p
          style={{
            margin: '10px 0 0',
            fontSize: 13,
            lineHeight: 1.55,
            color: 'rgba(17,24,39,0.66)',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {expert.bio}
        </p>
        <div style={{ marginTop: 12, marginBottom: 16 }}>
          <ProductPills expertise={expert.expertise} max={5} showHeading={false} pad={false} />
        </div>
        <div style={{ marginTop: 'auto', display: 'flex', gap: 10 }}>
          <button
            style={{
              flex: 1,
              height: 44,
              maxWidth: 200,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              borderRadius: 8,
              border: `1px solid ${c.border}`,
              background: c.surface,
              color: c.text,
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            <Svg d={I.user} size={16} color={c.text} /> View profile
          </button>
          <button
            style={{
              flex: 1,
              height: 44,
              maxWidth: 220,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              borderRadius: 8,
              border: 'none',
              background: c.gradient,
              color: '#fff',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
            }}
          >
            <Svg d={I.video} size={16} color="#fff" /> Book a call
          </button>
        </div>
      </div>
    </div>
  );
}

// -- Preview shell (NOT shipped; renders the states for review) --
function Label({ children }) {
  return (
    <p
      style={{
        margin: '0 0 14px',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.07em',
        textTransform: 'uppercase',
        color: c.textTertiary,
      }}
    >
      {children}
    </p>
  );
}
export default function ExpertCardReference() {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: c.bg,
        fontFamily: "'DM Sans', -apple-system, sans-serif",
        padding: '32px 28px 64px',
      }}
    >
      <link
        href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap"
        rel="stylesheet"
      />
      <div style={{ maxWidth: 880, margin: '0 auto 28px' }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: c.text, margin: 0 }}>
          ExpertCard - locked design
        </h1>
        <p style={{ fontSize: 14, color: c.textSecondary, margin: '6px 0 0', lineHeight: 1.6 }}>
          The decided design. Two runtime states per layout: photo (left) and initials fallback
          (right). Rating is null in v1, so no rating badge renders.
        </p>
      </div>

      <div style={{ maxWidth: 880, margin: '0 auto 40px' }}>
        <Label>Grid card - photo / initials fallback</Label>
        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', justifyContent: 'center' }}>
          <ExpertCard expert={EXPERT_A} photo={SAMPLE_PHOTO} />
          <ExpertCard expert={EXPERT_B} photo={null} />
        </div>
      </div>

      <div style={{ maxWidth: 880, margin: '0 auto' }}>
        <Label>List row (desktop-only) - photo / initials fallback</Label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <ExpertListRow expert={EXPERT_A} photo={SAMPLE_PHOTO} />
          <ExpertListRow expert={EXPERT_B} photo={null} />
        </div>
      </div>
    </div>
  );
}
