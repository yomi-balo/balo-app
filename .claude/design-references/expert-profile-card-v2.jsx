import { useState, useEffect, useRef } from 'react';

// ─────────────────────────────────────────────────────────────────
// BALO EXPERT CARD — V3
// Design reference for BAL-214
// ─────────────────────────────────────────────────────────────────

// ── Design tokens ─────────────────────────────────────────────────
const c = {
  surface: '#FFFFFF',
  surfaceSubtle: '#F1F4F8',
  border: '#E0E4EB',
  borderSubtle: '#EAEFF5',
  text: '#111827',
  textSecondary: '#4B5563',
  textTertiary: '#9CA3AF',
  primary: '#2563EB',
  primaryLight: '#EFF6FF',
  primaryBorder: '#BFDBFE',
  primaryGlow: 'rgba(37,99,235,0.14)',
  success: '#059669',
  gradient: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
};

// ── Global styles ──────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700;9..40,800&display=swap');

*, *::before, *::after { box-sizing: border-box; }

body {
  margin: 0;
  font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
  background: #E8EAF0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48px 16px;
}

/* ── Card shell ── */
.ec-card {
  width: 300px;
  border-radius: 20px;
  overflow: hidden;
  background: #fff;
  border: 1px solid #E0E4EB;
  box-shadow: 0 4px 24px rgba(0,0,0,0.09), 0 1px 4px rgba(0,0,0,0.05);
  animation: ec-slideUp 0.4s ease both;
}
@media (max-width: 360px) {
  .ec-card { width: calc(100vw - 32px); }
}

/* ── Hero photo zone ── */
.ec-hero {
  position: relative;
  height: 186px;
  overflow: hidden;
}
.ec-hero-bg {
  position: absolute;
  inset: 0;
  background: linear-gradient(160deg, #0F4C81 0%, #1e3a5f 45%, #0a1628 100%);
}
/* Subtle dot texture over the dark background */
.ec-hero-texture {
  position: absolute;
  inset: 0;
  opacity: 0.04;
  background-image: radial-gradient(circle, white 1px, transparent 1px);
  background-size: 28px 28px;
}
/* Circular avatar — centred in the top 60% of the hero */
.ec-avatar {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -56%);
  width: 104px;
  height: 104px;
  border-radius: 50%;
  border: 3px solid rgba(255,255,255,0.2);
  box-shadow: 0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.15);
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 30px;
  font-weight: 700;
  color: rgba(255,255,255,0.92);
  letter-spacing: -0.5px;
  /* background set inline — deterministic gradient per expert */
}
/* Gradient overlay fading from transparent at top to near-black at bottom */
.ec-hero-fade {
  position: absolute;
  bottom: 0; left: 0; right: 0;
  height: 56%;
  background: linear-gradient(to top,
    rgba(10,22,40,0.95) 0%,
    rgba(10,22,40,0.6) 55%,
    transparent 100%
  );
}
/* Name + rate overlaid at bottom of hero */
.ec-hero-meta {
  position: absolute;
  bottom: 0; left: 0; right: 0;
  padding: 0 16px 13px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
}
.ec-name-row {
  display: flex;
  align-items: center;
  gap: 5px;
}
.ec-name {
  font-size: 16px;
  font-weight: 700;
  color: white;
  letter-spacing: -0.2px;
}
/* Tiny green verified checkmark next to name */
.ec-verified { display: flex; }
.ec-stars-row {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 3px;
}
.ec-rating-text {
  font-size: 11px;
  color: rgba(255,255,255,0.7);
  font-weight: 500;
}
.ec-rate-block { text-align: right; }
.ec-rate-value {
  font-size: 19px;
  font-weight: 750;
  color: white;
  line-height: 1;
  letter-spacing: -0.5px;
}
.ec-rate-unit {
  font-size: 10px;
  color: rgba(255,255,255,0.5);
  margin-top: 1px;
}

/* ── Available pill — top-left of hero ── */
.ec-available {
  position: absolute;
  top: 13px; left: 12px;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px 3px 6px;
  border-radius: 20px;
  background: rgba(5,150,105,0.85);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(52,211,153,0.4);
}
.ec-available-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: #34D399;
  animation: ec-pulse 2s ease infinite;
}
.ec-available-label {
  font-size: 10px;
  font-weight: 700;
  color: white;
}

/* ── Save/favourite button — top-right of hero ── */
.ec-save-btn {
  position: absolute;
  top: 6px; right: 6px;
  width: 44px; height: 44px;
  border-radius: 50%;
  background: transparent;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
}
.ec-save-inner {
  width: 34px; height: 34px;
  border-radius: 50%;
  background: rgba(255,255,255,0.12);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255,255,255,0.2);
  display: flex;
  align-items: center;
  justify-content: center;
}

/* ── Card body ── */
.ec-body {
  padding: 13px 16px 0;
}

/* ── Title + tagline — max 2 lines combined ── */
.ec-title-block {
  font-size: 11.5px;
  line-height: 1.45;
  margin: 0 0 10px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.ec-title { font-weight: 650; color: #111827; }
.ec-tagline { color: #9CA3AF; }

/* ── Bio blurb — 3-line clamp ── */
.ec-bio-wrap {
  margin: 0 0 10px;
  padding: 8px 10px 8px 12px;
  border-radius: 8px;
  background: #F1F4F8;
  border-left: 2.5px solid #BFDBFE;
}
.ec-bio {
  font-size: 11.5px;
  color: #4B5563;
  font-style: italic;
  margin: 0;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.55;
}

/* ── Stats strip ── */
.ec-stats {
  display: flex;
  border-top: 1px solid #EAEFF5;
  border-bottom: 1px solid #EAEFF5;
  padding: 9px 0;
}
.ec-stat {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  border-right: 1px solid #EAEFF5;
}
.ec-stat:last-child { border-right: none; }
.ec-stat-label {
  font-size: 10px;
  font-weight: 550;
  color: #4B5563;
  white-space: nowrap;
}

/* ── Expertise pills section ── */
.ec-pills {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 11px 0 2px;
}

/* Each pill: "Product Name" + divider + skill-type icon(s) */
.ec-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 20px;
  background: rgba(37,99,235,0.07);
  border: 1px solid rgba(37,99,235,0.18);
  font-size: 11px;
  font-weight: 650;
  color: #2563EB;
  align-self: flex-start;
  cursor: default;
}
.ec-pill-name { /* product name text */ }
.ec-pill-divider {
  width: 1px;
  height: 12px;
  background: rgba(37,99,235,0.2);
  flex-shrink: 0;
}
/* Icon wrapper — 24×24 touch target, icon is 11px inside */
.ec-skill-icon {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: default;
  position: relative;
}

/* "+N more products" link */
.ec-more {
  display: flex;
  align-items: center;
  gap: 3px;
  padding-left: 4px;
  padding-bottom: 10px;
}
.ec-more-label {
  font-size: 11px;
  font-weight: 600;
  color: #2563EB;
  cursor: pointer;
}

/* ── CTA row ── */
.ec-ctas {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  padding: 10px 16px 16px;
}
.ec-btn-ghost {
  min-height: 44px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
  border: 1px solid #EAEFF5;
  background: white;
  color: #111827;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  transition: all 0.15s;
}
.ec-btn-ghost:hover {
  border-color: #E0E4EB;
  background: #F1F4F8;
}
.ec-btn-primary {
  min-height: 44px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
  border: none;
  background: linear-gradient(135deg, #2563EB 0%, #7C3AED 100%);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  transition: all 0.2s;
  box-shadow: 0 2px 8px rgba(37,99,235,0.25);
}
.ec-btn-primary:hover {
  background: linear-gradient(135deg, #1D4ED8 0%, #6D28D9 100%);
  box-shadow: 0 4px 16px rgba(37,99,235,0.3);
}

/* ── Tooltip ── */
.ec-tooltip-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.ec-tooltip {
  position: absolute;
  bottom: calc(100% + 7px);
  left: 50%;
  transform: translateX(-50%);
  background: #111827;
  color: white;
  font-size: 10px;
  font-weight: 600;
  padding: 5px 9px;
  border-radius: 6px;
  white-space: nowrap;
  z-index: 300;
  box-shadow: 0 4px 14px rgba(0,0,0,0.3);
  animation: ec-tooltipIn 0.15s ease both;
  pointer-events: none;
}
.ec-tooltip-arrow {
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  width: 0; height: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 4px solid #111827;
}

/* ── Animations ── */
@keyframes ec-slideUp {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes ec-tooltipIn {
  from { opacity: 0; transform: translateX(-50%) translateY(4px) scale(0.96); }
  to   { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
}
@keyframes ec-heartBeat {
  0%   { transform: scale(1); }
  30%  { transform: scale(1.35); }
  60%  { transform: scale(0.9); }
  100% { transform: scale(1); }
}
@keyframes ec-pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.5; }
}
`;

// ── Inline SVG icons ───────────────────────────────────────────────
// All Lucide icons at strokeWidth=2, strokeLinecap=round, strokeLinejoin=round
const Svg = ({ size = 16, color = 'currentColor', children }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);

const Icons = {
  // ★ Star — rating display, fill prop controls solid vs outline
  star: ({ size, color, fill }) => (
    <Svg size={size} color={color}>
      <polygon
        points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
        fill={fill || 'none'}
      />
    </Svg>
  ),

  // ✓ Check — verified badge next to name (green), CTA button
  check: ({ size, color }) => (
    <Svg size={size} color={color}>
      <path d="M20 6L9 17l-5-5" />
    </Svg>
  ),

  // ♥ Heart — save/favourite button
  heart: ({ size, color, fill }) => (
    <Svg size={size} color={color}>
      <path
        d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"
        fill={fill || 'none'}
      />
    </Svg>
  ),

  // 📍 MapPin — location stat
  mapPin: ({ size, color }) => (
    <Svg size={size} color={color}>
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
      <circle cx="12" cy="10" r="3" />
    </Svg>
  ),

  // 🏅 Award — certifications stat
  award: ({ size, color }) => (
    <Svg size={size} color={color}>
      <circle cx="12" cy="8" r="7" />
      <polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88" />
    </Svg>
  ),

  // 📹 Video — sessions stat, "Book a call" CTA
  video: ({ size, color }) => (
    <Svg size={size} color={color}>
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" />
    </Svg>
  ),

  // 👤 User — "View profile" CTA
  user: ({ size, color }) => (
    <Svg size={size} color={color}>
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </Svg>
  ),

  // › ChevronRight — "+N more products" suffix
  chevRight: ({ size, color }) => (
    <Svg size={size} color={color}>
      <path d="M9 18l6-6-6-6" />
    </Svg>
  ),

  // ── Skill-type icons (used inside expertise pills) ──

  // </> Code — "Technical / Dev" skill type (blue #2563EB)
  // Two facing angle brackets representing code
  code: ({ size, color }) => (
    <Svg size={size} color={color}>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </Svg>
  ),

  // ⊟ Layers — "Architecture & Integrations" skill type (violet #7C3AED)
  // Three stacked horizontal shapes representing layers / system architecture
  layers: ({ size, color }) => (
    <Svg size={size} color={color}>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </Svg>
  ),

  // ⚙ Settings — "Configuration & Admin" skill type (cyan #0891B2)
  // Classic gear/cog representing system administration
  settings: ({ size, color }) => (
    <Svg size={size} color={color}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
    </Svg>
  ),

  // ◎ Target — "Strategy & Consulting" skill type (emerald #059669)
  // Concentric circles / bullseye representing strategic focus
  target: ({ size, color }) => (
    <Svg size={size} color={color}>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </Svg>
  ),
};

// ── Skill type definitions ─────────────────────────────────────────
// Each skill type has: key, human label, Lucide icon, colour
const SKILL_TYPES = [
  {
    key: 'technical',
    label: 'Technical / Dev',
    icon: Icons.code,
    color: '#2563EB', // Balo primary blue
  },
  {
    key: 'architecture',
    label: 'Architecture & Integrations',
    icon: Icons.layers,
    color: '#7C3AED', // Balo accent violet
  },
  {
    key: 'admin',
    label: 'Configuration & Admin',
    icon: Icons.settings,
    color: '#0891B2', // Cyan
  },
  {
    key: 'strategy',
    label: 'Strategy & Consulting',
    icon: Icons.target,
    color: '#059669', // Emerald green
  },
];

// ── Deterministic avatar gradient ─────────────────────────────────
// Maps expert.id to one of 6 gradients via character-sum hash.
// Same expert always gets the same gradient on every render.
const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #0F4C81 0%, #2a7fd4 100%)',
  'linear-gradient(135deg, #1e3a5f 0%, #0F4C81 100%)',
  'linear-gradient(135deg, #3b0764 0%, #7C3AED 100%)',
  'linear-gradient(135deg, #064e3b 0%, #059669 100%)',
  'linear-gradient(135deg, #7c2d12 0%, #ea580c 100%)',
  'linear-gradient(135deg, #1e1b4b 0%, #4F46E5 100%)',
];
function getAvatarGradient(id) {
  const hash = id.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length];
}

// ── Derive tagline from expertise ──────────────────────────────────
// Top 3 product names joined with " · " — no user input needed
function deriveTagline(expertise) {
  return expertise
    .slice(0, 3)
    .map((e) => e.product)
    .join(' · ');
}

// ── Sample expert data ─────────────────────────────────────────────
const EXPERT = {
  id: 'usr_anil_pilania',
  name: 'Anil Pilania',
  initials: 'AP',
  avatarKey: null, // null → gradient avatar with initials
  title: 'Salesforce Strategy & Solution Architect',
  bio: '15x certified Salesforce architect with 9 years delivering enterprise transformations across financial services, telco, and retail. I specialise in Data Cloud, Agentforce, and complex CRM integrations that actually ship on time.',
  location: 'Canada',
  yearsExp: 9,
  certifications: 15,
  consultationCount: 47, // set to 0 to test hidden stat
  rating: 4.9,
  reviewCount: 31, // set to 0 to test hidden stars
  rate: 3.13, // client-facing rate (markup already applied)
  available: true,
  expertise: [
    { product: 'Data Cloud', skills: ['technical', 'architecture', 'admin'] },
    { product: 'Agentforce', skills: ['technical', 'architecture', 'strategy'] },
    { product: 'Sales Cloud', skills: ['admin', 'strategy', 'architecture'] },
    { product: 'Service Cloud', skills: ['admin', 'technical'] },
    { product: 'Marketing Cloud', skills: ['technical', 'strategy'] },
  ],
};

// ─────────────────────────────────────────────────────────────────
// TOOLTIP
// Hover on desktop · tap-to-toggle on touch
// Tap outside to dismiss
// ─────────────────────────────────────────────────────────────────
function Tooltip({ label, children }) {
  const [visible, setVisible] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!visible) return;
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setVisible(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [visible]);

  return (
    <div
      ref={ref}
      className="ec-tooltip-wrap"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onPointerDown={(e) => {
        e.stopPropagation();
        setVisible((v) => !v);
      }}
    >
      {children}
      {visible && (
        <div className="ec-tooltip">
          {label}
          <div className="ec-tooltip-arrow" />
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// STARS
// ─────────────────────────────────────────────────────────────────
function Stars({ rating, size = 10 }) {
  return (
    <div style={{ display: 'flex', gap: 1 }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Icons.star
          key={i}
          size={size}
          color="#F59E0B"
          fill={i <= Math.floor(rating) ? '#F59E0B' : 'none'}
        />
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// EXPERTISE PILL
//
// Layout: [Product name] | [skill icon] [skill icon] ...
//
// The vertical divider separates the product label from the
// skill-type icon cluster. Each icon is wrapped in a 24×24 touch
// target that shows a tooltip on hover/tap naming the skill type.
//
// Max 3 pills rendered; remainder shown as "+N more products".
// ─────────────────────────────────────────────────────────────────
function ExpertisePill({ product, skills }) {
  return (
    <div className="ec-pill">
      <span className="ec-pill-name">{product}</span>
      <div className="ec-pill-divider" />
      {skills.map((sk) => {
        const type = SKILL_TYPES.find((t) => t.key === sk);
        if (!type) return null;
        const I = type.icon;
        return (
          <Tooltip key={sk} label={type.label}>
            <div className="ec-skill-icon">
              <I size={11} color="#2563EB" />
            </div>
          </Tooltip>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// EXPERT CARD
// ─────────────────────────────────────────────────────────────────
function ExpertCard({ expert = EXPERT }) {
  const [saved, setSaved] = useState(false);

  const tagline = deriveTagline(expert.expertise);
  const avatarBg = expert.avatarKey ? undefined : getAvatarGradient(expert.id);
  const visiblePills = expert.expertise.slice(0, 3);
  const extraCount = expert.expertise.length - 3;

  // Build stats — only include non-zero values
  const stats = [
    { icon: Icons.mapPin, label: expert.location, always: true },
    { icon: Icons.award, label: `${expert.yearsExp}y exp`, always: true },
    { icon: Icons.award, label: `${expert.certifications} certs`, show: expert.certifications > 0 },
    {
      icon: Icons.video,
      label: `${expert.consultationCount} sessions`,
      show: expert.consultationCount > 0,
    },
  ].filter((s) => s.always || s.show);

  const showReviews = expert.reviewCount > 0 && expert.rating !== null;

  return (
    <div className="ec-card">
      {/* ────────────────────────────────────────
          HERO ZONE — dark photo/gradient background
          with name, rating, and rate overlaid
          ──────────────────────────────────────── */}
      <div className="ec-hero">
        <div className="ec-hero-bg" />
        <div className="ec-hero-texture" />

        {/* Avatar — photo or deterministic gradient + initials */}
        <div className="ec-avatar" style={{ background: avatarBg }}>
          {expert.avatarKey ? (
            <img
              src={`/cdn-cgi/image/width=208,height=208,fit=cover,gravity=face,quality=85/${expert.avatarKey}`}
              alt={expert.name}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            expert.initials
          )}
        </div>

        <div className="ec-hero-fade" />

        {/* Name · verified · stars · rate */}
        <div className="ec-hero-meta">
          <div>
            <div className="ec-name-row">
              <span className="ec-name">{expert.name}</span>
              <span className="ec-verified">
                <Icons.check size={13} color="#34D399" />
              </span>
            </div>
            {showReviews && (
              <div className="ec-stars-row">
                <Stars rating={expert.rating} size={10} />
                <span className="ec-rating-text">
                  {expert.rating} <span style={{ opacity: 0.6 }}>({expert.reviewCount})</span>
                </span>
              </div>
            )}
          </div>
          <div className="ec-rate-block">
            <div className="ec-rate-value">A${expert.rate.toFixed(2)}</div>
            <div className="ec-rate-unit">per minute</div>
          </div>
        </div>

        {/* Available pill */}
        {expert.available && (
          <div className="ec-available">
            <div className="ec-available-dot" />
            <span className="ec-available-label">Available</span>
          </div>
        )}

        {/* Save button — 44×44 touch target wrapping 34×34 visible button */}
        <button
          className="ec-save-btn"
          onClick={() => setSaved((s) => !s)}
          style={{ animation: saved ? 'ec-heartBeat 0.4s ease' : 'none' }}
          aria-label={saved ? 'Unsave expert' : 'Save expert'}
        >
          <div className="ec-save-inner">
            <Icons.heart
              size={15}
              color={saved ? '#F43F5E' : 'white'}
              fill={saved ? '#F43F5E' : 'none'}
            />
          </div>
        </button>
      </div>

      {/* ────────────────────────────────────────
          BODY
          ──────────────────────────────────────── */}
      <div className="ec-body">
        {/* Title + tagline — clamped to 2 lines */}
        <p className="ec-title-block">
          <span className="ec-title">{expert.title}</span>
          {tagline && <span className="ec-tagline"> · {tagline}</span>}
        </p>

        {/* Bio blurb — hidden if null/empty, clamped to 3 lines */}
        {expert.bio && (
          <div className="ec-bio-wrap">
            <p className="ec-bio">{expert.bio}</p>
          </div>
        )}

        {/* Stats strip — flex-distributed, only visible stats shown */}
        <div className="ec-stats">
          {stats.map(({ icon: I, label }, i) => (
            <div className="ec-stat" key={i}>
              <I size={13} color="#2563EB" />
              <span className="ec-stat-label">{label}</span>
            </div>
          ))}
        </div>

        {/* Expertise pills */}
        <div className="ec-pills">
          {visiblePills.map(({ product, skills }) => (
            <ExpertisePill key={product} product={product} skills={skills} />
          ))}
          {extraCount > 0 && (
            <div className="ec-more">
              <span className="ec-more-label">+{extraCount} more products</span>
              <Icons.chevRight size={11} color="#2563EB" />
            </div>
          )}
        </div>
      </div>

      {/* ────────────────────────────────────────
          CTA ROW — two equal-width buttons
          ──────────────────────────────────────── */}
      <div className="ec-ctas">
        <button className="ec-btn-ghost">
          <Icons.user size={13} color="#4B5563" />
          View profile
        </button>
        <button className="ec-btn-primary">
          <Icons.video size={13} color="white" />
          Book a call
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ROOT
// ─────────────────────────────────────────────────────────────────
export default function ExpertCardV3() {
  return (
    <>
      <style>{CSS}</style>
      <ExpertCard expert={EXPERT} />
    </>
  );
}
