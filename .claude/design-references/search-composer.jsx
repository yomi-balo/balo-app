import { useState, useMemo, useEffect, useRef } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';

/**
 * Search Composer — CANONICAL design reference (source of truth for BAL-249).
 *
 * Consolidates the prototypes (unified bar + rail + mobile) into ONE file.
 * Supersedes: search-composer.jsx, search-composer-unified-bar.jsx,
 * search-composer-mobile.jsx, product-selector-comparison.jsx.
 *
 * One `SearchFilters` state (in prod = URL query params; here = useState),
 * rendered across surfaces. Bound to the SAME contract BAL-247 hydrates from /
 * BAL-246 consumes: { q, products[], supportTypes[], timeframe, rateMin,
 * rateMax, languages[] }. This composer replaces BAL-247's placeholder rail.
 *
 * SURFACES (use the switcher):
 *   • Desktop — Hero bar (unified, segmented pill) + Rail (collapsible products).
 *   • Desktop — Compact bar (persists on results, same segmented structure).
 *   • Mobile  — Collapsed summary bar + bottom sheet. ONE-TRIGGER model
 *               (tap bar → sheet with FTS at top + all facets + "Show N" footer).
 *
 * PRODUCT SELECTOR: search-first, token tray, dense-group capping, animated,
 * and `collapsible`. ONE component mounted three ways:
 *   - bar popover  → expanded (popover exists only to pick products)
 *   - rail inline  → collapsible, collapsed by default
 *   - mobile sheet → collapsible, collapsed by default
 * Collapsed hides the browse list but keeps selected tokens visible.
 *
 * FIRING MODEL (prod): FTS text = explicit submit always; hero bar = explicit;
 * results-page facets (rail + compact-bar popover) = live re-query, debounced
 * ~500ms. (Not wired in this prototype — it's a query-model note for CC.)
 *
 * MOBILE RESPONSIVENESS here uses a JS viewport check for PREVIEW ONLY. In prod
 * use Tailwind md: classes + SSR; do not copy the resize listener.
 */

const MOBILE_MAX = 768; // = Tailwind `md`

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
  accentBorder: '#DDD6FE',
  gradient: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
  gradientSubtle: 'linear-gradient(135deg, #EFF6FF 0%, #F5F3FF 100%)',
};
const Svg = ({ d, size = 16, color = 'currentColor', sw = 2, style }) => (
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
  >
    {d.split('|').map((p, i) => (
      <path key={i} d={p} />
    ))}
  </svg>
);
const ICON = {
  search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.35-4.35',
  check: 'M20 6L9 17l-5-5',
  x: 'M18 6L6 18M6 6l12 12',
  plus: 'M12 5v14M5 12h14',
  chevDown: 'M6 9l6 6 6-6',
  box: 'M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z|M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12',
  wrench:
    'M14.7 6.3a4 4 0 00-5.6 5.6l-6.4 6.4a2 2 0 102.8 2.8l6.4-6.4a4 4 0 005.6-5.6l-2.5 2.5-2.1-2.1 2.5-2.5z',
  clock: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2',
  dollar: 'M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6',
  globe:
    'M12 22a10 10 0 100-20 10 10 0 000 20zM2 12h20M12 2a15 15 0 014 10 15 15 0 01-4 10 15 15 0 01-4-10 15 15 0 014-10z',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
};

const TAXONOMY = [
  { group: 'AI', items: ['Agentforce'] },
  { group: 'Data Cloud', items: ['Data Cloud'] },
  { group: 'Sales Cloud', items: ['CPQ', 'Sales Cloud'] },
  {
    group: 'Service Cloud',
    items: ['Digital Engagement', 'Field Service', 'Service Cloud', 'Voice'],
  },
  {
    group: 'Marketing Cloud',
    items: [
      'Account Engagement',
      'Engagement',
      'Intelligence',
      'Loyalty Management',
      'Personalisation',
    ],
  },
  { group: 'Slack', items: ['Slack'] },
  { group: 'Experience Cloud', items: ['Experience Cloud'] },
  { group: 'Commerce Cloud', items: ['B2B Commerce', 'B2C Commerce', 'Order Management'] },
  {
    group: 'Platform',
    items: ['AppExchange', 'Heroku', 'Hyperforce', 'Salesforce Platform', 'Security', 'Shield'],
  },
  { group: 'Tableau', items: ['CRM Analytics', 'Tableau'] },
  { group: 'MuleSoft', items: ['MuleSoft'] },
  {
    group: 'Industries',
    items: [
      'Communications Cloud',
      'Consumer Goods Cloud',
      'Education Cloud',
      'Energy & Utilities Cloud',
      'Financial Services Cloud',
      'Government Cloud',
      'Health Cloud',
      'Manufacturing Cloud',
      'Media Cloud',
      'Nonprofit Cloud',
      'OmniStudio',
    ],
  },
  { group: 'Net Zero Cloud', items: ['Net Zero Cloud'] },
];
const SUPPORT_TYPES = ['Technical fix', 'Architecture', 'Admin / config', 'Strategy'];
const TIMEFRAMES = [
  { key: 'any', label: 'Any time' },
  { key: 'today', label: 'Today' },
  { key: '3days', label: 'Within 3 days' },
  { key: 'week', label: 'This week' },
];
const LANGUAGES = ['English', 'Spanish', 'Hindi', 'French', 'German', 'Portuguese'];
const DENSE_CAP = 4;

// ════════════════════════════════════════════════════════════════
// PRODUCT SELECTOR (locked, animated, collapsible) — mounted 3 ways
// ════════════════════════════════════════════════════════════════
function highlight(text, q) {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i === -1) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark style={{ background: `${c.primary}22`, color: c.primary, borderRadius: 2 }}>
        {text.slice(i, i + q.length)}
      </mark>
      {text.slice(i + q.length)}
    </>
  );
}
function ProductChip({ label, selected, onClick }) {
  const [h, setH] = useState(false);
  const reduce = useReducedMotion();
  return (
    <motion.button
      onClick={onClick}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      whileTap={reduce ? undefined : { scale: 0.94 }}
      transition={{ type: 'spring', stiffness: 600, damping: 30 }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        padding: '8px 14px',
        borderRadius: 10,
        fontSize: 13.5,
        fontWeight: selected ? 600 : 500,
        cursor: 'pointer',
        border: `1px solid ${selected || h ? c.primaryBorder : c.border}`,
        background: selected ? c.primaryLight : h ? c.surfaceSubtle : c.surface,
        color: selected ? c.primary : c.text,
        transition: 'background 0.14s, border-color 0.14s, color 0.14s',
        whiteSpace: 'nowrap',
      }}
    >
      {selected && <Svg d={ICON.check} size={13} color={c.primary} />}
      <span>{label}</span>
    </motion.button>
  );
}
function SelectedToken({ label, onRemove }) {
  const [h, setH] = useState(false);
  const reduce = useReducedMotion();
  return (
    <motion.span
      layout
      initial={reduce ? false : { opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.8 }}
      transition={{ type: 'spring', stiffness: 500, damping: 32 }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px 6px 12px',
        borderRadius: 8,
        fontSize: 13,
        fontWeight: 500,
        color: c.primary,
        background: c.surface,
        border: `1px solid ${c.primaryBorder}`,
      }}
    >
      {label}
      <button
        onClick={onRemove}
        onMouseEnter={() => setH(true)}
        onMouseLeave={() => setH(false)}
        aria-label={`Remove ${label}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          height: 18,
          borderRadius: '50%',
          border: 'none',
          cursor: 'pointer',
          background: h ? c.primary : 'rgba(37,99,235,0.1)',
          transition: 'background 0.14s',
        }}
      >
        <Svg d={ICON.x} size={10} color={h ? '#fff' : c.primary} />
      </button>
    </motion.span>
  );
}
function ProductSelector({
  products,
  toggle,
  clear,
  maxHeight = 320,
  collapsible = false,
  defaultOpen = false,
}) {
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState({});
  const [open, setOpen] = useState(!collapsible || defaultOpen);
  const reduce = useReducedMotion();
  const filtered = useMemo(() => {
    if (!q) return TAXONOMY;
    const ql = q.toLowerCase();
    return TAXONOMY.map((g) => ({
      ...g,
      items: g.items.filter((i) => i.toLowerCase().includes(ql)),
    })).filter((g) => g.items.length > 0 || g.group.toLowerCase().includes(ql));
  }, [q]);
  const arr = [...products];

  const tokensTray = (
    <AnimatePresence initial={false}>
      {arr.length > 0 && (
        <motion.div
          layout
          initial={reduce ? false : { opacity: 0, height: 0, marginBottom: 0 }}
          animate={{ opacity: 1, height: 'auto', marginBottom: 14 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0, marginBottom: 0 }}
          transition={{ duration: 0.22 }}
          style={{ overflow: 'hidden' }}
        >
          <div
            style={{
              padding: '12px 14px',
              borderRadius: 12,
              background: c.surfaceSubtle,
              border: `1px solid ${c.borderSubtle}`,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 10,
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: c.textSecondary,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}
              >
                {arr.length} selected
              </span>
              <button
                onClick={clear}
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: c.textSecondary,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                }}
              >
                Clear all
              </button>
            </div>
            <motion.div layout style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <AnimatePresence initial={false}>
                {arr.map((s) => (
                  <SelectedToken key={s} label={s} onRemove={() => toggle(s)} />
                ))}
              </AnimatePresence>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  const browse = (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          height: 44,
          padding: '0 14px',
          borderRadius: 11,
          background: c.surface,
          border: `1px solid ${c.border}`,
          marginBottom: 12,
        }}
      >
        <Svg d={ICON.search} size={16} color={c.textTertiary} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by product, skill, or name…"
          style={{
            flex: 1,
            minWidth: 0,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            fontSize: 14,
            color: c.text,
            fontFamily: 'inherit',
          }}
        />
        {q && (
          <button
            onClick={() => setQ('')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex' }}
          >
            <Svg d={ICON.x} size={14} color={c.textTertiary} />
          </button>
        )}
      </div>
      <div style={{ maxHeight, overflowY: 'auto', paddingRight: 4 }}>
        {filtered.length === 0 && (
          <p
            style={{ fontSize: 13, color: c.textTertiary, textAlign: 'center', padding: '24px 0' }}
          >
            No products match "{q}"
          </p>
        )}
        {filtered.map((g) => {
          const isDense = g.items.length > DENSE_CAP && !q;
          const showAll = expanded[g.group];
          const visible = isDense && !showAll ? g.items.slice(0, DENSE_CAP) : g.items;
          const hidden = g.items.length - visible.length;
          return (
            <div key={g.group} style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '0 0 10px' }}>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: c.textSecondary,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                  }}
                >
                  {g.group}
                </span>
                {g.items.length > 1 && (
                  <span style={{ fontSize: 11, color: c.textTertiary }}>{g.items.length}</span>
                )}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {visible.map((it, idx) => {
                  const revealed = isDense && showAll && idx >= DENSE_CAP;
                  return (
                    <motion.div
                      key={it}
                      initial={revealed && !reduce ? { opacity: 0, scale: 0.85 } : false}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{
                        duration: 0.18,
                        delay: revealed ? (idx - DENSE_CAP) * 0.03 : 0,
                      }}
                    >
                      <ProductChip
                        label={highlight(it, q)}
                        selected={products.has(it)}
                        onClick={() => toggle(it)}
                      />
                    </motion.div>
                  );
                })}
                {hidden > 0 && (
                  <button
                    onClick={() => setExpanded((p) => ({ ...p, [g.group]: true }))}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '8px 14px',
                      borderRadius: 10,
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: 'pointer',
                      border: `1px dashed ${c.border}`,
                      background: 'transparent',
                      color: c.textSecondary,
                    }}
                  >
                    <Svg d={ICON.plus} size={13} color={c.textSecondary} /> {hidden} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );

  if (!collapsible)
    return (
      <div>
        {tokensTray}
        {browse}
      </div>
    );
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '0 0 12px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <Svg d={ICON.box} size={14} color={c.textSecondary} />
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: c.textSecondary,
            textTransform: 'uppercase',
            letterSpacing: '0.07em',
          }}
        >
          Products
        </span>
        {arr.length > 0 && (
          <span
            style={{
              minWidth: 18,
              height: 18,
              padding: '0 5px',
              borderRadius: 9,
              background: c.primary,
              color: '#fff',
              fontSize: 11,
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {arr.length}
          </span>
        )}
        <Svg
          d={ICON.chevDown}
          size={15}
          color={c.textTertiary}
          sw={2.5}
          style={{
            marginLeft: 'auto',
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.2s',
          }}
        />
      </button>
      {tokensTray}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={reduce ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: 0.24, ease: 'easeOut' }}
            style={{ overflow: 'hidden' }}
          >
            {browse}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function PillRow({ options, selected, onToggle, multi = true }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {options.map((o) => {
        const val = typeof o === 'string' ? o : o.key;
        const label = typeof o === 'string' ? o : o.label;
        const active = multi ? selected.has(val) : selected === val;
        return (
          <button
            key={val}
            onClick={() => onToggle(val)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '9px 14px',
              borderRadius: 999,
              fontSize: 13,
              fontWeight: active ? 600 : 500,
              cursor: 'pointer',
              border: `1px solid ${active ? c.primaryBorder : c.border}`,
              background: active ? c.primaryLight : c.surface,
              color: active ? c.primary : c.text,
              transition: 'all 0.14s',
            }}
          >
            {active && <Svg d={ICON.check} size={12} color={c.primary} />}
            {label}
          </button>
        );
      })}
    </div>
  );
}
function Popover({ children, onClose, width = 420, align = 'left' }) {
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onClose]);
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.98 }}
      transition={{ duration: 0.16, ease: 'easeOut' }}
      style={{
        position: 'absolute',
        top: 'calc(100% + 10px)',
        [align]: 0,
        width,
        background: c.surface,
        borderRadius: 14,
        border: `1px solid ${c.border}`,
        boxShadow: '0 12px 40px rgba(0,0,0,0.14)',
        zIndex: 50,
        padding: 16,
      }}
    >
      {children}
    </motion.div>
  );
}

// ── Unified bar (hero + compact) ─────────────────────────────────
function Segment({ icon, primary, secondary, placeholder, active, onClick }) {
  const [h, setH] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        height: '100%',
        padding: '0 18px',
        border: 'none',
        cursor: 'pointer',
        background: active || h ? 'rgba(37,99,235,0.05)' : 'transparent',
        transition: 'background 0.15s',
        minWidth: 0,
      }}
    >
      {icon && <Svg d={icon} size={16} color={active ? c.primary : c.textSecondary} />}
      <span
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0 }}
      >
        <span style={{ fontSize: 11, fontWeight: 600, color: c.textTertiary, lineHeight: 1.2 }}>
          {primary}
        </span>
        <span
          style={{
            fontSize: 14,
            fontWeight: secondary ? 600 : 400,
            color: secondary ? c.text : c.textTertiary,
            lineHeight: 1.3,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: 150,
          }}
        >
          {secondary || placeholder}
        </span>
      </span>
      <Svg
        d={ICON.chevDown}
        size={13}
        color={c.textTertiary}
        style={{ marginLeft: 'auto', flexShrink: 0 }}
      />
    </button>
  );
}
const Divider = () => (
  <div
    style={{
      width: 1,
      alignSelf: 'stretch',
      margin: '10px 0',
      background: c.borderSubtle,
      flexShrink: 0,
    }}
  />
);

function UnifiedBar({ filters, set, compact }) {
  const [open, setOpen] = useState(null);
  const toggleProduct = (p) =>
    set.products((prev) => {
      const n = new Set(prev);
      n.has(p) ? n.delete(p) : n.add(p);
      return n;
    });
  const toggleSupport = (s) =>
    set.supportTypes((prev) => {
      const n = new Set(prev);
      n.has(s) ? n.delete(s) : n.add(s);
      return n;
    });
  const prodArr = [...filters.products];
  const prodSummary =
    prodArr.length === 0
      ? null
      : prodArr.length === 1
        ? prodArr[0]
        : `${prodArr[0]} +${prodArr.length - 1}`;
  const supArr = [...filters.supportTypes];
  const supSummary =
    supArr.length === 0 ? null : supArr.length === 1 ? supArr[0] : `${supArr.length} selected`;
  const tfSummary =
    filters.timeframe === 'any' ? null : TIMEFRAMES.find((t) => t.key === filters.timeframe)?.label;
  const barH = compact ? 56 : 68;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        height: barH,
        background: c.surface,
        border: `1px solid ${c.border}`,
        borderRadius: 16,
        boxShadow: compact ? '0 1px 3px rgba(0,0,0,0.04)' : '0 4px 20px rgba(15,23,41,0.06)',
        position: 'relative',
      }}
    >
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 11,
          padding: '0 18px',
          minWidth: 0,
        }}
      >
        <Svg d={ICON.search} size={18} color={c.textTertiary} />
        <input
          value={filters.q}
          onChange={(e) => set.q(e.target.value)}
          placeholder="Search by product, skill, or name — e.g. Agentforce, CPQ"
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
      <Divider />
      <div style={{ position: 'relative', height: '100%' }}>
        <Segment
          icon={ICON.box}
          primary="Product"
          secondary={prodSummary}
          placeholder="Any"
          active={open === 'product'}
          onClick={() => setOpen(open === 'product' ? null : 'product')}
        />
        <AnimatePresence>
          {open === 'product' && (
            <Popover onClose={() => setOpen(null)} width={440}>
              <ProductSelector
                products={filters.products}
                toggle={toggleProduct}
                clear={() => set.products(new Set())}
                maxHeight={300}
              />
            </Popover>
          )}
        </AnimatePresence>
      </div>
      <Divider />
      <div style={{ position: 'relative', height: '100%' }}>
        <Segment
          icon={ICON.wrench}
          primary="Support"
          secondary={supSummary}
          placeholder="Any"
          active={open === 'support'}
          onClick={() => setOpen(open === 'support' ? null : 'support')}
        />
        <AnimatePresence>
          {open === 'support' && (
            <Popover onClose={() => setOpen(null)} width={300}>
              <p
                style={{
                  margin: '0 0 12px',
                  fontSize: 12,
                  fontWeight: 700,
                  color: c.textSecondary,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}
              >
                Type of help
              </p>
              <PillRow
                options={SUPPORT_TYPES}
                selected={filters.supportTypes}
                onToggle={toggleSupport}
              />
            </Popover>
          )}
        </AnimatePresence>
      </div>
      <Divider />
      <div style={{ position: 'relative', height: '100%' }}>
        <Segment
          icon={ICON.clock}
          primary="When"
          secondary={tfSummary}
          placeholder="Any time"
          active={open === 'timeframe'}
          onClick={() => setOpen(open === 'timeframe' ? null : 'timeframe')}
        />
        <AnimatePresence>
          {open === 'timeframe' && (
            <Popover onClose={() => setOpen(null)} width={260} align="right">
              <p
                style={{
                  margin: '0 0 12px',
                  fontSize: 12,
                  fontWeight: 700,
                  color: c.textSecondary,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}
              >
                Available within
              </p>
              <PillRow
                options={TIMEFRAMES}
                selected={filters.timeframe}
                onToggle={(k) => {
                  set.timeframe(k);
                  setOpen(null);
                }}
                multi={false}
              />
            </Popover>
          )}
        </AnimatePresence>
      </div>
      <div style={{ padding: '0 10px 0 4px' }}>
        <button
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: compact ? 40 : 48,
            padding: compact ? '0 18px' : '0 22px',
            borderRadius: 12,
            border: 'none',
            background: c.gradient,
            color: '#fff',
            fontSize: 14,
            fontWeight: 650,
            cursor: 'pointer',
            boxShadow: `0 2px 10px ${c.primaryGlow}`,
            whiteSpace: 'nowrap',
          }}
        >
          <Svg d={ICON.search} size={16} color="#fff" />
          {!compact && 'Search'}
        </button>
      </div>
    </div>
  );
}

// ── Rail ─────────────────────────────────────────────────────────
function RailSection({ icon, label, children }) {
  return (
    <div
      style={{ paddingBottom: 18, marginBottom: 18, borderBottom: `1px solid ${c.borderSubtle}` }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12 }}>
        <Svg d={icon} size={14} color={c.textSecondary} />
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: c.textSecondary,
            textTransform: 'uppercase',
            letterSpacing: '0.07em',
          }}
        >
          {label}
        </span>
      </div>
      {children}
    </div>
  );
}
function RateSlider() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 13, color: c.textSecondary }}>A$1</span>
      <div
        style={{ flex: 1, height: 4, borderRadius: 2, background: c.border, position: 'relative' }}
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
  );
}
function FacetControls({ filters, set, inSheet }) {
  const toggleProduct = (p) =>
    set.products((prev) => {
      const n = new Set(prev);
      n.has(p) ? n.delete(p) : n.add(p);
      return n;
    });
  const toggleSupport = (s) =>
    set.supportTypes((prev) => {
      const n = new Set(prev);
      n.has(s) ? n.delete(s) : n.add(s);
      return n;
    });
  const toggleLang = (l) =>
    set.languages((prev) => {
      const n = new Set(prev);
      n.has(l) ? n.delete(l) : n.add(l);
      return n;
    });
  return (
    <>
      <div
        style={{ paddingBottom: 18, marginBottom: 18, borderBottom: `1px solid ${c.borderSubtle}` }}
      >
        <ProductSelector
          products={filters.products}
          toggle={toggleProduct}
          clear={() => set.products(new Set())}
          maxHeight={inSheet ? 999 : 260}
          collapsible
        />
      </div>
      <RailSection icon={ICON.wrench} label="Type of help">
        <PillRow options={SUPPORT_TYPES} selected={filters.supportTypes} onToggle={toggleSupport} />
      </RailSection>
      <RailSection icon={ICON.clock} label="Availability">
        <PillRow
          options={TIMEFRAMES}
          selected={filters.timeframe}
          onToggle={set.timeframe}
          multi={false}
        />
      </RailSection>
      <RailSection icon={ICON.dollar} label="Rate (per minute)">
        <RateSlider />
      </RailSection>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12 }}>
          <Svg d={ICON.globe} size={14} color={c.textSecondary} />
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: c.textSecondary,
              textTransform: 'uppercase',
              letterSpacing: '0.07em',
            }}
          >
            Languages
          </span>
        </div>
        <PillRow options={LANGUAGES} selected={filters.languages} onToggle={toggleLang} />
      </div>
    </>
  );
}
function Rail({ filters, set }) {
  return (
    <div
      style={{
        width: 320,
        background: c.surface,
        borderRadius: 16,
        border: `1px solid ${c.border}`,
        padding: 20,
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
        <Svg d={ICON.sliders} size={16} color={c.text} />
        <span style={{ fontSize: 15, fontWeight: 700, color: c.text }}>Filters</span>
      </div>
      <FacetControls filters={filters} set={set} />
    </div>
  );
}

// ── Mobile: collapsed bar + ONE-TRIGGER sheet ────────────────────
function MobileSheet({ filters, set, onClose }) {
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 100 }}>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        style={{ position: 'absolute', inset: 0, background: 'rgba(15,23,41,0.45)' }}
      />
      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', stiffness: 360, damping: 36 }}
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          maxHeight: '88%',
          background: c.surface,
          borderRadius: '20px 20px 0 0',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 -8px 40px rgba(0,0,0,0.2)',
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
            padding: '10px 18px 12px',
            borderBottom: `1px solid ${c.borderSubtle}`,
          }}
        >
          <span style={{ fontSize: 16, fontWeight: 700, color: c.text }}>Search & filter</span>
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
            <Svg d={ICON.x} size={16} color={c.textSecondary} />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px 8px' }}>
          {/* One-Trigger: FTS lives at the top of the sheet */}
          <div
            style={{
              paddingBottom: 18,
              marginBottom: 18,
              borderBottom: `1px solid ${c.borderSubtle}`,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12 }}>
              <Svg d={ICON.search} size={14} color={c.textSecondary} />
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: c.textSecondary,
                  textTransform: 'uppercase',
                  letterSpacing: '0.07em',
                }}
              >
                Search
              </span>
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                height: 46,
                padding: '0 14px',
                borderRadius: 11,
                background: c.surface,
                border: `1px solid ${c.border}`,
              }}
            >
              <Svg d={ICON.search} size={16} color={c.textTertiary} />
              <input
                value={filters.q}
                onChange={(e) => set.q(e.target.value)}
                placeholder="Search by product, skill, or name — e.g. Agentforce"
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  fontSize: 14,
                  color: c.text,
                  fontFamily: 'inherit',
                }}
              />
            </div>
          </div>
          <FacetControls filters={filters} set={set} inSheet />
        </div>
        <div style={{ padding: '12px 18px 20px', borderTop: `1px solid ${c.borderSubtle}` }}>
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
            Show 6 experts
          </button>
        </div>
      </motion.div>
    </div>
  );
}
function Phone({ children }) {
  return (
    <div
      style={{
        width: 390,
        height: 760,
        margin: '0 auto',
        background: c.bg,
        borderRadius: 36,
        border: '10px solid #0F1729',
        position: 'relative',
        overflow: 'hidden',
        boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 130,
          height: 26,
          background: '#0F1729',
          borderRadius: '0 0 16px 16px',
          zIndex: 200,
        }}
      />
      {children}
    </div>
  );
}
function MobileComposer({ filters, set }) {
  const [sheet, setSheet] = useState(false);
  const summary = useMemo(() => {
    const parts = [];
    if (filters.products.size)
      parts.push(
        [...filters.products][0] +
          (filters.products.size > 1 ? ` +${filters.products.size - 1}` : '')
      );
    if (filters.supportTypes.size) parts.push([...filters.supportTypes][0]);
    if (filters.timeframe !== 'any')
      parts.push(TIMEFRAMES.find((t) => t.key === filters.timeframe)?.label);
    return parts.join(' · ');
  }, [filters.products, filters.supportTypes, filters.timeframe]);
  const activeCount =
    filters.products.size + filters.supportTypes.size + (filters.timeframe !== 'any' ? 1 : 0);
  return (
    <Phone>
      <div style={{ position: 'absolute', inset: 0, paddingTop: 26, overflow: 'hidden' }}>
        <div
          style={{
            background: c.gradientSubtle,
            padding: '22px 16px',
            borderBottom: `1px solid ${c.accentBorder}55`,
          }}
        >
          <h2 style={{ margin: '8px 0 4px', fontSize: 20, fontWeight: 700, color: c.text }}>
            Find a Salesforce expert
          </h2>
          <p style={{ margin: '0 0 16px', fontSize: 13, color: c.textSecondary }}>
            Vetted consultants, on a call when you need them.
          </p>
          {/* One-Trigger: the whole bar opens the sheet */}
          <button
            onClick={() => setSheet(true)}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 11,
              height: 54,
              padding: '0 16px',
              borderRadius: 14,
              background: c.surface,
              border: `1px solid ${c.border}`,
              cursor: 'pointer',
              textAlign: 'left',
              boxShadow: '0 2px 10px rgba(15,23,41,0.06)',
            }}
          >
            <Svg d={ICON.search} size={19} color={c.textTertiary} />
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              {summary ? (
                <>
                  <span style={{ fontSize: 11, color: c.textTertiary, lineHeight: 1.1 }}>
                    {filters.q || 'Search or filter experts'}
                  </span>
                  <span
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: c.text,
                      lineHeight: 1.3,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {summary}
                  </span>
                </>
              ) : (
                <span style={{ fontSize: 15, color: c.textTertiary }}>
                  {filters.q || 'Search or filter experts'}
                </span>
              )}
            </span>
            {activeCount > 0 && (
              <span
                style={{
                  minWidth: 22,
                  height: 22,
                  padding: '0 6px',
                  borderRadius: 11,
                  background: c.primary,
                  color: '#fff',
                  fontSize: 12,
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
        </div>
        <div style={{ padding: 16 }}>
          <p style={{ margin: '0 0 14px', fontSize: 16, fontWeight: 700, color: c.text }}>
            6 <span style={{ fontWeight: 500, color: c.textSecondary }}>of 8 experts</span>
          </p>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                background: c.surface,
                borderRadius: 14,
                border: `1px solid ${c.border}`,
                height: 132,
                marginBottom: 14,
                opacity: 0.5,
              }}
            />
          ))}
        </div>
      </div>
      <AnimatePresence>
        {sheet && <MobileSheet filters={filters} set={set} onClose={() => setSheet(false)} />}
      </AnimatePresence>
    </Phone>
  );
}

// ── Shell ────────────────────────────────────────────────────────
export default function SearchComposer() {
  const [q, setQ] = useState('');
  const [products, setProducts] = useState(new Set(['Agentforce', 'Health Cloud']));
  const [supportTypes, setSupportTypes] = useState(new Set(['Technical fix']));
  const [timeframe, setTimeframe] = useState('week');
  const [languages, setLanguages] = useState(new Set(['English']));
  const filters = { q, products, supportTypes, timeframe, languages };
  const set = {
    q: setQ,
    products: setProducts,
    supportTypes: setSupportTypes,
    timeframe: setTimeframe,
    languages: setLanguages,
  };
  const [surface, setSurface] = useState('hero');

  const urlString = useMemo(() => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (products.size) p.set('products', [...products].join(','));
    if (supportTypes.size) p.set('supportTypes', [...supportTypes].join(','));
    if (timeframe !== 'any') p.set('timeframe', timeframe);
    if (languages.size) p.set('languages', [...languages].join(','));
    return '/experts?' + p.toString();
  }, [q, products, supportTypes, timeframe, languages]);

  return (
    <div
      style={{
        minHeight: '100vh',
        background: c.bg,
        fontFamily: "'DM Sans', -apple-system, sans-serif",
        padding: '28px 28px 64px',
      }}
    >
      <link
        href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap"
        rel="stylesheet"
      />
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 18,
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: c.text, margin: 0 }}>
              Search Composer
            </h1>
            <p style={{ fontSize: 13, color: c.textSecondary, margin: '4px 0 0' }}>
              One <code>SearchFilters</code> state across surfaces — change it anywhere, it reflects
              everywhere.
            </p>
          </div>
          <div
            style={{
              display: 'inline-flex',
              gap: 4,
              padding: 4,
              borderRadius: 10,
              background: c.surfaceSubtle,
              border: `1px solid ${c.borderSubtle}`,
            }}
          >
            {[
              ['hero', 'Hero bar'],
              ['compact', 'Compact + rail'],
              ['mobile', 'Mobile'],
            ].map(([k, label]) => (
              <button
                key={k}
                onClick={() => setSurface(k)}
                style={{
                  padding: '8px 16px',
                  borderRadius: 7,
                  fontSize: 13,
                  fontWeight: 550,
                  border: 'none',
                  cursor: 'pointer',
                  background: surface === k ? c.surface : 'transparent',
                  color: surface === k ? c.text : c.textTertiary,
                  boxShadow: surface === k ? '0 1px 3px rgba(0,0,0,0.06)' : 'none',
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div
          style={{
            marginBottom: 20,
            padding: '10px 14px',
            borderRadius: 10,
            background: '#0F1729',
            color: '#9FE7C9',
            fontFamily: 'monospace',
            fontSize: 12.5,
            overflow: 'auto',
            whiteSpace: 'nowrap',
          }}
        >
          {urlString}
        </div>

        {surface === 'hero' && (
          <div
            style={{
              borderRadius: 20,
              background: c.gradientSubtle,
              border: `1px solid ${c.accentBorder}66`,
              padding: '40px 36px 44px',
            }}
          >
            <h2
              style={{
                margin: '0 0 6px',
                fontSize: 28,
                fontWeight: 700,
                color: c.text,
                textAlign: 'center',
              }}
            >
              Find a Salesforce expert
            </h2>
            <p
              style={{
                margin: '0 0 28px',
                fontSize: 15,
                color: c.textSecondary,
                textAlign: 'center',
              }}
            >
              Search by keyword, or narrow with the filters below.
            </p>
            <UnifiedBar filters={filters} set={set} compact={false} />
          </div>
        )}
        {surface === 'compact' && (
          <div>
            <UnifiedBar filters={filters} set={set} compact={true} />
            <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', marginTop: 20 }}>
              <Rail filters={filters} set={set} />
              <div
                style={{
                  flex: 1,
                  padding: '80px 0',
                  textAlign: 'center',
                  color: c.textTertiary,
                  fontSize: 13,
                  border: `1px dashed ${c.border}`,
                  borderRadius: 12,
                }}
              >
                Results grid (BAL-247) renders here
              </div>
            </div>
          </div>
        )}
        {surface === 'mobile' && <MobileComposer filters={filters} set={set} />}
      </div>
    </div>
  );
}
