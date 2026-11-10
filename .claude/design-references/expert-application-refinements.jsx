/**
 * Expert application refinements: design reference for BAL-643 (6 Nov Ybug session).
 *
 * Covers only the surfaces BAL-643 changes. The rest of the wizard is unchanged, and
 * `expert-application-wizard.jsx` / `application-review-page.jsx` stay the references for it.
 *
 * Colour rule (9 Nov): one accent, primary blue, only for things you can act on or have chosen
 * (buttons, links, sliders, selected chips, progress, the rating ramp). Everything else is neutral.
 * Amber only means "needs attention"; red only means an error.
 *
 * Rating scale (10 Nov): NO BANDS. Each number from 0 to 10 has its own title and description,
 * built from the scale experts rate against in Bubble and sharpened so each level differs by
 * something an expert can check against their own history, and an interviewer can ask about.
 *   → Replaces the None/Beginner/Intermediate/Advanced/Expert bands from `proficiencyToLevel`.
 *     The label beside each slider is the level's title; the public profile shows number + title.
 *   → The 7+ search rule (BAL-639) is not shown to experts.
 *
 * Switch surfaces with the tabs at the top (three: Products has no design change); use Desktop / Mobile for width.
 *   1. Profile: Salesforce Distinctions without "Certified Salesforce Trainer".
 *   2. Products: NO DESIGN CHANGE, so not drawn here. Keep the existing search box and dropdown.
 *      The only change: in the dropdown, a category with many products lists all of them instead of
 *      the first few and "+N more". Add an opt-in prop to TaxonomyMultiSelect that turns the collapse
 *      off; the apply wizard passes it, other callers (project-request panel, booking dialog) don't.
 *   3. Rate your expertise: the guide lists all eleven levels. Each slider is segmented: ten segments
 *      fill up to the value and the knob sits at the end of the last filled one, so the track is
 *      also the indicator. Its title sits beside it and its description underneath, both updating
 *      as it moves. "Between two levels? Choose the lower one." sits above the products.
 *   4. Review and submit (final step): the full application summary sits ABOVE the terms. It
 *      REPLACES the count-only "Review your application" collapsible in `step-terms.tsx`.
 *      The summary shares its sections with `application-review.tsx` (post-submit page), so
 *      that page takes the same neutral treatment.
 *
 * Copy needing MJ sign-off: the eleven level titles and descriptions, and the final step's title
 * and subtitle. Action bar behaviour is unchanged (BAL-327); it is shown for context only.
 * All data is illustrative.
 */
import { useState, useRef, useEffect } from 'react';
import {
  Briefcase,
  Award,
  Check,
  Globe,
  Building2,
  Compass,
  GraduationCap,
  Sparkles,
  Wrench,
  Shield,
  Monitor,
  Smartphone,
  ArrowLeft,
  ExternalLink,
  Clock,
  AlertTriangle,
  ClipboardCheck,
} from 'lucide-react';

// ── Tokens ─────────────────────────────────────────────────────────

const C = {
  page: '#EEF1F5',
  bg: '#F8FAFB',
  surface: '#FFFFFF',
  surfaceSubtle: '#F1F4F8',
  border: '#E0E4EB',
  borderSubtle: '#EAEFF5',
  text: '#111827',
  textSecondary: '#4B5563',
  textMuted: '#6B7280',
  textTertiary: '#9CA3AF',
  primary: '#2563EB',
  primaryLight: '#EFF6FF',
  primaryBorder: '#BFDBFE',
  attention: '#B45309',
  attentionLight: '#FFFBEB',
  attentionBorder: '#FDE68A',
  error: '#DC2626',
};

const FONT = "'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";

// ── Rating scale: one title + description per number (no bands); copy pending MJ ──
// `fill` is a plain light-to-dark ramp, used by the slider's filled segments and the guide's number tiles.

const SCALE = [
  { value: 0, title: 'No experience', fill: '#E5E7EB', def: "You haven't worked with this." },
  {
    value: 1,
    title: 'Very limited',
    fill: '#BFDBFE',
    def: "You know what it is, but haven't used it hands-on.",
  },
  {
    value: 2,
    title: 'Basic awareness',
    fill: '#A8CFFD',
    def: 'You understand the fundamentals from training or a sandbox, but not from real work.',
  },
  {
    value: 3,
    title: 'Limited experience',
    fill: '#93C5FD',
    def: "You've done basic tasks on real work, with someone checking.",
  },
  {
    value: 4,
    title: 'Novice',
    fill: '#7AB6FB',
    def: "You've done this on real work a few times, following instructions, and still need guidance.",
  },
  {
    value: 5,
    title: 'Intermediate',
    fill: '#60A5FA',
    def: 'You handle standard tasks on your own, and ask for help with anything unusual.',
  },
  {
    value: 6,
    title: 'Proficient',
    fill: '#3B82F6',
    def: 'You handle most tasks on your own, including troubleshooting common issues.',
  },
  {
    value: 7,
    title: 'Advanced',
    fill: '#2563EB',
    def: 'You handle complex work on your own, and teammates come to you for help with it.',
  },
  {
    value: 8,
    title: 'Highly experienced',
    fill: '#1D4ED8',
    def: "You've handled complex work across several clients or orgs, and people outside your team come to you for advice.",
  },
  {
    value: 9,
    title: 'Expert',
    fill: '#1E40AF',
    def: 'You take on the hardest cases, and set the approach others follow.',
  },
  {
    value: 10,
    title: 'Master',
    fill: '#1E3A8A',
    def: "You're recognised beyond your own clients and employer, for example through talks, published work or Salesforce recognition.",
  },
];
const levelFor = (v) => SCALE[Math.max(0, Math.min(10, v))];

const DIMENSIONS = [
  {
    slug: 'technical-fix',
    name: 'Technical Fix',
    icon: Wrench,
    desc: 'Solving specific bugs, errors, and configuration issues',
  },
  {
    slug: 'architecture',
    name: 'Architecture',
    icon: Building2,
    desc: 'Designing systems, data models, and integrations',
  },
  {
    slug: 'strategy',
    name: 'Strategy',
    icon: Compass,
    desc: 'Advising on roadmap, best practices, and business alignment',
  },
  {
    slug: 'training',
    name: 'Training',
    icon: GraduationCap,
    desc: 'Teaching teams, creating documentation, enablement',
  },
];

// ── Illustrative data ──────────────────────────────────────────────

const INITIAL_SELECTED = [
  'Sales Cloud',
  'Service Cloud',
  'Revenue Cloud',
  'Manufacturing Cloud',
  'Data Cloud',
];

const INITIAL_RATINGS = {
  'Sales Cloud': { 'technical-fix': 8, architecture: 7, strategy: 6, training: 5 },
  'Service Cloud': { 'technical-fix': 7, architecture: 6, strategy: 4, training: 3 },
  'Revenue Cloud': { 'technical-fix': 5, architecture: 4, strategy: 2, training: 0 },
  'Manufacturing Cloud': { 'technical-fix': 3, architecture: 2, strategy: 2, training: 0 },
};

const PROFILE = {
  yearStarted: 2014,
  projects: '21–50',
  projectsAsLead: '6–20',
  linkedin: 'linkedin.com/in/sam-okafor',
  languages: [
    { name: 'English', flag: '🇬🇧', level: 'Native' },
    { name: 'French', flag: '🇫🇷', level: 'Intermediate' },
  ],
  industries: ['Manufacturing', 'Financial Services', 'Retail'],
  trailhead: 'trailblazer.me/id/sokafor',
  certifications: [
    { name: 'Application Architect', category: 'Architect' },
    { name: 'Platform Developer I', category: 'Developer' },
    { name: 'Sales Cloud Consultant', category: 'Consultant' },
    { name: 'Service Cloud Consultant', category: 'Consultant' },
    { name: 'CPQ Specialist', category: 'Specialist' },
  ],
  workHistory: [
    {
      role: 'Salesforce Technical Architect',
      company: 'Northwind Consulting',
      dates: 'Mar 2021 – Present',
      current: true,
    },
    {
      role: 'Senior Salesforce Developer',
      company: 'Bluewater Logistics',
      dates: 'Jun 2016 – Feb 2021',
      current: false,
    },
  ],
};

const TABS = [
  { key: 'profile', label: 'Profile', step: 1 },
  { key: 'assessment', label: 'Rate your expertise', step: 4 },
  { key: 'review', label: 'Review and submit', step: 7 },
];
const TOTAL_STEPS = 7;

// ── Shared pieces ──────────────────────────────────────────────────

function StepHeading({ icon: Icon, title, subtitle, mobile }) {
  return (
    <div className="flex items-start gap-3" style={{ marginBottom: 24 }}>
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 11,
          background: C.surfaceSubtle,
          border: `1px solid ${C.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Icon size={20} color={C.textSecondary} aria-hidden="true" />
      </div>
      <div>
        <h2
          style={{
            margin: 0,
            fontSize: mobile ? 20 : 24,
            fontWeight: 700,
            letterSpacing: '-0.015em',
            color: C.text,
          }}
        >
          {title}
        </h2>
        <p
          style={{
            margin: '4px 0 0',
            fontSize: 14,
            lineHeight: 1.55,
            color: C.textSecondary,
            maxWidth: 560,
          }}
        >
          {subtitle}
        </p>
      </div>
    </div>
  );
}

function SectionLabel({ icon: Icon, children }) {
  return (
    <div className="flex items-center gap-2">
      <Icon size={16} color={C.textMuted} aria-hidden="true" />
      <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{children}</span>
    </div>
  );
}

function Card({ children, style }) {
  return (
    <div
      style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, ...style }}
    >
      {children}
    </div>
  );
}

/** Design-reference annotation for CC. Not product UI. */
function Note({ children }) {
  return (
    <div
      style={{
        marginTop: 20,
        padding: '10px 14px',
        borderRadius: 10,
        border: `1px dashed ${C.border}`,
        background: C.surfaceSubtle,
        color: C.textSecondary,
        fontSize: 12.5,
        lineHeight: 1.5,
      }}
    >
      <strong style={{ fontWeight: 600, color: C.text }}>Design note: </strong>
      {children}
    </div>
  );
}

/**
 * Segmented 0–10 slider. Ten segments fill up to the value, and the knob sits at the end of the last
 * filled segment, so the track is also the indicator. Pressing anywhere in segment k sets k (rounds up,
 * not to the nearest step). Pressing left of the first segment, or dragging past it, sets 0.
 * Keyboard: arrows ±1, PageUp/PageDown ±2, Home 0, End 10.
 */
function SegmentedSlider({ value, onChange, label, valueText, mobile }) {
  const trackRef = useRef(null);
  const dragging = useRef(false);
  const thumb = mobile ? 24 : 20;

  const valueAt = (clientX) => {
    const rect = trackRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    if (x <= 0) return 0;
    return Math.min(10, Math.ceil((x / rect.width) * 10));
  };
  const set = (v) => {
    if (v !== value) onChange(v);
  };
  const end = () => {
    dragging.current = false;
  };

  const onPointerDown = (e) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    set(valueAt(e.clientX));
  };
  const onPointerMove = (e) => {
    if (dragging.current) set(valueAt(e.clientX));
  };
  const onKeyDown = (e) => {
    const next = {
      ArrowRight: value + 1,
      ArrowUp: value + 1,
      ArrowLeft: value - 1,
      ArrowDown: value - 1,
      PageUp: value + 2,
      PageDown: value - 2,
      Home: 0,
      End: 10,
    }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    set(Math.max(0, Math.min(10, next)));
  };

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={10}
      aria-valuenow={value}
      aria-valuetext={valueText}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
      className="focus:outline-none focus-visible:ring-2"
      style={{
        position: 'relative',
        padding: `${mobile ? 15 : 12}px ${thumb / 2}px`,
        cursor: 'pointer',
        touchAction: 'none',
        borderRadius: 8,
        userSelect: 'none',
      }}
    >
      <div
        ref={trackRef}
        style={{ position: 'relative', display: 'flex', gap: 3, height: mobile ? 5 : 4 }}
      >
        {SCALE.slice(1).map((l) => (
          <div
            key={l.value}
            style={{
              flex: '1 1 0',
              borderRadius: 2,
              background: l.value <= value ? l.fill : C.border,
              transition: 'background 120ms ease',
            }}
          />
        ))}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: '50%',
            left: `${value * 10}%`,
            width: thumb,
            height: thumb,
            transform: 'translate(-50%, -50%)',
            borderRadius: '50%',
            background: C.surface,
            border: `2px solid ${C.primary}`,
            boxShadow: '0 1px 2px rgba(17,24,39,0.12)',
            transition: 'left 90ms ease',
          }}
        />
      </div>
    </div>
  );
}

function MiniBar({ value }) {
  return (
    <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
      <div
        style={{
          flex: 1,
          minWidth: 48,
          height: 6,
          borderRadius: 3,
          background: C.borderSubtle,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${value * 10}%`,
            height: '100%',
            borderRadius: 3,
            background: C.primary,
          }}
        />
      </div>
      <span
        style={{
          minWidth: 18,
          textAlign: 'right',
          fontSize: 12,
          fontWeight: 600,
          color: value > 0 ? C.text : C.textTertiary,
        }}
      >
        {value}
      </span>
    </div>
  );
}

function TextButton({ children, onClick, color = C.primary }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus:outline-none focus-visible:ring-2"
      style={{
        fontSize: 13,
        fontWeight: 500,
        color,
        background: 'none',
        border: 'none',
        padding: '4px 6px',
        borderRadius: 6,
        cursor: 'pointer',
        fontFamily: FONT,
      }}
    >
      {children}
    </button>
  );
}

function NeutralChip({ children, icon: Icon }) {
  return (
    <span
      className="inline-flex items-center gap-2"
      style={{
        padding: '5px 12px',
        borderRadius: 20,
        fontSize: 13,
        fontWeight: 500,
        background: C.surfaceSubtle,
        border: `1px solid ${C.border}`,
        color: C.text,
      }}
    >
      {Icon && <Icon size={14} color={C.textMuted} aria-hidden="true" />}
      {children}
    </span>
  );
}

// ── 1. Profile: distinctions ───────────────────────────────────────

const CREDENTIALS = [
  {
    key: 'mvp',
    label: 'Salesforce MVP',
    short: 'Salesforce MVP',
    description: 'Recognized by Salesforce for outstanding community contributions',
  },
  {
    key: 'cta',
    label: 'Salesforce CTA (Certified Technical Architect)',
    short: 'Salesforce CTA',
    description: 'The highest Salesforce certification',
  },
];

function StepProfile({ distinctions, setDistinctions, mobile }) {
  return (
    <div>
      <StepHeading
        icon={Briefcase}
        title="Your Profile"
        subtitle="Tell us about your Salesforce journey. This takes about 10 minutes."
        mobile={mobile}
      />
      <Card style={{ padding: mobile ? 18 : 24 }}>
        <SectionLabel icon={Award}>Salesforce Distinctions</SectionLabel>
        <p style={{ margin: '6px 0 16px', fontSize: 13, color: C.textMuted }}>
          Check any that apply. These are prestigious — they'll be highlighted on your profile.
        </p>
        <div className="flex flex-col" style={{ gap: 14 }}>
          {CREDENTIALS.map((c) => (
            <label key={c.key} className="flex items-start gap-3" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={distinctions[c.key]}
                onChange={(e) => setDistinctions({ ...distinctions, [c.key]: e.target.checked })}
                style={{ width: 16, height: 16, marginTop: 2, accentColor: C.primary }}
              />
              <span>
                <span style={{ display: 'block', fontSize: 14, fontWeight: 500, color: C.text }}>
                  {c.label}
                </span>
                <span style={{ display: 'block', fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                  {c.description}
                </span>
              </span>
            </label>
          ))}
        </div>
      </Card>
      <Note>
        "Certified Salesforce Trainer" is removed from this list. The other Profile sections are
        unchanged. Keep the
        <code> isCertifiedTrainer</code> column, and stop showing the badge for experts who already
        have it (search cards, profile).
      </Note>
    </div>
  );
}

// ── 3. Rate your expertise: scale + definitions ────────────────────

function LevelBadge({ level }) {
  const dark = level.value >= 7;
  return (
    <span
      style={{
        width: 24,
        height: 24,
        borderRadius: 6,
        background: level.fill,
        color: dark ? '#FFFFFF' : '#1E3A8A',
        border: level.value === 0 ? `1px solid ${C.border}` : 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
        flexShrink: 0,
      }}
    >
      {level.value}
    </span>
  );
}

function ScaleGuide({ mobile }) {
  return (
    <ol style={{ margin: 0, padding: 0, listStyle: 'none' }}>
      {SCALE.map((l) => (
        <li
          key={l.value}
          style={{
            padding: '8px 0',
            borderTop: l.value === 0 ? 'none' : `1px solid ${C.borderSubtle}`,
          }}
        >
          {mobile ? (
            <div>
              <div className="flex items-center gap-2">
                <LevelBadge level={l} />
                <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{l.title}</span>
              </div>
              <p
                style={{
                  margin: '4px 0 0 32px',
                  fontSize: 12.5,
                  lineHeight: 1.45,
                  color: C.textSecondary,
                }}
              >
                {l.def}
              </p>
            </div>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '24px 140px minmax(0,1fr)',
                columnGap: 12,
                alignItems: 'center',
              }}
            >
              <LevelBadge level={l} />
              <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{l.title}</span>
              <span style={{ fontSize: 12.5, lineHeight: 1.45, color: C.textSecondary }}>
                {l.def}
              </span>
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

function DimensionRow({ dim, value, onChange, productName, mobile }) {
  const Icon = dim.icon;
  const level = levelFor(value);
  const nameEl = (
    <div className="flex items-center gap-2">
      <Icon size={16} color={C.textMuted} aria-hidden="true" />
      <span style={{ fontSize: 14, fontWeight: 500, color: C.text }}>{dim.name}</span>
    </div>
  );
  const slider = (
    <div style={{ flex: 1, minWidth: 0 }}>
      <SegmentedSlider
        value={value}
        onChange={onChange}
        mobile={mobile}
        label={`${dim.name} proficiency for ${productName}`}
        valueText={`${value}, ${level.title}: ${level.def}`}
      />
    </div>
  );
  const valueEl = (
    <span
      style={{ fontSize: 14, fontWeight: 600, color: C.text, fontVariantNumeric: 'tabular-nums' }}
    >
      {value}
    </span>
  );
  const labelEl = (
    <span style={{ fontSize: 12, fontWeight: 500, color: C.textSecondary }}>{level.title}</span>
  );
  const definition = (
    <p
      style={{
        margin: '6px 0 0',
        fontSize: 12.5,
        lineHeight: 1.45,
        color: value === 0 ? C.textTertiary : C.textSecondary,
      }}
    >
      {level.def}
    </p>
  );

  if (mobile) {
    return (
      <div style={{ padding: '12px 0', borderBottom: `1px solid ${C.borderSubtle}` }}>
        {nameEl}
        <div style={{ marginTop: 10 }}>{slider}</div>
        <div className="flex items-baseline justify-end gap-2" style={{ marginTop: 6 }}>
          {valueEl}
          {labelEl}
        </div>
        {definition}
      </div>
    );
  }
  return (
    <div style={{ padding: '12px 0', borderBottom: `1px solid ${C.borderSubtle}` }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '130px minmax(0,1fr) 24px 128px',
          alignItems: 'center',
          columnGap: 16,
        }}
      >
        {nameEl}
        {slider}
        <span style={{ textAlign: 'right' }}>{valueEl}</span>
        <span style={{ textAlign: 'right' }}>{labelEl}</span>
      </div>
      {/* Indented to the slider column so the definition reads as belonging to it. */}
      <div style={{ marginLeft: 156 }}>{definition}</div>
    </div>
  );
}

function AssessmentCard({ product, ratings, setRating, expanded, onToggle, onDone, mobile }) {
  const complete = DIMENSIONS.some((d) => (ratings?.[d.slug] ?? 0) > 0);
  const [blocked, setBlocked] = useState(false);
  return (
    <div
      style={{
        borderRadius: 12,
        border: `1px solid ${expanded ? C.primaryBorder : C.border}`,
        background: C.surface,
      }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-center justify-between focus:outline-none focus-visible:ring-2"
        style={{
          padding: 16,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          borderRadius: 12,
          fontFamily: FONT,
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{product}</span>
        <span
          className="inline-flex items-center gap-1"
          style={{ fontSize: 12, fontWeight: 500, color: complete ? C.textSecondary : C.textMuted }}
        >
          {complete && <Check size={14} color={C.primary} aria-hidden="true" />}
          {complete ? 'Rated' : 'To rate'}
        </span>
      </button>
      {expanded && (
        <div style={{ padding: '0 16px 16px' }}>
          {DIMENSIONS.map((d) => (
            <DimensionRow
              key={d.slug}
              dim={d}
              value={ratings?.[d.slug] ?? 0}
              productName={product}
              mobile={mobile}
              onChange={(v) => {
                setRating(product, d.slug, v);
                setBlocked(false);
              }}
            />
          ))}
          <div className="flex items-center gap-3" style={{ paddingTop: 12 }}>
            <button
              type="button"
              onClick={() => (complete ? onDone() : setBlocked(true))}
              className="flex items-center gap-1 focus:outline-none focus-visible:ring-2"
              style={{
                padding: '6px 12px',
                borderRadius: 8,
                border: `1px solid ${C.border}`,
                background: C.surface,
                fontSize: 13,
                fontWeight: 500,
                color: C.text,
                cursor: 'pointer',
                fontFamily: FONT,
              }}
            >
              <Check size={15} aria-hidden="true" /> Done
            </button>
            <p role="status" style={{ margin: 0, fontSize: 12, color: C.error }}>
              {blocked ? 'Rate at least one dimension first' : ''}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function StepAssessment({ products, ratings, setRating, mobile }) {
  const [guideOpen, setGuideOpen] = useState(true);
  const isDone = (p) => DIMENSIONS.some((d) => (ratings[p]?.[d.slug] ?? 0) > 0);
  const [expanded, setExpanded] = useState(() => products.find((p) => !isDone(p)) ?? null);
  const completed = products.filter(isDone).length;

  const advance = (current) => {
    const i = products.indexOf(current);
    const next = [...products.slice(i + 1), ...products.slice(0, i)].find((p) => !isDone(p));
    setExpanded(next ?? null);
  };

  return (
    <div>
      <StepHeading
        icon={Wrench}
        title="Rate your expertise"
        mobile={mobile}
        subtitle="For each product, rate your ability across 4 support dimensions. Be honest — clients rely on these ratings to find the right match."
      />

      <div
        style={{
          padding: mobile ? 16 : 20,
          borderRadius: 12,
          background: C.surface,
          border: `1px solid ${C.border}`,
        }}
      >
        <div className="flex items-center justify-between">
          <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>How to rate</span>
          <TextButton color={C.textSecondary} onClick={() => setGuideOpen(!guideOpen)}>
            {guideOpen ? 'Hide' : 'Show guide'}
          </TextButton>
        </div>
        {guideOpen && (
          <div>
            <p
              style={{
                margin: '14px 0 10px',
                fontSize: 13,
                fontWeight: 600,
                color: C.textSecondary,
              }}
            >
              The 4 dimensions
            </p>
            <div
              style={{ display: 'grid', gridTemplateColumns: mobile ? '1fr' : '1fr 1fr', gap: 14 }}
            >
              {DIMENSIONS.map((d) => (
                <div key={d.slug} className="flex items-start gap-2">
                  <d.icon
                    size={16}
                    color={C.textMuted}
                    style={{ marginTop: 2, flexShrink: 0 }}
                    aria-hidden="true"
                  />
                  <div>
                    <span style={{ fontSize: 14, fontWeight: 500, color: C.text }}>{d.name}</span>
                    <p style={{ margin: '2px 0 0', fontSize: 12, color: C.textMuted }}>{d.desc}</p>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ height: 1, background: C.borderSubtle, margin: '18px 0 14px' }} />
            <p style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 600, color: C.textSecondary }}>
              The scale
            </p>
            <ScaleGuide mobile={mobile} />
          </div>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: mobile ? 'column' : 'row',
          justifyContent: 'space-between',
          alignItems: mobile ? 'flex-start' : 'baseline',
          gap: 4,
          marginTop: 18,
        }}
      >
        <p style={{ margin: 0, fontSize: 13, fontWeight: 500, color: C.textSecondary }}>
          {completed} of {products.length} products rated
        </p>
        <p style={{ margin: 0, fontSize: 13, color: C.textMuted }}>
          Between two levels? Choose the lower one.
        </p>
      </div>

      <div className="flex flex-col" style={{ gap: 10, marginTop: 10 }}>
        {products.map((p) => (
          <AssessmentCard
            key={p}
            product={p}
            ratings={ratings[p]}
            setRating={setRating}
            mobile={mobile}
            expanded={expanded === p}
            onToggle={() => setExpanded(expanded === p ? null : p)}
            onDone={() => advance(p)}
          />
        ))}
      </div>

      <Note>
        The slider is the indicator: pressing a segment sets its number (round up, not to the
        nearest step), and 0 is the left end. shadcn/Radix Slider rounds to the nearest step, so
        build this as one small shared component; the staff editor (BAL-593) uses it too. No bands:
        every number has its own title and description, so 7 and 8 differ by something checkable
        (one team versus several clients; teammates versus people outside your team). The guide
        lists all eleven; under each slider the current level's description updates as it moves and
        is also in the slider's <code>aria-valuetext</code>. Show the same eleven where staff edit
        ratings (BAL-593). Keep the scale in one shared constant so the wizard, the staff editor,
        the public profile and the help guide read the same words.
      </Note>
    </div>
  );
}

// ── 4. Review and submit ───────────────────────────────────────────

function SummarySection({ icon, label, onEdit, children, digest }) {
  return (
    <section>
      <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
        <div className="flex items-baseline gap-2">
          <SectionLabel icon={icon}>{label}</SectionLabel>
          {digest && <span style={{ fontSize: 12.5, color: C.textTertiary }}>{digest}</span>}
        </div>
        <TextButton onClick={onEdit}>Edit</TextButton>
      </div>
      {children}
    </section>
  );
}

function DataRow({ label, value }) {
  return (
    <div className="flex items-center justify-between" style={{ padding: '9px 0' }}>
      <span style={{ fontSize: 13, color: C.textSecondary }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 500, color: C.text }}>{value}</span>
    </div>
  );
}

const Divider = () => <div style={{ height: 1, background: C.borderSubtle, margin: '14px 0' }} />;

function StepReview({
  products,
  ratings,
  distinctions,
  onEdit,
  termsAccepted,
  setTermsAccepted,
  termsError,
  setTermsError,
  termsRef,
  mobile,
}) {
  const [scrolledToEnd, setScrolledToEnd] = useState(false);
  const unrated = products.filter((p) => !DIMENSIONS.some((d) => (ratings[p]?.[d.slug] ?? 0) > 0));
  const distinctionList = CREDENTIALS.filter((c) => distinctions[c.key]).map((c) => c.short);
  const twoCol = mobile ? '1fr' : '1fr 1fr';

  return (
    <div>
      <StepHeading
        icon={ClipboardCheck}
        title="Review and submit"
        mobile={mobile}
        subtitle="Check your application, then accept the expert terms to submit it."
      />

      <div className="flex flex-col" style={{ gap: 28 }}>
        <SummarySection icon={Briefcase} label="Experience" onEdit={() => onEdit('profile')}>
          <Card style={{ padding: mobile ? '8px 16px' : '10px 22px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: twoCol, columnGap: 32 }}>
              <DataRow label="Year started" value={PROFILE.yearStarted} />
              <DataRow label="Projects involved in" value={PROFILE.projects} />
              <DataRow label="Projects as Lead" value={PROFILE.projectsAsLead} />
              <DataRow
                label="LinkedIn"
                value={
                  <span className="inline-flex items-center gap-1" style={{ color: C.primary }}>
                    {PROFILE.linkedin}
                    <ExternalLink size={12} />
                  </span>
                }
              />
            </div>
          </Card>
        </SummarySection>

        <SummarySection
          icon={Globe}
          label="Languages, industries and distinctions"
          onEdit={() => onEdit('profile')}
        >
          <Card style={{ padding: mobile ? 16 : 20 }}>
            <div className="flex flex-wrap" style={{ gap: 8 }}>
              {PROFILE.languages.map((l) => (
                <NeutralChip key={l.name}>
                  <span aria-hidden="true">{l.flag}</span>
                  {l.name}
                  <span style={{ fontSize: 12, color: C.textMuted }}>{l.level}</span>
                </NeutralChip>
              ))}
            </div>
            <Divider />
            <div className="flex flex-wrap" style={{ gap: 8 }}>
              {PROFILE.industries.map((i) => (
                <NeutralChip key={i}>{i}</NeutralChip>
              ))}
            </div>
            <Divider />
            {distinctionList.length > 0 ? (
              <div className="flex flex-wrap" style={{ gap: 8 }}>
                {distinctionList.map((d) => (
                  <NeutralChip key={d} icon={Award}>
                    {d}
                  </NeutralChip>
                ))}
              </div>
            ) : (
              <p style={{ margin: 0, fontSize: 13, color: C.textTertiary }}>
                No distinctions selected
              </p>
            )}
          </Card>
        </SummarySection>

        <SummarySection
          icon={Sparkles}
          label="Products and ratings"
          digest={`${products.length} products`}
          onEdit={() => onEdit('assessment')}
        >
          {unrated.length > 0 && (
            <div
              className="flex items-start gap-2"
              role="status"
              style={{
                marginBottom: 12,
                padding: '10px 14px',
                borderRadius: 10,
                background: C.attentionLight,
                border: `1px solid ${C.attentionBorder}`,
              }}
            >
              <AlertTriangle
                size={16}
                color={C.attention}
                style={{ marginTop: 1, flexShrink: 0 }}
                aria-hidden="true"
              />
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: '#78350F' }}>
                {unrated.length === 1
                  ? `${unrated[0]} isn't rated yet.`
                  : `${unrated.length} products aren't rated yet.`}{' '}
                Rate at least one dimension for each product before you submit.{' '}
                <button
                  type="button"
                  onClick={() => onEdit('assessment')}
                  style={{
                    border: 'none',
                    background: 'none',
                    padding: 0,
                    fontSize: 13,
                    fontWeight: 600,
                    color: '#78350F',
                    textDecoration: 'underline',
                    cursor: 'pointer',
                    fontFamily: FONT,
                  }}
                >
                  Rate now
                </button>
              </p>
            </div>
          )}
          <div className="flex flex-col" style={{ gap: 10 }}>
            {products.map((p) => {
              const isUnrated = unrated.includes(p);
              return (
                <Card key={p} style={{ padding: mobile ? '14px 16px' : '14px 20px' }}>
                  <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{p}</span>
                    {isUnrated && (
                      <span style={{ fontSize: 12, fontWeight: 500, color: C.attention }}>
                        Not rated
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: twoCol,
                      columnGap: 24,
                      rowGap: 8,
                    }}
                  >
                    {DIMENSIONS.map((d) => (
                      <div key={d.slug} className="flex items-center gap-2">
                        <d.icon
                          size={14}
                          color={C.textMuted}
                          style={{ flexShrink: 0 }}
                          aria-hidden="true"
                        />
                        <span
                          style={{
                            width: 88,
                            flexShrink: 0,
                            fontSize: 12.5,
                            color: C.textSecondary,
                          }}
                        >
                          {d.name}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <MiniBar value={ratings[p]?.[d.slug] ?? 0} />
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              );
            })}
          </div>
        </SummarySection>

        <SummarySection
          icon={Award}
          label="Certifications"
          digest={`${PROFILE.certifications.length} added`}
          onEdit={() => onEdit('certifications')}
        >
          <Card style={{ padding: mobile ? 16 : 20 }}>
            <div
              className="flex flex-wrap items-center gap-2"
              style={{ fontSize: 13, color: C.textSecondary, marginBottom: 12 }}
            >
              <span>Trailhead:</span>
              <span
                className="inline-flex items-center gap-1"
                style={{ fontWeight: 500, color: C.primary }}
              >
                {PROFILE.trailhead}
                <ExternalLink size={12} />
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: twoCol, gap: 8 }}>
              {PROFILE.certifications.map((c) => (
                <div
                  key={c.name}
                  className="flex items-center gap-2"
                  style={{ padding: '8px 10px', borderRadius: 10, background: C.surfaceSubtle }}
                >
                  <span style={{ fontSize: 13, fontWeight: 500, color: C.text }}>{c.name}</span>
                  <span style={{ fontSize: 12, color: C.textTertiary, marginLeft: 'auto' }}>
                    {c.category}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </SummarySection>

        <SummarySection
          icon={Briefcase}
          label="Work history"
          digest={`${PROFILE.workHistory.length} positions`}
          onEdit={() => onEdit('work history')}
        >
          <div className="flex flex-col" style={{ gap: 10 }}>
            {PROFILE.workHistory.map((w) => (
              <Card key={w.role} style={{ padding: mobile ? '14px 16px' : '14px 20px' }}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: C.text }}>
                      {w.role}
                    </p>
                    <p style={{ margin: '2px 0 0', fontSize: 13, color: C.textSecondary }}>
                      {w.company}
                    </p>
                  </div>
                  {w.current && (
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 500,
                        padding: '2px 10px',
                        borderRadius: 12,
                        background: C.surfaceSubtle,
                        color: C.textSecondary,
                        border: `1px solid ${C.border}`,
                      }}
                    >
                      Current
                    </span>
                  )}
                </div>
                <div
                  className="flex items-center gap-1"
                  style={{ marginTop: 8, fontSize: 12, color: C.textTertiary }}
                >
                  <Clock size={12} aria-hidden="true" />
                  {w.dates}
                </div>
              </Card>
            ))}
          </div>
        </SummarySection>

        {/* Terms follow the summary: review first, then agree. */}
        <section ref={termsRef}>
          <div style={{ marginBottom: 10 }}>
            <SectionLabel icon={Shield}>Expert terms</SectionLabel>
          </div>
          <div
            style={{
              position: 'relative',
              borderRadius: 12,
              border: `1px solid ${C.border}`,
              background: C.surface,
              overflow: 'hidden',
            }}
          >
            <div
              tabIndex={0}
              role="region"
              aria-label="Balo Expert Terms & Conditions"
              className="focus:outline-none focus-visible:ring-2"
              onScroll={(e) => {
                const el = e.currentTarget;
                if (el.scrollHeight - el.scrollTop - el.clientHeight < 20) setScrolledToEnd(true);
              }}
              style={{
                maxHeight: mobile ? 220 : 240,
                overflowY: 'auto',
                padding: 20,
                fontSize: 13,
                lineHeight: 1.6,
                color: C.textSecondary,
              }}
            >
              <p style={{ margin: '0 0 8px', fontWeight: 600, color: C.text }}>
                Placeholder. The live document is ExpertTermsDocument (legal copy in BAL-190).
              </p>
              {[
                'Working on Balo',
                'Engagements and conduct',
                'Fees and payouts',
                'Confidentiality',
                'Ending your participation',
              ].map((h) => (
                <div key={h} style={{ marginBottom: 12 }}>
                  <p style={{ margin: '0 0 4px', fontWeight: 600, color: C.text }}>{h}</p>
                  <p style={{ margin: 0 }}>
                    Terms text for this section appears here. It is unchanged by this ticket and
                    only stands in so the layout, scroll behaviour and fade can be judged at real
                    length.
                  </p>
                </div>
              ))}
            </div>
            {!scrolledToEnd && (
              <div
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 48,
                  pointerEvents: 'none',
                  background: 'linear-gradient(to top, #FFFFFF, rgba(255,255,255,0))',
                }}
              />
            )}
          </div>
          <label className="flex items-start gap-3" style={{ marginTop: 16, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={termsAccepted}
              onChange={(e) => {
                setTermsAccepted(e.target.checked);
                if (e.target.checked) setTermsError(false);
              }}
              aria-invalid={termsError}
              aria-describedby="terms-help"
              style={{ width: 16, height: 16, marginTop: 2, accentColor: C.primary }}
            />
            <span style={{ fontSize: 14, fontWeight: 500, color: C.text, lineHeight: 1.4 }}>
              I have read and agree to the Balo Expert Terms & Conditions
            </span>
          </label>
          <p
            id="terms-help"
            style={{
              margin: '6px 0 0 28px',
              fontSize: 12,
              color: termsError ? C.error : C.textMuted,
            }}
          >
            {termsError
              ? 'Accept the expert terms to submit your application.'
              : 'By submitting, you agree to these terms in full.'}
          </p>
        </section>

        <p style={{ margin: 0, textAlign: 'center', fontSize: 12.5, color: C.textMuted }}>
          You can continue using Balo as a client while we review your application. We'll email you
          within 2–3 business days.
        </p>
      </div>

      <Note>
        The full summary replaces the count-only "Review your application" collapsible and moves
        above the terms. Build it from the wizard draft through an adapter over{' '}
        <code>application-review.tsx</code>'s sections, not a second summary component, and give
        that post-submit page the same neutral treatment. Each Edit derives its target by step key.
        The unrated-products warning surfaces a gap before Submit; confirm it uses the same rule as
        the assessment step's validation.
      </Note>
    </div>
  );
}

// ── Frame ──────────────────────────────────────────────────────────

export default function ExpertApplicationRefinements() {
  const [tab, setTab] = useState('assessment');
  const [device, setDevice] = useState('desktop');
  const mobile = device === 'mobile';
  const [distinctions, setDistinctions] = useState({ mvp: false, cta: true });
  const [selected] = useState(INITIAL_SELECTED);
  const [ratings, setRatings] = useState(INITIAL_RATINGS);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [termsError, setTermsError] = useState(false);
  const [toast, setToast] = useState(null);
  const scrollRef = useRef(null);
  const termsRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [tab, device]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  const tabIndex = TABS.findIndex((t) => t.key === tab);
  const current = TABS[tabIndex];
  const setRating = (product, dim, value) =>
    setRatings((prev) => ({ ...prev, [product]: { ...(prev[product] ?? {}), [dim]: value } }));
  const onEdit = (target) => {
    if (TABS.some((t) => t.key === target)) setTab(target);
    else setToast(`In the app, Edit opens the ${target} step.`);
  };
  const submit = () => {
    if (!termsAccepted) {
      setTermsError(true);
      termsRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      termsRef.current?.querySelector('input[type="checkbox"]')?.focus({ preventScroll: true });
      return;
    }
    setToast('Submitted. In the app this moves to /expert/apply/success.');
  };

  const primaryButton = {
    height: 40,
    padding: '0 18px',
    borderRadius: 8,
    border: 'none',
    background: C.primary,
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: FONT,
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        background: C.page,
        fontFamily: FONT,
        color: C.text,
        padding: 20,
      }}
    >
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap');
        code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }`}</style>

      {/* Reference chrome: not product UI */}
      <div
        className="flex flex-wrap items-center justify-between gap-3"
        style={{ maxWidth: 1080, margin: '0 auto 16px' }}
      >
        <div>
          <p style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Expert application refinements</p>
          <p style={{ margin: '2px 0 0', fontSize: 12.5, color: C.textMuted }}>
            Design reference for BAL-643. Three surfaces, illustrative data.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="tablist"
            aria-label="Surface"
            className="flex flex-wrap"
            style={{ gap: 2, padding: 3, borderRadius: 10, background: '#E2E6EC' }}
          >
            {TABS.map((t) => (
              <button
                key={t.key}
                role="tab"
                aria-selected={tab === t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className="focus:outline-none focus-visible:ring-2"
                style={{
                  padding: '6px 12px',
                  borderRadius: 8,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 500,
                  fontFamily: FONT,
                  background: tab === t.key ? C.surface : 'transparent',
                  color: tab === t.key ? C.text : C.textSecondary,
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div
            role="group"
            aria-label="Device width"
            className="flex"
            style={{ gap: 2, padding: 3, borderRadius: 10, background: '#E2E6EC' }}
          >
            {[
              { k: 'desktop', Icon: Monitor, l: 'Desktop' },
              { k: 'mobile', Icon: Smartphone, l: 'Mobile' },
            ].map(({ k, Icon, l }) => (
              <button
                key={k}
                type="button"
                aria-pressed={device === k}
                aria-label={l}
                onClick={() => setDevice(k)}
                className="focus:outline-none focus-visible:ring-2"
                style={{
                  padding: '6px 10px',
                  borderRadius: 8,
                  border: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  background: device === k ? C.surface : 'transparent',
                }}
              >
                <Icon size={16} color={device === k ? C.text : C.textMuted} />
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Device frame */}
      <div
        style={{
          width: mobile ? 390 : '100%',
          maxWidth: mobile ? 390 : 1080,
          height: 780,
          margin: '0 auto',
          borderRadius: mobile ? 28 : 16,
          border: `1px solid ${C.border}`,
          background: C.bg,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
        }}
      >
        {/* Wizard header */}
        <div
          style={{
            padding: mobile ? '14px 16px 12px' : '16px 32px 14px',
            background: C.surface,
            borderBottom: `1px solid ${C.border}`,
          }}
        >
          <div className="flex items-center justify-between">
            <span
              style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.02em', color: C.text }}
            >
              balo
            </span>
            <span style={{ fontSize: 12.5, color: C.textMuted }}>
              Step {current.step} of {TOTAL_STEPS}
            </span>
          </div>
          <div className="flex" style={{ gap: 4, marginTop: 12 }} aria-hidden="true">
            {Array.from({ length: TOTAL_STEPS }, (_, i) => (
              <div
                key={i}
                style={{
                  flex: 1,
                  height: 4,
                  borderRadius: 2,
                  background: i < current.step ? C.primary : C.border,
                }}
              />
            ))}
          </div>
        </div>

        {/* Step body */}
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: mobile ? '20px 16px 28px' : '32px 32px 40px',
          }}
        >
          <div style={{ maxWidth: tab === 'assessment' ? 760 : 720, margin: '0 auto' }}>
            {tab === 'profile' && (
              <StepProfile
                distinctions={distinctions}
                setDistinctions={setDistinctions}
                mobile={mobile}
              />
            )}
            {tab === 'assessment' && (
              <StepAssessment
                products={selected}
                ratings={ratings}
                setRating={setRating}
                mobile={mobile}
              />
            )}
            {tab === 'review' && (
              <StepReview
                products={selected}
                ratings={ratings}
                distinctions={distinctions}
                onEdit={onEdit}
                mobile={mobile}
                termsAccepted={termsAccepted}
                setTermsAccepted={setTermsAccepted}
                termsError={termsError}
                setTermsError={setTermsError}
                termsRef={termsRef}
              />
            )}
          </div>
        </div>

        {/* Action bar (unchanged, BAL-327) */}
        <div
          className="flex items-center justify-between"
          style={{
            padding: mobile ? '12px 16px' : '14px 32px',
            background: C.surface,
            borderTop: `1px solid ${C.border}`,
          }}
        >
          <button
            type="button"
            onClick={() => tabIndex > 0 && setTab(TABS[tabIndex - 1].key)}
            disabled={tabIndex === 0}
            className="flex items-center gap-2 focus:outline-none focus-visible:ring-2"
            style={{
              height: 40,
              padding: '0 14px',
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              background: C.surface,
              fontSize: 14,
              fontWeight: 500,
              color: tabIndex === 0 ? C.textTertiary : C.text,
              cursor: tabIndex === 0 ? 'default' : 'pointer',
              fontFamily: FONT,
            }}
          >
            <ArrowLeft size={16} aria-hidden="true" /> Back
          </button>
          {tab === 'review' ? (
            <button
              type="button"
              onClick={submit}
              className="focus:outline-none focus-visible:ring-2"
              style={primaryButton}
            >
              Submit application
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setTab(TABS[tabIndex + 1].key)}
              className="focus:outline-none focus-visible:ring-2"
              style={primaryButton}
            >
              Continue
            </button>
          )}
        </div>

        {toast && (
          <div
            role="status"
            style={{
              position: 'absolute',
              left: '50%',
              bottom: 76,
              transform: 'translateX(-50%)',
              padding: '10px 16px',
              borderRadius: 10,
              background: C.text,
              color: '#fff',
              fontSize: 13,
              maxWidth: '88%',
              textAlign: 'center',
            }}
          >
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}
