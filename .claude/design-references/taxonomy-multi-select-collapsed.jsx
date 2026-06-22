import { useState, useRef, useEffect, useMemo } from 'react';

// ══════════════════════════════════════════════════════════════════
// DESIGN REFERENCE — TaxonomyMultiSelect (FINAL)
// Behaviour-change reference for the EXISTING component
//   apps/web/src/components/balo/taxonomy-multi-select.tsx
//
// Field layout, top → bottom:
//   1. Search control — ANCHORED at the field's top edge. Never moves as
//      selections grow. Click/focus opens the browse popup.
//   2. Selected-items BAND — directly below the search control, grows
//      downward. EXISTING band + pill design unchanged: "N selected /
//      Clear all" header, blue-tint pills, blue name, × on the RIGHT.
//      The ONLY addition is a small muted category line above the name
//      (multi-group only). Do NOT restyle the pill or move the ×.
//      The band exists (vs. inlining chips into the control) so pills have
//      room — deliberate.
//   3. Browse popup — an OVERLAY (absolutely positioned) that floats over
//      the content below. Opening/closing it must NOT reflow following
//      sections (e.g. "Attach documents" stays put).
//
// Rules:
//   • groups.length === 1  → flat list, NO category labels in the popup,
//     and pills render NAME-ONLY (no category line).
//   • groups.length >= 2   → every popup group shows its label; every pill
//     shows its category line, including self-titled products
//     (Data Cloud over Data Cloud) — consistency over de-duplication.
//
// Controls: Field (Products | Project type | Flat 1-group) × State
// (resting | active | filtered | empty). An "Attach documents" block sits
// below the field to demonstrate the overlay does not push it down.
// ══════════════════════════════════════════════════════════════════

const C = {
  bg: '#F8FAFB',
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
  glow: 'rgba(37,99,235,0.12)',
};

const PRODUCTS = {
  groups: [
    { id: 'ai', name: 'AI', items: [{ id: 'p-agent', name: 'Agentforce' }] },
    { id: 'data', name: 'Data Cloud', items: [{ id: 'p-dc', name: 'Data Cloud' }] },
    {
      id: 'sales',
      name: 'Sales Cloud',
      items: [
        { id: 'p-cpq', name: 'CPQ' },
        { id: 'p-sc', name: 'Sales Cloud' },
      ],
    },
    {
      id: 'service',
      name: 'Service Cloud',
      items: [
        { id: 'p-de', name: 'Digital Engagement' },
        { id: 'p-fs', name: 'Field Service' },
        { id: 'p-svc', name: 'Service Cloud' },
        { id: 'p-voice', name: 'Voice' },
      ],
    },
    {
      id: 'mktg',
      name: 'Marketing Cloud',
      items: [
        { id: 'p-ae', name: 'Account Engagement' },
        { id: 'p-eng', name: 'Engagement' },
        { id: 'p-intel', name: 'Intelligence' },
        { id: 'p-loyal', name: 'Loyalty Management' },
        { id: 'p-pers', name: 'Personalization' },
      ],
    },
    { id: 'slack', name: 'Slack', items: [{ id: 'p-slack', name: 'Slack' }] },
    { id: 'exp', name: 'Experience Cloud', items: [{ id: 'p-exp', name: 'Experience Cloud' }] },
    {
      id: 'commerce',
      name: 'Commerce Cloud',
      items: [
        { id: 'p-b2b', name: 'B2B Commerce' },
        { id: 'p-b2c', name: 'B2C Commerce' },
        { id: 'p-om', name: 'Order Management' },
      ],
    },
    {
      id: 'platform',
      name: 'Platform',
      items: [
        { id: 'p-ax', name: 'AppExchange' },
        { id: 'p-heroku', name: 'Heroku' },
        { id: 'p-hf', name: 'Hyperforce' },
        { id: 'p-sfp', name: 'Salesforce Platform' },
        { id: 'p-flow', name: 'Flow' },
        { id: 'p-mule', name: 'Mulesoft' },
      ],
    },
    {
      id: 'tableau',
      name: 'Tableau',
      items: [
        { id: 'p-crma', name: 'CRM Analytics' },
        { id: 'p-tab', name: 'Tableau' },
      ],
    },
  ],
};

const TAGS = {
  groups: [
    {
      id: 'foundational',
      name: 'Foundational',
      items: [
        { id: 't-new', name: 'New Salesforce Implementation' },
        { id: 't-merge', name: 'Org Merge / Consolidation' },
        { id: 't-mig', name: 'Data Migration / Data Cleanup' },
        { id: 't-3p', name: 'Third-Party Tool Integration' },
      ],
    },
    {
      id: 'enhancement',
      name: 'Enhancement & Expansion',
      items: [
        { id: 't-feat', name: 'Feature Enhancement / Customization' },
        { id: 't-expand', name: 'Product / Cloud Expansion' },
        { id: 't-mobile', name: 'Mobile Experience Setup' },
        { id: 't-app', name: 'AppExchange / Custom App Build' },
      ],
    },
    {
      id: 'optimization',
      name: 'Optimization',
      items: [
        { id: 't-clean', name: 'System Cleanup / Optimization' },
        { id: 't-health', name: 'Salesforce Health Check / Audit' },
        { id: 't-auto', name: 'Automation Setup' },
        { id: 't-report', name: 'Reporting / Dashboard Setup' },
      ],
    },
    {
      id: 'enablement',
      name: 'Enablement & Support',
      items: [
        { id: 't-strat', name: 'Strategy / Best Practices Advisory' },
        { id: 't-train', name: 'User Onboarding / Training' },
        { id: 't-managed', name: 'Managed Services / Ongoing Support' },
      ],
    },
  ],
};

const FLAT = {
  groups: [
    {
      id: 'only',
      name: 'Engagement model',
      items: [
        { id: 'f-case', name: 'Case (per-minute)' },
        { id: 'f-project', name: 'Project (scoped)' },
        { id: 'f-package', name: 'Package (productized)' },
        { id: 'f-retainer', name: 'Embedded / retainer' },
      ],
    },
  ],
};

const DENSE_CAP = 4;

const Ico = ({ d, size = 16, c = 'currentColor', sw = 2, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={c}
    strokeWidth={sw}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={style}
  >
    {d}
  </svg>
);
const I = {
  search: (p) => (
    <Ico
      {...p}
      d={
        <>
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </>
      }
    />
  ),
  x: (p) => <Ico {...p} d={<path d="M18 6L6 18M6 6l12 12" />} />,
  chevron: (p) => <Ico {...p} d={<path d="M6 9l6 6 6-6" />} />,
  plus: (p) => <Ico {...p} d={<path d="M12 5v14M5 12h14" />} />,
  check: (p) => <Ico {...p} d={<path d="M20 6L9 17l-5-5" />} />,
  upload: (p) => (
    <Ico
      {...p}
      d={
        <>
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
          <path d="M17 8l-5-5-5 5M12 3v12" />
        </>
      }
    />
  ),
};

function highlight(name, term) {
  if (!term) return name;
  const i = name.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0) return name;
  return (
    <>
      {name.slice(0, i)}
      <mark style={{ background: '#FEF3C7', color: 'inherit', padding: 0, borderRadius: 2 }}>
        {name.slice(i, i + term.length)}
      </mark>
      {name.slice(i + term.length)}
    </>
  );
}

// ── Selected pill — EXISTING design: WHITE pill body, blue border, blue name,
//    × on the RIGHT inside a FILLED circle. Rest = pale-blue circle + blue × ;
//    hover = solid blue circle + white × . The pale-blue is ONLY the × circle,
//    not the pill body. ONLY addition: muted category line above name (multi-group).
function SelectedPill({ category, name, showCategory, onRemove }) {
  const [h, setH] = useState(false);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 7px 5px 11px',
        borderRadius: 8,
        background: C.surface,
        border: `1px solid ${C.primaryBorder}`,
      }}
    >
      <span
        style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2, textAlign: 'left' }}
      >
        {showCategory && (
          <span style={{ fontSize: 11, fontWeight: 400, color: C.textTertiary }}>{category}</span>
        )}
        <span style={{ fontSize: 13.5, fontWeight: 600, color: C.primary }}>{name}</span>
      </span>
      <button
        onClick={onRemove}
        onMouseEnter={() => setH(true)}
        onMouseLeave={() => setH(false)}
        aria-label={`Remove ${name}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 20,
          height: 20,
          borderRadius: '50%',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
          background: h ? C.primary : '#DBEAFE',
          transition: 'background .12s',
        }}
      >
        <I.x size={12} c={h ? '#FFFFFF' : C.primary} sw={2.4} />
      </button>
    </span>
  );
}

function OptChip({ item, term, selected, onToggle }) {
  const [h, setH] = useState(false);
  return (
    <button
      onMouseDown={(e) => e.preventDefault()}
      onClick={onToggle}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        padding: '8px 12px',
        borderRadius: 10,
        fontSize: 13,
        fontWeight: 500,
        cursor: 'pointer',
        border: `1px solid ${selected ? C.primaryBorder : C.border}`,
        background: selected ? C.primaryLight : h ? C.surfaceSubtle : C.surface,
        color: selected ? C.primary : C.text,
        transition: 'all .15s',
      }}
    >
      {selected && <I.check size={13} c={C.primary} />}
      {highlight(item.name, term)}
    </button>
  );
}

// ══════════════════════════════════════════════════════════════════
function TaxonomyMultiSelect({
  taxonomy,
  selected,
  onToggle,
  onClear,
  searchPlaceholder,
  noMatchNoun,
  forceOpen,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(new Set());
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const isOpen = forceOpen ?? open;

  useEffect(() => {
    if (forceOpen !== undefined) return;
    function onDoc(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [forceOpen]);

  const multiGroup = taxonomy.groups.length >= 2;
  const trimmed = query.trim();
  const filtered = useMemo(() => {
    if (!trimmed) return taxonomy.groups;
    const q = trimmed.toLowerCase();
    return taxonomy.groups
      .map((g) => ({
        ...g,
        items: g.items.filter(
          (it) => it.name.toLowerCase().includes(q) || g.name.toLowerCase().includes(q)
        ),
      }))
      .filter((g) => g.items.length > 0);
  }, [taxonomy.groups, trimmed]);

  const selectedItems = useMemo(() => {
    const out = [];
    for (const g of taxonomy.groups)
      for (const it of g.items) if (selected.has(it.id)) out.push({ ...it, category: g.name });
    return out;
  }, [taxonomy.groups, selected]);

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      {/* 1 — SEARCH CONTROL, anchored at top */}
      <div
        onClick={() => {
          setOpen(true);
          inputRef.current?.focus();
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          height: 44,
          padding: '0 14px',
          borderRadius: 11,
          cursor: 'text',
          background: C.surface,
          border: `1px solid ${isOpen ? C.primary : C.border}`,
          boxShadow: isOpen ? `0 0 0 3px ${C.glow}` : 'none',
          transition: 'all .15s',
        }}
      >
        <I.search size={16} c={C.textTertiary} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder={searchPlaceholder}
          style={{
            flex: 1,
            minWidth: 0,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            fontSize: 14,
            color: C.text,
          }}
        />
        {query && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setQuery('');
            }}
            aria-label="Clear search"
            style={{
              display: 'flex',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: C.textTertiary,
            }}
          >
            <I.x size={14} c={C.textTertiary} />
          </button>
        )}
        <I.chevron
          size={16}
          c={C.textTertiary}
          style={{ transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}
        />
      </div>

      {/* 3 — BROWSE POPUP: overlay, floats over content below (no reflow) */}
      {isOpen && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 'calc(44px + 6px)',
            zIndex: 30,
            maxHeight: 300,
            overflowY: 'auto',
            background: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: 12,
            padding: 10,
            boxShadow: '0 10px 30px rgba(15,23,41,0.12)',
          }}
        >
          {filtered.length === 0 ? (
            <p
              style={{
                textAlign: 'center',
                padding: '20px 0',
                fontSize: 13,
                color: C.textTertiary,
              }}
            >
              No {noMatchNoun} match &ldquo;{trimmed}&rdquo;
            </p>
          ) : (
            filtered.map((g) => {
              const dense = g.items.length > DENSE_CAP && !trimmed;
              const showAll = expanded.has(g.id);
              const visible = dense && !showAll ? g.items.slice(0, DENSE_CAP) : g.items;
              const hidden = g.items.length - visible.length;
              return (
                <div key={g.id} style={{ marginBottom: 14 }}>
                  {multiGroup && (
                    <div
                      style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 9 }}
                    >
                      <span
                        style={{
                          fontSize: 11.5,
                          fontWeight: 700,
                          letterSpacing: '.04em',
                          textTransform: 'uppercase',
                          color: C.textTertiary,
                        }}
                      >
                        {g.name}
                      </span>
                      {g.items.length > 1 && (
                        <span style={{ fontSize: 11, color: C.textTertiary }}>
                          {g.items.length}
                        </span>
                      )}
                    </div>
                  )}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {visible.map((it) => (
                      <OptChip
                        key={it.id}
                        item={it}
                        term={trimmed}
                        selected={selected.has(it.id)}
                        onToggle={() => onToggle(it.id)}
                      />
                    ))}
                    {hidden > 0 && (
                      <button
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => setExpanded((p) => new Set(p).add(g.id))}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '8px 12px',
                          borderRadius: 10,
                          fontSize: 13,
                          fontWeight: 500,
                          border: `1px dashed ${C.border}`,
                          background: 'transparent',
                          color: C.textSecondary,
                          cursor: 'pointer',
                        }}
                      >
                        <I.plus size={13} c={C.textSecondary} /> {hidden} more
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* 2 — SELECTED BAND, below the search control, grows downward */}
      {selectedItems.length > 0 && (
        <div
          style={{
            background: C.primaryLight,
            border: `1px solid ${C.primaryBorder}`,
            borderRadius: 12,
            padding: 12,
            marginTop: 10,
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
                letterSpacing: '.05em',
                textTransform: 'uppercase',
                color: C.textTertiary,
              }}
            >
              {selectedItems.length} selected
            </span>
            <button
              onClick={onClear}
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: C.textSecondary,
                textDecoration: 'underline',
                textUnderlineOffset: 2,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
              }}
            >
              Clear all
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {selectedItems.map((it) => (
              <SelectedPill
                key={it.id}
                category={it.category}
                name={it.name}
                showCategory={multiGroup}
                onRemove={() => onToggle(it.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, optional, hint, children }) {
  return (
    <div>
      <div style={{ fontSize: 14, fontWeight: 500, color: C.text, marginBottom: 3 }}>
        {label}
        {optional && <span style={{ fontWeight: 400, color: C.textTertiary }}> (optional)</span>}
      </div>
      {hint && (
        <div style={{ fontSize: 12.5, color: C.textTertiary, marginBottom: 10 }}>{hint}</div>
      )}
      {children}
    </div>
  );
}

const FIELDS = {
  products: {
    tax: PRODUCTS,
    label: 'Salesforce products',
    hint: 'Which products does this touch? Same list as expert search.',
    placeholder: 'Search products…',
    noun: 'products',
    seed: ['p-dc', 'p-agent', 'p-fs'],
  },
  tags: {
    tax: TAGS,
    label: 'Project type',
    hint: 'Pick the categories that best describe this work — helps us scope it.',
    placeholder: 'Search project types…',
    noun: 'project types',
    seed: ['t-health'],
  },
  flat: {
    tax: FLAT,
    label: 'Engagement model',
    hint: 'Single-group taxonomy → no category labels; pills are name-only.',
    placeholder: 'Search models…',
    noun: 'models',
    seed: ['f-project'],
  },
};

export default function TaxonomyPickerReference() {
  const [field, setField] = useState('products');
  const [state, setState] = useState('resting');
  const cfg = FIELDS[field];
  const [selected, setSelected] = useState(new Set(cfg.seed));

  const [lastField, setLastField] = useState(field);
  if (lastField !== field) {
    setLastField(field);
    setSelected(new Set(FIELDS[field].seed));
    setState('resting');
  }

  const sel = state === 'empty' ? new Set() : selected;
  const toggle = (id) =>
    setSelected((p) => {
      const n = new Set(p);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const Seg = ({ value, set, opts }) => (
    <div
      style={{
        display: 'inline-flex',
        gap: 3,
        padding: 3,
        borderRadius: 10,
        background: C.surfaceSubtle,
      }}
    >
      {opts.map((o) => {
        const on = value === o.k;
        return (
          <button
            key={o.k}
            onClick={() => set(o.k)}
            style={{
              padding: '7px 12px',
              borderRadius: 7,
              fontSize: 12.5,
              fontWeight: on ? 650 : 500,
              border: 'none',
              cursor: 'pointer',
              background: on ? C.surface : 'transparent',
              color: on ? C.text : C.textTertiary,
              boxShadow: on ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
            }}
          >
            {o.l}
          </button>
        );
      })}
    </div>
  );

  return (
    <div
      style={{
        minHeight: '100vh',
        background: C.bg,
        fontFamily: "'DM Sans', -apple-system, sans-serif",
        padding: '28px 20px',
      }}
    >
      <link
        href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;650;700&display=swap"
        rel="stylesheet"
      />
      <div style={{ maxWidth: 560, margin: '0 auto' }}>
        <div
          style={{
            display: 'flex',
            gap: 18,
            flexWrap: 'wrap',
            alignItems: 'center',
            marginBottom: 24,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: C.textTertiary,
                textTransform: 'uppercase',
                letterSpacing: '.06em',
                marginBottom: 6,
              }}
            >
              Field
            </div>
            <Seg
              value={field}
              set={setField}
              opts={[
                { k: 'products', l: 'Products' },
                { k: 'tags', l: 'Project type' },
                { k: 'flat', l: 'Flat (1 group)' },
              ]}
            />
          </div>
          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: C.textTertiary,
                textTransform: 'uppercase',
                letterSpacing: '.06em',
                marginBottom: 6,
              }}
            >
              State
            </div>
            <Seg
              value={state}
              set={setState}
              opts={[
                { k: 'resting', l: 'Resting' },
                { k: 'active', l: 'Active' },
                { k: 'filtered', l: 'Filtered' },
                { k: 'empty', l: 'Empty' },
              ]}
            />
          </div>
        </div>

        {/* Panel context — field + a following section to prove the overlay doesn't reflow */}
        <div
          style={{
            background: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: 16,
            padding: 22,
          }}
        >
          <Field label={cfg.label} optional hint={cfg.hint}>
            <TaxonomyMultiSelect
              key={`${field}-${state}`}
              taxonomy={cfg.tax}
              selected={sel}
              onToggle={toggle}
              onClear={() => setSelected(new Set())}
              searchPlaceholder={cfg.placeholder}
              noMatchNoun={cfg.noun}
              forceOpen={state === 'active' || state === 'filtered' ? true : undefined}
            />
          </Field>

          <div style={{ marginTop: 26 }}>
            <div style={{ fontSize: 14, fontWeight: 500, color: C.text, marginBottom: 3 }}>
              Attach documents{' '}
              <span style={{ fontWeight: 400, color: C.textTertiary }}>(optional)</span>
            </div>
            <div style={{ fontSize: 12.5, color: C.textTertiary, marginBottom: 10 }}>
              PDF, PNG, JPEG or WEBP · up to 4 files · 5 MB each.
            </div>
            <div
              style={{
                border: `1px dashed ${C.border}`,
                borderRadius: 11,
                padding: 22,
                textAlign: 'center',
                color: C.textTertiary,
              }}
            >
              <I.upload size={22} c={C.textTertiary} />
              <div style={{ fontSize: 13, marginTop: 6 }}>Drop files or click to upload</div>
            </div>
          </div>
        </div>

        <p style={{ fontSize: 12, color: C.textTertiary, marginTop: 14, lineHeight: 1.6 }}>
          Search control anchored at the field top (never moves). Selected band sits below it —
          existing blue-tint pills, × on the right — with the category added as a small muted line
          above the name (multi-group only). Browse list opens as an overlay — set State to
          Active/Filtered, and note &ldquo;Attach documents&rdquo; does not move. Flat field shows
          the single-group path: no popup category labels, name-only pills.
        </p>
      </div>
    </div>
  );
}
