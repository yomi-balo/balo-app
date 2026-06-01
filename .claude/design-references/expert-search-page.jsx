import { useState, useEffect, useMemo } from 'react';

/**
 * Expert Search results page (Balo app theme) — RESPONSIVE reference.
 *
 * ⚠️ PREVIEW-ONLY RESPONSIVENESS:
 * This prototype switches layout with a JS viewport listener + a MOBILE_MAX
 * constant SO THE BREAKPOINT BEHAVIOUR IS VISIBLE in preview. Do NOT copy this
 * pattern into production — the real page MUST server-render (SEO) and use
 * Tailwind responsive classes (`md:` etc.), not a useState/resize listener
 * (which causes hydration mismatches under SSR). MOBILE_MAX (768) is the `md`
 * boundary; map the branches below to Tailwind utilities:
 *   - rail: `hidden md:block` (desktop) + a `md:hidden` Filters button + sheet
 *   - hero: `flex-col md:flex-row`
 *   - grid/list toggle: `hidden md:inline-flex`; below md layout is forced grid
 *
 * Locked decisions shown:
 *   - App theme only (#F8FAFB, blue->violet, DM Sans) — no marketplace theme.
 *   - Page-level vetting trust line (relocated from the per-card verified tick).
 *   - Desktop: filter rail (left) + results. Mobile: rail becomes a bottom
 *     SHEET (partial height, backdrop-dismiss) triggered by a "Filters" button
 *     with an active-count badge; sticky footer shows "Show N experts" so the
 *     filter->count feedback stays live even when the sheet covers results.
 *   - Mobile forces grid layout and hides the grid/list toggle (list is
 *     desktop-only). effectiveView = isMobile ? 'grid' : userChoice.
 *   - Numbered pagination; sort (Best match / Soonest / Lowest rate / Most exp).
 */

const MOBILE_MAX = 768; // === Tailwind `md` boundary

// -- Tokens --------------------------------------------------------
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
  heroFrom: '#0F1729',
  heroTo: '#1E293B',
  gradient: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
  gradientSubtle: 'linear-gradient(135deg, #EFF6FF 0%, #F5F3FF 100%)',
};

const I = {
  search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.35-4.35',
  heart:
    'M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.7l-1-1a5.5 5.5 0 00-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 000-7.8z',
  mapPin: 'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z|M12 13a3 3 0 100-6 3 3 0 000 6z',
  award: 'M12 15a7 7 0 100-14 7 7 0 000 14zM8.2 13.9L7 22l5-3 5 3-1.2-8.1',
  video: 'M23 7l-7 5 7 5V7zM1 5h15v14H1z',
  user: 'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z',
  phone:
    'M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6 19.8 19.8 0 01-3.1-8.7A2 2 0 014.1 2h3a2 2 0 012 1.7c.1 1 .4 1.9.7 2.8a2 2 0 01-.5 2.1L8.1 9.9a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.5c.9.3 1.8.6 2.8.7a2 2 0 011.7 2z',
  chevRight: 'M9 18l6-6-6-6',
  chevLeft: 'M15 18l-6-6 6-6',
  chevDown: 'M6 9l6 6 6-6',
  clock: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2',
  code: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
  layers: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  settings:
    'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008.6 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 8.6a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z',
  target:
    'M12 22a10 10 0 100-20 10 10 0 000 20zM12 18a6 6 0 100-12 6 6 0 000 12zM12 14a2 2 0 100-4 2 2 0 000 4z',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  x: 'M18 6L6 18M6 6l12 12',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
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

const EXPERTS = [
  {
    id: 'e1',
    name: 'Anil Pilania',
    initials: 'AP',
    title: 'Salesforce Strategy & Solution Architect',
    bio: 'CRM, MarTech, Data and Agentforce. 15x certified architect with deep multi-cloud playbooks for mid-market and enterprise rollouts.',
    taglineProducts: ['Agentforce', 'Data Cloud', 'Sales Cloud'],
    location: 'Canada',
    yearsExp: 9,
    certifications: 15,
    consultationCount: 124,
    rate: 3.13,
    nextAvailableAt: 'soon',
    agency: { name: 'MIDCAI', logo: true },
    distinctions: ['mvp'],
    expertise: [
      { product: 'Agentforce', skills: ['strategy'] },
      { product: 'Data Cloud', skills: ['technical', 'architecture'] },
      { product: 'Sales Cloud', skills: ['technical', 'admin'] },
      { product: 'CPQ', skills: ['architecture'] },
      { product: 'Service Cloud', skills: ['admin'] },
    ],
  },
  {
    id: 'e2',
    name: 'Chad Lieberman',
    initials: 'CL',
    title: 'Multicloud Architect · Founder',
    bio: 'Innovation, delivery and solutioning lead. Specialises in greenfield Agentforce launches and untangling over-engineered orgs for scale-ups.',
    taglineProducts: ['Agentforce', 'Data Cloud', 'Sales Cloud'],
    location: 'Australia',
    yearsExp: 14,
    certifications: 22,
    consultationCount: 372,
    rate: 5.0,
    nextAvailableAt: 'today',
    agency: { name: 'FUTUREFUTURE', logo: true },
    distinctions: ['cta', 'certified_trainer'],
    expertise: [
      { product: 'Agentforce', skills: ['strategy', 'architecture'] },
      { product: 'Data Cloud', skills: ['technical'] },
      { product: 'Sales Cloud', skills: ['admin', 'technical'] },
      { product: 'Service Cloud', skills: ['admin'] },
    ],
  },
  {
    id: 'e3',
    name: 'Priya Nair',
    initials: 'PN',
    title: 'Service Cloud Consultant',
    bio: 'I help support orgs cut handle time with pragmatic Service Cloud and Agentforce automation that agents actually adopt.',
    taglineProducts: ['Service Cloud', 'Agentforce'],
    location: 'Singapore',
    yearsExp: 6,
    certifications: 8,
    consultationCount: 0,
    rate: 2.75,
    nextAvailableAt: 'tomorrow',
    agency: null,
    distinctions: [],
    expertise: [
      { product: 'Service Cloud', skills: ['admin', 'technical'] },
      { product: 'Agentforce', skills: ['strategy'] },
    ],
  },
  {
    id: 'e4',
    name: 'Marcus Webb',
    initials: 'MW',
    title: 'Revenue Cloud / CPQ Specialist',
    bio: "Quote-to-cash that doesn't fall over at quarter-end. Deep CPQ, Billing, and integration experience across complex B2B.",
    taglineProducts: ['CPQ', 'Sales Cloud'],
    location: 'United Kingdom',
    yearsExp: 11,
    certifications: 12,
    consultationCount: 88,
    rate: 4.2,
    nextAvailableAt: 'now-ish',
    agency: { name: 'Northbridge', logo: false },
    distinctions: ['mvp', 'cta'],
    expertise: [
      { product: 'CPQ', skills: ['architecture', 'technical'] },
      { product: 'Sales Cloud', skills: ['admin'] },
      { product: 'Billing', skills: ['technical'] },
    ],
  },
  {
    id: 'e5',
    name: 'Sofia Reyes',
    initials: 'SR',
    title: 'Marketing Cloud Consultant',
    bio: 'Journey Builder, Data Cloud activation, and Agentforce for marketing ops. Former in-house before going independent.',
    taglineProducts: ['Marketing Cloud', 'Data Cloud'],
    location: 'Mexico',
    yearsExp: 7,
    certifications: 9,
    consultationCount: 41,
    rate: 3.6,
    nextAvailableAt: 'none',
    agency: null,
    distinctions: ['certified_trainer'],
    expertise: [
      { product: 'Marketing Cloud', skills: ['strategy', 'technical'] },
      { product: 'Data Cloud', skills: ['technical'] },
    ],
  },
  {
    id: 'e6',
    name: 'Daniel Kim',
    initials: 'DK',
    title: 'Platform Developer & Integration Lead',
    bio: 'Apex, LWC, and MuleSoft integrations. I build the hard custom things and leave your admins something they can maintain.',
    taglineProducts: ['Platform', 'Integration'],
    location: 'United States',
    yearsExp: 8,
    certifications: 7,
    consultationCount: 156,
    rate: 4.8,
    nextAvailableAt: 'soon',
    agency: { name: 'Stackline', logo: true },
    distinctions: [],
    expertise: [
      { product: 'Platform', skills: ['technical', 'architecture'] },
      { product: 'MuleSoft', skills: ['technical'] },
      { product: 'Experience Cloud', skills: ['technical'] },
    ],
  },
];

// -- Card sub-parts ------------------------------------------------
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
      <div
        style={{
          height: 30,
          padding: '0 12px',
          display: 'flex',
          alignItems: 'center',
          borderRadius: 8,
          background: agency.logo ? c.heroFrom : '#fff',
          boxShadow: '0 2px 8px rgba(0,0,0,0.22)',
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: agency.logo ? '#fff' : c.text,
            letterSpacing: '0.04em',
          }}
        >
          {agency.name}
        </span>
      </div>
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
const heartBtn = {
  position: 'absolute',
  top: 12,
  right: 12,
  width: 32,
  height: 32,
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

function ExpertCard({ expert }) {
  const [g1, g2] = gradientFromId(expert.id);
  const tagline = useMemo(() => buildTagline(expert.taglineProducts), [expert.taglineProducts]);
  return (
    <div
      style={{
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
          background: `linear-gradient(135deg, ${c.heroFrom}, ${c.heroTo})`,
          aspectRatio: '5 / 4',
        }}
      >
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
              width: 92,
              height: 92,
              borderRadius: '50%',
              background: `linear-gradient(135deg, ${g1}, ${g2})`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
            }}
          >
            <span style={{ fontSize: 28, fontWeight: 600, color: '#fff' }}>{expert.initials}</span>
          </div>
        </div>
        <AvailabilityPill kind={expert.nextAvailableAt} />
        <button style={heartBtn}>
          <Svg d={I.heart} size={15} color={c.textSecondary} />
        </button>
        <AgencyBadge agency={expert.agency} />
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
          <p style={{ margin: 0, fontSize: 16, fontWeight: 700, color: c.text }}>{expert.name}</p>
          <DistinctionBadges distinctions={expert.distinctions} />
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <p
            style={{
              margin: 0,
              fontSize: 18,
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
        <div style={{ display: 'flex', gap: 8, margin: '14px 16px 16px' }}>
          <button
            style={{
              flex: 1,
              height: 42,
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
            <Svg d={I.user} size={15} color={c.text} /> View profile
          </button>
          <button
            style={{
              flex: 1,
              height: 42,
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
            <Svg d={I.video} size={15} color="#fff" /> Book a call
          </button>
        </div>
      </div>
    </div>
  );
}

function ExpertListRow({ expert }) {
  const [g1, g2] = gradientFromId(expert.id);
  const tagline = useMemo(() => buildTagline(expert.taglineProducts), [expert.taglineProducts]);
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
          width: 220,
          flexShrink: 0,
          alignSelf: 'stretch',
          background: `linear-gradient(135deg, ${c.heroFrom}, ${c.heroTo})`,
          overflow: 'hidden',
        }}
      >
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
            <span style={{ fontSize: 28, fontWeight: 600, color: '#fff' }}>{expert.initials}</span>
          </div>
        </div>
        <AvailabilityPill kind={expert.nextAvailableAt} />
        <AgencyBadge agency={expert.agency} />
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
                  {i > 0 && <span style={{ color: c.border }}>·</span>}
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
          <span style={{ color: c.textSecondary }}> · {tagline}</span>
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

// -- Filter rail (shared content; rendered inline on desktop, in sheet on mobile) --
function FilterSection({ label, children }) {
  return (
    <div
      style={{ paddingBottom: 18, marginBottom: 18, borderBottom: `1px solid ${c.borderSubtle}` }}
    >
      <p
        style={{
          margin: '0 0 10px',
          fontSize: 11,
          fontWeight: 700,
          color: c.textTertiary,
          textTransform: 'uppercase',
          letterSpacing: '0.07em',
        }}
      >
        {label}
      </p>
      {children}
    </div>
  );
}
function CheckRow({ label, count, checked, onToggle }) {
  const [h, setH] = useState(false);
  return (
    <div
      onClick={onToggle}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '7px 8px',
        borderRadius: 8,
        cursor: 'pointer',
        background: h ? c.surfaceSubtle : 'transparent',
      }}
    >
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: 5,
          flexShrink: 0,
          border: `1.5px solid ${checked ? c.primary : c.border}`,
          background: checked ? c.primary : c.surface,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {checked && <Svg d="M20 6L9 17l-5-5" size={12} color="#fff" />}
      </span>
      <span style={{ flex: 1, fontSize: 14, color: c.textSecondary }}>{label}</span>
      {count != null && <span style={{ fontSize: 12, color: c.textTertiary }}>{count}</span>}
    </div>
  );
}
function FilterContent({ filters, toggle }) {
  const skills = [
    ['Agentforce', 18],
    ['Sales Cloud', 31],
    ['Service Cloud', 24],
    ['Data Cloud', 14],
    ['Marketing Cloud', 11],
    ['CPQ', 9],
  ];
  const support = [
    ['Technical fix / support', 22],
    ['Architecture / design', 17],
    ['Admin / config', 28],
    ['Strategy / advisory', 13],
  ];
  const langs = [
    ['English', 52],
    ['Spanish', 8],
    ['Hindi', 6],
    ['French', 5],
  ];
  return (
    <>
      <FilterSection label="Skills">
        {skills.map(([s, n]) => (
          <CheckRow
            key={s}
            label={s}
            count={n}
            checked={filters.has(s)}
            onToggle={() => toggle(s)}
          />
        ))}
      </FilterSection>
      <FilterSection label="Support type">
        {support.map(([s, n]) => (
          <CheckRow
            key={s}
            label={s}
            count={n}
            checked={filters.has(s)}
            onToggle={() => toggle(s)}
          />
        ))}
      </FilterSection>
      <FilterSection label="Rate (per minute)">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px' }}>
          <span style={{ fontSize: 13, color: c.textSecondary }}>A$1</span>
          <div
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              background: c.border,
              position: 'relative',
            }}
          >
            <div
              style={{
                position: 'absolute',
                left: '10%',
                right: '30%',
                top: 0,
                bottom: 0,
                borderRadius: 2,
                background: c.gradient,
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: '10%',
                top: -5,
                width: 14,
                height: 14,
                borderRadius: '50%',
                background: '#fff',
                border: `2px solid ${c.primary}`,
                transform: 'translateX(-50%)',
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: '70%',
                top: -5,
                width: 14,
                height: 14,
                borderRadius: '50%',
                background: '#fff',
                border: `2px solid ${c.primary}`,
                transform: 'translateX(-50%)',
              }}
            />
          </div>
          <span style={{ fontSize: 13, color: c.textSecondary }}>A$8</span>
        </div>
      </FilterSection>
      <FilterSection label="Languages">
        {langs.map(([s, n]) => (
          <CheckRow
            key={s}
            label={s}
            count={n}
            checked={filters.has(s)}
            onToggle={() => toggle(s)}
          />
        ))}
      </FilterSection>
    </>
  );
}

// Desktop rail (inline column). In production: `hidden md:block`.
function DesktopRail({ filters, toggle }) {
  return (
    <div style={{ width: 252, flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
        <Svg d={I.sliders} size={16} color={c.text} />
        <span style={{ fontSize: 14, fontWeight: 700, color: c.text }}>Filters</span>
      </div>
      <FilterContent filters={filters} toggle={toggle} />
    </div>
  );
}

// Mobile filter SHEET: partial-height, backdrop dismiss, sticky "Show N" footer.
function FilterSheet({ open, onClose, filters, toggle, resultCount }) {
  if (!open) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100 }}>
      <div
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(15,23,41,0.45)',
          animation: 'fadeIn 0.2s ease-out',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          maxHeight: '82%',
          background: c.surface,
          borderRadius: '20px 20px 0 0',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 -8px 40px rgba(0,0,0,0.2)',
          animation: 'sheetUp 0.28s cubic-bezier(0.16,1,0.3,1)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 10 }}>
          <div style={{ width: 40, height: 4, borderRadius: 2, background: c.border }} />
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 20px 12px',
            borderBottom: `1px solid ${c.borderSubtle}`,
          }}
        >
          <span style={{ fontSize: 16, fontWeight: 700, color: c.text }}>Filters</span>
          <button
            onClick={onClose}
            style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              border: 'none',
              background: c.surfaceSubtle,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Svg d={I.x} size={16} color={c.textSecondary} />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px 8px' }}>
          <FilterContent filters={filters} toggle={toggle} />
        </div>
        <div
          style={{
            padding: '12px 20px 20px',
            borderTop: `1px solid ${c.borderSubtle}`,
            background: c.surface,
          }}
        >
          <button
            onClick={onClose}
            style={{
              width: '100%',
              height: 50,
              borderRadius: 12,
              border: 'none',
              background: c.gradient,
              color: '#fff',
              fontSize: 15,
              fontWeight: 650,
              cursor: 'pointer',
              boxShadow: `0 2px 10px ${c.primaryGlow}`,
            }}
          >
            Show {resultCount} experts
          </button>
        </div>
      </div>
    </div>
  );
}

function Toolbar({
  total,
  shown,
  isMobile,
  view,
  setView,
  sort,
  setSort,
  onOpenFilters,
  activeCount,
}) {
  const [sortOpen, setSortOpen] = useState(false);
  const sorts = ['Best match', 'Soonest available', 'Lowest rate', 'Most experienced'];
  return (
    <div style={{ marginBottom: 18 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: isMobile ? 19 : 22, fontWeight: 700, color: c.text }}>
            <span>{shown}</span>{' '}
            <span style={{ fontWeight: 500, color: c.textSecondary }}>of {total} experts</span>
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
            <Svg d={I.shield} size={13} color={c.success} style={{ flexShrink: 0 }} />
            <span style={{ fontSize: isMobile ? 12 : 13, color: c.textSecondary }}>
              {isMobile
                ? 'Every expert is vetted · money-back guarantee'
                : "Every Balo expert is individually vetted · prices in A$ · 100% money-back if the first 5 minutes don't help"}
            </span>
          </div>
        </div>
        {!isMobile && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <div
              style={{
                display: 'inline-flex',
                gap: 2,
                padding: 3,
                borderRadius: 9,
                background: c.surfaceSubtle,
                border: `1px solid ${c.borderSubtle}`,
              }}
            >
              {[
                ['grid', I.grid],
                ['list', I.list],
              ].map(([k, icon]) => (
                <button
                  key={k}
                  onClick={() => setView(k)}
                  style={{
                    width: 32,
                    height: 30,
                    borderRadius: 7,
                    border: 'none',
                    cursor: 'pointer',
                    background: view === k ? c.surface : 'transparent',
                    boxShadow: view === k ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Svg d={icon} size={15} color={view === k ? c.primary : c.textTertiary} />
                </button>
              ))}
            </div>
            <SortDropdown
              sort={sort}
              setSort={setSort}
              sorts={sorts}
              open={sortOpen}
              setOpen={setSortOpen}
            />
          </div>
        )}
      </div>

      {/* Mobile controls row: Filters button + sort (no grid/list toggle) */}
      {isMobile && (
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <button
            onClick={onOpenFilters}
            style={{
              flex: 1,
              height: 44,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              borderRadius: 10,
              border: `1px solid ${c.border}`,
              background: c.surface,
              fontSize: 14,
              fontWeight: 600,
              color: c.text,
              cursor: 'pointer',
            }}
          >
            <Svg d={I.sliders} size={16} color={c.text} /> Filters
            {activeCount > 0 && (
              <span
                style={{
                  minWidth: 20,
                  height: 20,
                  padding: '0 6px',
                  borderRadius: 10,
                  background: c.primary,
                  color: '#fff',
                  fontSize: 11,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {activeCount}
              </span>
            )}
          </button>
          <div style={{ flex: 1 }}>
            <SortDropdown
              sort={sort}
              setSort={setSort}
              sorts={sorts}
              open={sortOpen}
              setOpen={setSortOpen}
              full
            />
          </div>
        </div>
      )}
    </div>
  );
}
function SortDropdown({ sort, setSort, sorts, open, setOpen, full }) {
  return (
    <div style={{ position: 'relative', width: full ? '100%' : undefined }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: full ? '100%' : undefined,
          display: 'flex',
          alignItems: 'center',
          justifyContent: full ? 'space-between' : undefined,
          gap: 8,
          height: full ? 44 : 36,
          padding: '0 14px',
          borderRadius: full ? 10 : 9,
          border: `1px solid ${c.border}`,
          background: c.surface,
          cursor: 'pointer',
          fontSize: full ? 14 : 13,
          fontWeight: full ? 600 : 500,
          color: c.text,
        }}
      >
        {sort}{' '}
        <Svg
          d={I.chevDown}
          size={14}
          color={c.textTertiary}
          style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
        />
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            left: full ? 0 : undefined,
            minWidth: 190,
            background: c.surface,
            borderRadius: 10,
            border: `1px solid ${c.border}`,
            boxShadow: '0 8px 28px rgba(0,0,0,0.12)',
            zIndex: 30,
            overflow: 'hidden',
            padding: 6,
          }}
        >
          {sorts.map((s) => (
            <div
              key={s}
              onClick={() => {
                setSort(s);
                setOpen(false);
              }}
              style={{
                padding: '9px 10px',
                borderRadius: 7,
                fontSize: 14,
                cursor: 'pointer',
                background: s === sort ? c.primaryLight : 'transparent',
                color: s === sort ? c.primary : c.text,
                fontWeight: s === sort ? 600 : 400,
              }}
            >
              {s}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Pagination({ page, setPage, pages = 5, isMobile }) {
  const btn = (active) => ({
    minWidth: 36,
    height: 36,
    borderRadius: 9,
    border: `1px solid ${active ? c.primary : c.border}`,
    background: active ? c.primaryLight : c.surface,
    color: active ? c.primary : c.textSecondary,
    fontSize: 13,
    fontWeight: active ? 700 : 500,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 6px',
  });
  const nums = isMobile ? [page] : Array.from({ length: pages }, (_, i) => i + 1);
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 8,
        marginTop: 32,
      }}
    >
      <button onClick={() => setPage(Math.max(1, page - 1))} style={btn(false)}>
        <Svg d={I.chevLeft} size={15} color={c.textSecondary} />
      </button>
      {isMobile ? (
        <span style={{ fontSize: 13, color: c.textSecondary, padding: '0 8px' }}>
          Page {page} of {pages}
        </span>
      ) : (
        nums.map((p) => (
          <button key={p} onClick={() => setPage(p)} style={btn(p === page)}>
            {p}
          </button>
        ))
      )}
      <button
        onClick={() => setPage(Math.min(pages, page + 1))}
        style={{ ...btn(false), padding: '0 14px', gap: 6, fontWeight: 500 }}
      >
        Next <Svg d={I.chevRight} size={14} color={c.textSecondary} />
      </button>
    </div>
  );
}

function ActiveChips({ filters, toggle, clearAll }) {
  if (filters.size === 0) return null;
  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}
    >
      <span
        style={{
          fontSize: 12,
          fontWeight: 700,
          color: c.textTertiary,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        Active
      </span>
      {[...filters].map((f) => (
        <span
          key={f}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 6px 5px 12px',
            borderRadius: 999,
            fontSize: 13,
            fontWeight: 500,
            color: c.primary,
            background: c.primaryLight,
            border: `1px solid ${c.primaryBorder}`,
          }}
        >
          {f}
          <button
            onClick={() => toggle(f)}
            style={{
              width: 18,
              height: 18,
              borderRadius: '50%',
              border: 'none',
              background: 'rgba(37,99,235,0.12)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Svg d={I.x} size={11} color={c.primary} />
          </button>
        </span>
      ))}
      <button
        onClick={clearAll}
        style={{
          fontSize: 13,
          fontWeight: 500,
          color: c.textSecondary,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          textDecoration: 'underline',
          textUnderlineOffset: 2,
        }}
      >
        Clear all
      </button>
    </div>
  );
}

function Hero({ query, setQuery, isMobile }) {
  const [focus, setFocus] = useState(false);
  return (
    <div
      style={{
        borderRadius: 18,
        background: c.gradientSubtle,
        border: `1px solid ${c.accentBorder}55`,
        padding: isMobile ? '22px 18px 24px' : '28px 28px 30px',
        marginBottom: isMobile ? 22 : 28,
      }}
    >
      <h1 style={{ margin: 0, fontSize: isMobile ? 22 : 26, fontWeight: 700, color: c.text }}>
        Find a Salesforce expert
      </h1>
      <p style={{ margin: '6px 0 18px', fontSize: 14, color: c.textSecondary }}>
        Describe what you need help with — we'll match you with vetted consultants who can jump on a
        call.
      </p>
      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 10 }}>
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            height: 52,
            padding: '0 16px',
            borderRadius: 12,
            background: c.surface,
            border: `1.5px solid ${focus ? c.primary : c.border}`,
            boxShadow: focus ? `0 0 0 3px ${c.primaryGlow}` : '0 1px 3px rgba(0,0,0,0.04)',
            transition: 'all 0.2s',
          }}
        >
          <Svg d={I.search} size={18} color={c.textTertiary} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
            placeholder={
              isMobile
                ? 'What do you need help with?'
                : 'e.g. Agentforce rollout for a mid-market support team'
            }
            style={{
              flex: 1,
              minWidth: 0,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontSize: 15,
              color: c.text,
              fontFamily: 'inherit',
            }}
          />
        </div>
        <button
          style={{
            height: 52,
            padding: '0 28px',
            borderRadius: 12,
            border: 'none',
            background: c.gradient,
            color: '#fff',
            fontSize: 15,
            fontWeight: 650,
            cursor: 'pointer',
            boxShadow: `0 2px 10px ${c.primaryGlow}`,
          }}
        >
          Search
        </button>
      </div>
    </div>
  );
}

const keyframes = `@keyframes fadeIn{from{opacity:0}to{opacity:1}}@keyframes sheetUp{from{transform:translateY(100%)}to{transform:translateY(0)}}`;

export default function ExpertSearchPage() {
  const [vw, setVw] = useState(typeof window !== 'undefined' ? window.innerWidth : 1320);
  useEffect(() => {
    // PREVIEW ONLY — do not replicate in production (use Tailwind md: classes).
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const isMobile = vw <= MOBILE_MAX;

  const [query, setQuery] = useState('');
  const [view, setView] = useState('grid');
  const [sort, setSort] = useState('Best match');
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState(new Set(['Agentforce', 'Technical fix / support']));
  const [sheetOpen, setSheetOpen] = useState(false);

  const toggle = (f) =>
    setFilters((prev) => {
      const n = new Set(prev);
      n.has(f) ? n.delete(f) : n.add(f);
      return n;
    });
  const clearAll = () => setFilters(new Set());

  // Mobile forces grid; the toggle is hidden so userChoice can't leak through.
  const effectiveView = isMobile ? 'grid' : view;

  return (
    <div
      style={{
        minHeight: '100vh',
        background: c.bg,
        fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif",
        padding: isMobile ? '20px 16px 56px' : '28px 32px 64px',
      }}
    >
      <style>{keyframes}</style>
      <link
        href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap"
        rel="stylesheet"
      />
      <div style={{ maxWidth: 1320, margin: '0 auto' }}>
        <Hero query={query} setQuery={setQuery} isMobile={isMobile} />

        <div style={{ display: 'flex', gap: 32, alignItems: 'flex-start' }}>
          {!isMobile && <DesktopRail filters={filters} toggle={toggle} />}

          <div style={{ flex: 1, minWidth: 0 }}>
            <Toolbar
              total={8}
              shown={6}
              isMobile={isMobile}
              view={view}
              setView={setView}
              sort={sort}
              setSort={setSort}
              onOpenFilters={() => setSheetOpen(true)}
              activeCount={filters.size}
            />
            <ActiveChips filters={filters} toggle={toggle} clearAll={clearAll} />

            {effectiveView === 'grid' ? (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
                  gap: isMobile ? 16 : 20,
                  alignItems: 'stretch',
                }}
              >
                {EXPERTS.map((e) => (
                  <ExpertCard key={e.id} expert={e} />
                ))}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {EXPERTS.map((e) => (
                  <ExpertListRow key={e.id} expert={e} />
                ))}
              </div>
            )}

            <Pagination page={page} setPage={setPage} pages={5} isMobile={isMobile} />
          </div>
        </div>
      </div>

      <FilterSheet
        open={isMobile && sheetOpen}
        onClose={() => setSheetOpen(false)}
        filters={filters}
        toggle={toggle}
        resultCount={6}
      />
    </div>
  );
}
