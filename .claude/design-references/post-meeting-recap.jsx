import React, { useState } from 'react';
import {
  Clock,
  Receipt,
  ArrowUpRight,
  CheckCircle2,
  Circle,
  Play,
  MessageSquare,
  FileText,
  Image as ImageIcon,
  Download,
  Star,
  ChevronDown,
  ChevronRight,
  Calendar,
  Sparkles,
  MoreHorizontal,
  AlertTriangle,
  Check,
  Loader2,
  Lock,
  ShieldCheck,
  Users,
  Link2,
  FileDown,
  Flag,
  Info,
  FilePlus2,
  UserRound,
} from 'lucide-react';

/**
 * Balo — Post-meeting recap, DASHBOARD v2 (hierarchy pass, comparison build)
 * Sibling to balo-post-meeting-recap(.jsx) and -dashboard(.jsx). Do not replace them.
 *
 * Directing the eye (the fix for "dashboard doesn't guide navigation"):
 *  - Unequal columns (~2.4 : 1) → left is clearly main, right is clearly a rail.
 *  - Weighted hero (summary + actions get a soft raised shadow); rail cards sit flatter/quieter.
 *  - Slim header + a light meta line (date · duration · amount · open actions) instead of
 *    three equal stat tiles competing at the top.
 *  - Top-left anchor: the hero starts top-left; no heavy header CTA pulling right.
 *
 * Other-party card (compact, rail-top, lens-aware, routed through platform):
 *  - Client lens → expert card + rating + Book again (booking flow) + Turn into project.
 *  - Expert lens → client-context card + Send proposal + Add note. No contact info either side.
 */

const C = {
  bg: '#F4F5F7',
  card: '#FFFFFF',
  rail: '#FCFCFD',
  line: '#E6E8EC',
  line2: '#F0F1F4',
  text: '#171A1F',
  sub: '#5B6472',
  faint: '#9AA1AD',
  brand: '#2563EB',
  brandSoft: '#EAF0FE',
  good: '#12996B',
  goodSoft: '#E7F6EF',
  warn: '#9A6A12',
  warnSoft: '#FBF2DF',
  danger: '#D5342B',
};
const HERO_SHADOW = '0 1px 2px rgba(16,20,28,0.05), 0 6px 18px rgba(16,20,28,0.05)';

const EXPERT = {
  name: 'Dr. Amara Okafor',
  org: 'Okafor Advisory',
  initials: 'AO',
  hue: '#7C3AED',
  title: 'Salesforce CPQ specialist',
  rating: '4.9',
  reviews: 128,
};
const CLIENT = {
  name: 'Jordan Lee',
  org: 'Northwind',
  initials: 'JL',
  hue: '#0EA5E9',
  title: 'RevOps Lead',
  note: '2nd consultation',
};

const ACTIONS = [
  { who: EXPERT, text: 'Share the corrected discount-rules export', due: 'by Fri' },
  { who: CLIENT, text: 'Rebuild the discount schedule with product-family bundles' },
  { who: CLIENT, text: 'Validate against the Q3 quote template in the sandbox' },
  { who: null, text: 'Book a follow-up to review the results together' },
];
const FILES = [
  { name: 'current-cpq-rules.pdf', by: 'Jordan', size: '1.4 MB', icon: FileText },
  { name: 'quote-template-v3.png', by: 'Amara', size: '612 KB', icon: ImageIcon },
];

/* ---------- primitives ---------- */

function Avatar({ p, size = 30 }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center font-semibold"
      style={{
        width: size,
        height: size,
        borderRadius: size,
        background: p.hue,
        color: '#fff',
        fontSize: size * 0.38,
      }}
    >
      {p.initials}
    </div>
  );
}
/* photo slot — production shows the person's uploaded headshot */
function PhotoAvatar({ p, size = 56 }) {
  return (
    <div
      className="relative flex shrink-0 items-center justify-center overflow-hidden"
      style={{
        width: size,
        height: size,
        borderRadius: size,
        background: `linear-gradient(155deg, ${p.hue}, ${p.hue}AA)`,
      }}
    >
      <UserRound size={size * 0.58} color="rgba(255,255,255,0.92)" strokeWidth={1.5} />
      <div
        className="absolute inset-0"
        style={{ borderRadius: size, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.08)' }}
      />
    </div>
  );
}
function Seg({ options, value, onChange }) {
  return (
    <div
      className="flex items-center gap-1 rounded-lg p-1"
      style={{ background: '#0d1017', border: '1px solid rgba(255,255,255,0.08)' }}
    >
      {options.map((o) => {
        const a = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className="rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
            style={{ background: a ? C.brand : 'transparent', color: a ? '#fff' : '#9AA2B0' }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
function Pill({ tone = 'good', children }) {
  const map = {
    good: [C.goodSoft, C.good],
    warn: [C.warnSoft, C.warn],
    brand: [C.brandSoft, C.brand],
    muted: ['#EEF0F3', C.sub],
  };
  const [bg, fg] = map[tone];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium"
      style={{ background: bg, color: fg }}
    >
      {children}
    </span>
  );
}
function Hero({ children }) {
  return (
    <div
      className="rounded-2xl"
      style={{ background: C.card, border: `1px solid ${C.line}`, boxShadow: HERO_SHADOW }}
    >
      {children}
    </div>
  );
}
function Quiet({ children, style }) {
  return (
    <div
      className="rounded-2xl"
      style={{ background: C.rail, border: `1px solid ${C.line}`, ...style }}
    >
      {children}
    </div>
  );
}
function Skel({ w = '100%', h = 12, mt = 0 }) {
  return (
    <div
      className="animate-pulse rounded"
      style={{ width: w, height: h, marginTop: mt, background: '#E9EBEF' }}
    />
  );
}

/* ---------- header + meta ---------- */

function Header({ outcome }) {
  const [menu, setMenu] = useState(false);
  const status =
    outcome === 'processing' ? (
      <Pill tone="brand">
        <Loader2 size={12} className="animate-spin" /> Wrapping up
      </Pill>
    ) : outcome === 'confirm' ? (
      <Pill tone="warn">
        <AlertTriangle size={12} /> Confirm duration
      </Pill>
    ) : outcome === 'noshow' ? (
      <Pill tone="muted">No-show</Pill>
    ) : (
      <Pill tone="good">
        <Check size={12} /> Completed
      </Pill>
    );
  const items = [
    { icon: FileDown, label: 'Download recording' },
    { icon: FileText, label: 'Export summary (PDF)' },
    { icon: Link2, label: 'Copy transcript link' },
    { icon: Flag, label: 'Report an issue' },
  ];
  return (
    <div>
      <button className="mb-3 flex items-center gap-1.5 text-sm" style={{ color: C.sub }}>
        <ChevronRight size={15} style={{ transform: 'rotate(180deg)' }} /> Back to the case
      </button>
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-xl font-semibold" style={{ color: C.text }}>
            Salesforce CPQ consultation
          </h1>
          {status}
        </div>
        <div className="relative shrink-0">
          <button
            onClick={() => setMenu((m) => !m)}
            className="flex items-center justify-center rounded-xl"
            style={{
              width: 36,
              height: 36,
              border: `1px solid ${C.line}`,
              background: '#fff',
              color: C.sub,
            }}
          >
            <MoreHorizontal size={18} />
          </button>
          {menu && (
            <>
              <div
                className="fixed inset-0"
                style={{ zIndex: 20 }}
                onClick={() => setMenu(false)}
              />
              <div
                className="absolute right-0 mt-1 overflow-hidden rounded-xl"
                style={{
                  width: 220,
                  background: '#fff',
                  border: `1px solid ${C.line}`,
                  boxShadow: '0 10px 30px rgba(0,0,0,0.10)',
                  zIndex: 30,
                }}
              >
                <div className="p-1.5">
                  {items.map((it, i) => (
                    <button
                      key={i}
                      onClick={() => setMenu(false)}
                      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors hover:bg-black/[0.03]"
                      style={{ color: C.text }}
                    >
                      <it.icon size={16} color={C.sub} /> {it.label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Meta({ lens, outcome }) {
  const client = lens === 'client';
  const money = outcome === 'processing' || outcome === 'confirm';
  const Item = ({ children }) => (
    <span className="inline-flex items-center gap-1.5">{children}</span>
  );
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3 text-sm" style={{ color: C.sub }}>
      <Item>
        <Calendar size={14} /> Today, 2:14 PM
      </Item>
      <span style={{ color: C.faint }}>·</span>
      <Item>
        <Clock size={14} /> 45 min
      </Item>
      <span style={{ color: C.faint }}>·</span>
      {money ? (
        <Item>
          {client ? <Receipt size={14} /> : <ArrowUpRight size={14} />}{' '}
          <Pill tone="brand">
            <Loader2 size={11} className="animate-spin" />{' '}
            {client ? 'Charge pending' : 'Payout pending'}
          </Pill>
        </Item>
      ) : (
        <Item>
          {client ? <Receipt size={14} /> : <ArrowUpRight size={14} />}{' '}
          {client ? 'A$150.00' : 'A$112.50'}{' '}
          <button className="text-xs font-medium" style={{ color: C.brand }}>
            {client ? 'receipt' : 'payout'}
          </button>
        </Item>
      )}
      <span style={{ color: C.faint }}>·</span>
      <Item>
        <CheckCircle2 size={14} />{' '}
        <span style={{ color: C.text, fontWeight: 600 }}>{ACTIONS.length} open</span> action items
      </Item>
    </div>
  );
}

/* ---------- hero: summary + actions ---------- */

function Summary({ processing }) {
  const [full, setFull] = useState(false);
  return (
    <Hero>
      <div className="flex items-center justify-between px-5 pt-4 pb-2">
        <div className="flex items-center gap-2">
          <Sparkles size={16} color={C.brand} />
          <span className="text-[15px] font-semibold" style={{ color: C.text }}>
            Summary
          </span>
        </div>
        {!processing && (
          <span className="text-xs" style={{ color: C.faint }}>
            AI-generated
          </span>
        )}
      </div>
      <div className="px-5 pb-4">
        {processing ? (
          <div className="flex flex-col gap-2.5">
            <Skel w="95%" />
            <Skel w="88%" />
            <Skel w="64%" />
          </div>
        ) : (
          <>
            <p className="text-sm leading-relaxed" style={{ color: '#33383F' }}>
              Amara traced two quote errors to misconfigured discount rules and agreed a fix:
              rebuild the discount schedule around product-family bundles
              {full
                ? ', then validate against the Q3 quote template before rollout. Amara will send a corrected rules export; Jordan will test it in the sandbox ahead of a short follow-up to confirm the results.'
                : '…'}
            </p>
            <button
              onClick={() => setFull((f) => !f)}
              className="mt-2 text-xs font-medium"
              style={{ color: C.brand }}
            >
              {full ? 'Show less' : 'Read full summary'}
            </button>
          </>
        )}
      </div>
    </Hero>
  );
}

function Actions({ processing }) {
  const [done, setDone] = useState({});
  const n = Object.values(done).filter(Boolean).length;
  return (
    <Hero>
      <div className="flex items-center justify-between px-5 pt-4 pb-2">
        <div className="flex items-center gap-2">
          <CheckCircle2 size={16} color={C.brand} />
          <span className="text-[15px] font-semibold" style={{ color: C.text }}>
            Action items
          </span>
        </div>
        {!processing && (
          <span className="text-xs" style={{ color: C.faint }}>
            {n}/{ACTIONS.length} done
          </span>
        )}
      </div>
      <div className="px-3 pb-2">
        {processing ? (
          <div className="flex flex-col gap-3 px-2 py-2">
            <Skel w="82%" h={14} />
            <Skel w="70%" h={14} />
            <Skel w="58%" h={14} />
          </div>
        ) : (
          ACTIONS.map((a, i) => {
            const c = !!done[i];
            return (
              <button
                key={i}
                onClick={() => setDone((d) => ({ ...d, [i]: !d[i] }))}
                className="flex w-full items-start gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-black/[0.02]"
              >
                {c ? (
                  <CheckCircle2 size={19} color={C.good} className="mt-0.5 shrink-0" />
                ) : (
                  <Circle size={19} color={C.faint} className="mt-0.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1">
                  <span
                    className="text-sm"
                    style={{
                      color: c ? C.faint : C.text,
                      textDecoration: c ? 'line-through' : 'none',
                    }}
                  >
                    {a.text}
                  </span>
                  <span className="mt-1 flex items-center gap-2">
                    {a.who ? (
                      <span
                        className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs"
                        style={{ background: '#F0F1F4', color: C.sub }}
                      >
                        <span
                          className="rounded-full"
                          style={{ width: 6, height: 6, background: a.who.hue }}
                        />{' '}
                        {a.who.name.split(' ').slice(-1)[0]}
                      </span>
                    ) : (
                      <span
                        className="rounded px-1.5 py-0.5 text-xs"
                        style={{ background: '#F0F1F4', color: C.sub }}
                      >
                        Both
                      </span>
                    )}
                    {a.due && (
                      <span className="text-xs" style={{ color: C.faint }}>
                        {a.due}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </Hero>
  );
}

function TLine({ who, text }) {
  return (
    <div>
      <span className="font-medium" style={{ color: C.text }}>
        {who}
      </span>{' '}
      <span style={{ color: '#454B54' }}>{text}</span>
    </div>
  );
}

function TranscriptSection({ processing }) {
  const [open, setOpen] = useState(false);
  return (
    <Hero>
      <div className="flex items-center justify-between px-5 pt-4 pb-2">
        <div className="flex items-center gap-2">
          <MessageSquare size={16} color={C.brand} />
          <span className="text-[15px] font-semibold" style={{ color: C.text }}>
            Transcript
          </span>
          {!processing && (
            <span className="text-xs" style={{ color: C.faint }}>
              cleaned
            </span>
          )}
        </div>
        {!processing && (
          <button
            onClick={() => setOpen((o) => !o)}
            className="text-xs font-medium"
            style={{ color: C.brand }}
          >
            {open ? 'Collapse' : 'View full transcript'}
          </button>
        )}
      </div>
      <div className="px-5 pb-4">
        {processing ? (
          <div className="flex items-center gap-2 text-sm" style={{ color: C.faint }}>
            <Loader2 size={15} className="animate-spin" /> Transcript is being prepared…
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-3 text-sm leading-relaxed">
              <TLine
                who="Amara"
                text="Let's start with the two quotes that errored out — can you pull up the discount rules on the Enterprise bundle?"
              />
              <TLine
                who="Jordan"
                text="Sure, sharing my screen now. This is the schedule we set up last quarter."
              />
              <TLine
                who="Amara"
                text="Right — the tiered discount and the bundle discount are both firing. That double-count is your error."
              />
              {open && (
                <>
                  <TLine who="Jordan" text="So we collapse them into one product-family rule?" />
                  <TLine
                    who="Amara"
                    text="Exactly. I'll send a corrected export; rebuild around product families and validate against the Q3 template before rollout."
                  />
                  <TLine
                    who="Jordan"
                    text="Got it. I'll test in the sandbox and we can review next week."
                  />
                </>
              )}
            </div>
            {!open && (
              <div className="mt-2 text-xs" style={{ color: C.faint }}>
                … transcript continues …
              </div>
            )}
            <div className="mt-3 flex items-start gap-2 text-xs" style={{ color: C.faint }}>
              <Lock size={12} className="mt-0.5 shrink-0" />
              <span>Cleaned transcript. The verbatim record is retained but not shown.</span>
            </div>
          </>
        )}
      </div>
    </Hero>
  );
}

function NotCaptured() {
  return (
    <Hero>
      <div className="flex flex-col items-center gap-2 px-5 py-6 text-center">
        <span
          className="flex items-center justify-center rounded-2xl"
          style={{ width: 48, height: 48, background: '#F0F1F4' }}
        >
          <Info size={20} color={C.sub} />
        </span>
        <div className="mt-1 text-sm font-medium" style={{ color: C.text }}>
          This session wasn't captured
        </div>
        <div className="max-w-sm text-sm" style={{ color: C.sub }}>
          Held on an external tool, so there's no recording, transcript, or summary. Confirm the
          duration above to complete it.
        </div>
      </div>
    </Hero>
  );
}

/* ---------- rail: other-party card ---------- */

function PersonCard({ lens, processing }) {
  const client = lens === 'client';
  const p = client ? EXPERT : CLIENT;
  const [r, setR] = useState(0);
  const [hov, setHov] = useState(0);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState(false);
  return (
    <Quiet>
      <div className="px-4 py-4">
        <div className="flex items-center gap-3">
          <PhotoAvatar p={p} size={56} />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold" style={{ color: C.text }}>
              {p.name}
            </div>
            <div className="truncate text-xs" style={{ color: C.sub }}>
              {p.title} · {p.org}
            </div>
            {client ? (
              <div className="mt-0.5 flex items-center gap-1 text-xs" style={{ color: C.sub }}>
                <Star size={12} color="#F5A623" fill="#F5A623" /> {p.rating}{' '}
                <span style={{ color: C.faint }}>({p.reviews})</span>
              </div>
            ) : (
              <div className="mt-0.5 text-xs" style={{ color: C.faint }}>
                {p.note}
              </div>
            )}
          </div>
        </div>

        {client && !processing && (
          <div className="mt-3.5 pt-3.5" style={{ borderTop: `1px solid ${C.line2}` }}>
            {saved ? (
              <div className="flex items-center gap-2 text-sm" style={{ color: C.good }}>
                <CheckCircle2 size={16} /> Thanks — your review is in.
              </div>
            ) : (
              <>
                <div className="mb-1.5 text-xs font-medium" style={{ color: C.sub }}>
                  Rate your session
                </div>
                <div className="flex items-center gap-1">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      onMouseEnter={() => setHov(n)}
                      onMouseLeave={() => setHov(0)}
                      onClick={() => setR(n)}
                    >
                      <Star
                        size={22}
                        color={(hov || r) >= n ? '#F5A623' : C.line}
                        fill={(hov || r) >= n ? '#F5A623' : 'none'}
                      />
                    </button>
                  ))}
                </div>
                {r > 0 && (
                  <div className="mt-3">
                    <textarea
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      rows={3}
                      placeholder="What stood out? A couple of lines helps Amara and future clients."
                      className="w-full resize-none rounded-xl px-3 py-2 text-sm outline-none"
                      style={{ background: '#fff', border: `1px solid ${C.line}`, color: C.text }}
                    />
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-xs" style={{ color: C.faint }}>
                        Optional, but encouraged
                      </span>
                      <button
                        onClick={() => setSaved(true)}
                        className="rounded-lg px-3 py-1.5 text-sm font-medium text-white"
                        style={{ background: C.brand }}
                      >
                        Save review
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <div className="mt-3.5 flex flex-col gap-2">
          {client ? (
            <>
              <button
                className="flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium text-white"
                style={{ background: C.brand }}
              >
                <Sparkles size={15} /> Turn into project
              </button>
              <button
                className="flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium"
                style={{ background: '#fff', color: C.text, border: `1px solid ${C.line}` }}
              >
                <Calendar size={15} /> Book again
              </button>
            </>
          ) : (
            <>
              <button
                className="flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium text-white"
                style={{ background: C.brand }}
              >
                <FilePlus2 size={15} /> Send proposal
              </button>
              <button
                className="flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium"
                style={{ background: '#fff', color: C.text, border: `1px solid ${C.line}` }}
              >
                <FileText size={15} /> Add a private note
              </button>
            </>
          )}
        </div>
        {client && (
          <div className="mt-2.5 flex items-center gap-1.5 text-xs" style={{ color: C.faint }}>
            <ShieldCheck size={12} /> Rebooking stays on Balo
          </div>
        )}
      </div>
    </Quiet>
  );
}

/* ---------- rail: meeting records ---------- */

function RecordRow({ icon: Icon, title, meta, open, onToggle, children, last }) {
  return (
    <div style={{ borderBottom: last ? 'none' : `1px solid ${C.line2}` }}>
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 transition-colors hover:bg-black/[0.02]"
      >
        <span
          className="flex shrink-0 items-center justify-center rounded-lg"
          style={{ width: 32, height: 32, background: '#EEF0F3' }}
        >
          <Icon size={15} color={C.sub} />
        </span>
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate text-sm font-medium" style={{ color: C.text }}>
            {title}
          </span>
          {meta && (
            <span className="block text-xs" style={{ color: C.faint }}>
              {meta}
            </span>
          )}
        </span>
        <ChevronDown
          size={15}
          color={C.faint}
          style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}
        />
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

function Records({ processing, confirm }) {
  const [open, setOpen] = useState(null);
  const t = (k) => setOpen((o) => (o === k ? null : k));
  return (
    <Quiet>
      <div className="px-4 pt-3.5 pb-2" style={{ borderBottom: `1px solid ${C.line2}` }}>
        <span className="text-sm font-semibold" style={{ color: C.text }}>
          Meeting records
        </span>
      </div>
      {confirm ? (
        <div className="px-4 py-4 text-sm" style={{ color: C.sub }}>
          No recording or transcript — this session was on an external tool.
        </div>
      ) : (
        <>
          <RecordRow
            icon={Play}
            title="Recording"
            meta={processing ? 'processing…' : '45:12'}
            open={open === 'rec'}
            onToggle={() => !processing && t('rec')}
          >
            <div
              className="relative overflow-hidden rounded-xl"
              style={{ height: 140, background: 'linear-gradient(135deg,#20242C,#2B303A)' }}
            >
              <div className="absolute inset-0 flex items-center justify-center">
                <span
                  className="flex items-center justify-center rounded-full"
                  style={{ width: 46, height: 46, background: 'rgba(255,255,255,0.16)' }}
                >
                  <Play size={19} color="#fff" fill="#fff" />
                </span>
              </div>
            </div>
          </RecordRow>
          <RecordRow
            icon={FileText}
            title="Files"
            meta={`${FILES.length} shared`}
            open={open === 'fl'}
            onToggle={() => t('fl')}
            last
          >
            <div className="flex flex-col gap-1">
              {FILES.map((f, i) => (
                <div key={i} className="flex items-center gap-2.5 px-1 py-1.5">
                  <f.icon size={15} color={C.sub} />
                  <span className="min-w-0 flex-1 truncate text-sm" style={{ color: C.text }}>
                    {f.name}
                  </span>
                  <span className="text-xs" style={{ color: C.faint }}>
                    {f.size}
                  </span>
                  <button className="rounded p-1" style={{ color: C.sub }}>
                    <Download size={14} />
                  </button>
                </div>
              ))}
            </div>
          </RecordRow>
        </>
      )}
    </Quiet>
  );
}

/* ---------- confirm / noshow ---------- */

function ConfirmBanner({ lens, confirmed, onConfirm }) {
  if (confirmed)
    return (
      <div className="rounded-2xl" style={{ background: C.goodSoft, border: '1px solid #CDEBDD' }}>
        <div className="flex items-center gap-3 px-5 py-3.5">
          <CheckCircle2 size={18} color={C.good} />
          <span className="text-sm font-medium" style={{ color: '#0E7A52' }}>
            Duration confirmed — billing is complete.
          </span>
        </div>
      </div>
    );
  return (
    <div className="rounded-2xl" style={{ background: C.warnSoft, border: '1px solid #EFE0BC' }}>
      <div className="flex items-start gap-3 px-5 py-4">
        <AlertTriangle size={18} color={C.warn} className="mt-0.5 shrink-0" />
        <div className="flex-1">
          {lens === 'client' ? (
            <>
              <div className="text-sm font-medium" style={{ color: '#7A5410' }}>
                Amara reported a 45-minute consultation.
              </div>
              <div className="mt-0.5 text-sm" style={{ color: C.warn }}>
                Held on an external tool, so we couldn't capture it automatically. Confirm to
                complete billing.
              </div>
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={onConfirm}
                  className="rounded-lg px-3.5 py-2 text-sm font-medium text-white"
                  style={{ background: C.brand }}
                >
                  Confirm 45 min
                </button>
                <button
                  className="rounded-lg px-3.5 py-2 text-sm font-medium"
                  style={{ background: '#fff', color: C.text, border: `1px solid ${C.line}` }}
                >
                  That's not right
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="text-sm font-medium" style={{ color: '#7A5410' }}>
                You reported 45 minutes — waiting on Jordan to confirm.
              </div>
              <div className="mt-0.5 text-sm" style={{ color: C.warn }}>
                We'll confirm it automatically on Thu 17 Jul if we don't hear back, and your payout
                follows.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function NoShow({ lens }) {
  return (
    <Hero>
      <div className="flex flex-col items-center gap-2 px-5 py-8 text-center">
        <span
          className="flex items-center justify-center rounded-2xl"
          style={{ width: 52, height: 52, background: '#EEF0F3' }}
        >
          <Users size={22} color={C.sub} />
        </span>
        <div className="mt-1 text-base font-semibold" style={{ color: C.text }}>
          Jordan didn't join this session
        </div>
        <div className="max-w-sm text-sm" style={{ color: C.sub }}>
          {lens === 'client'
            ? "This one didn't happen — you weren't charged. The no-show policy applied."
            : 'Logged as a no-show and handled under the no-show policy.'}
        </div>
        <button
          className="mt-3 inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-white"
          style={{ background: C.brand }}
        >
          <Calendar size={15} /> {lens === 'client' ? 'Rebook with Amara' : 'Offer a new time'}
        </button>
        <div className="mt-1 text-xs" style={{ color: C.faint }}>
          Billing follows the no-show policy (being finalised).
        </div>
      </div>
    </Hero>
  );
}

/* ---------- root ---------- */

export default function App() {
  const [lens, setLens] = useState('client');
  const [outcome, setOutcome] = useState('ready');
  const [confirmed, setConfirmed] = useState(false);
  const processing = outcome === 'processing';
  const confirm = outcome === 'confirm';
  const noshow = outcome === 'noshow';

  return (
    <div
      className="flex w-full flex-col items-center gap-4 p-4"
      style={{
        background: C.bg,
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      }}
    >
      <div
        className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl px-3 py-2.5"
        style={{ background: '#0B0E13' }}
      >
        <Ctl label="Lens">
          <Seg
            value={lens}
            onChange={setLens}
            options={[
              { value: 'client', label: 'Client' },
              { value: 'expert', label: 'Expert' },
            ]}
          />
        </Ctl>
        <Ctl label="Outcome">
          <Seg
            value={outcome}
            onChange={(v) => {
              setOutcome(v);
              setConfirmed(false);
            }}
            options={[
              { value: 'processing', label: 'Processing' },
              { value: 'ready', label: 'Ready' },
              { value: 'confirm', label: 'Confirm duration' },
              { value: 'noshow', label: 'No-show' },
            ]}
          />
        </Ctl>
      </div>

      <div className="w-full" style={{ maxWidth: 960 }}>
        <Header outcome={outcome} />
        {!noshow && <Meta lens={lens} outcome={confirm && confirmed ? 'ready' : outcome} />}

        {noshow ? (
          <div className="mt-5">
            <NoShow lens={lens} />
          </div>
        ) : (
          <div className="mt-5 flex flex-col gap-4">
            {confirm && (
              <ConfirmBanner
                lens={lens}
                confirmed={confirmed}
                onConfirm={() => setConfirmed(true)}
              />
            )}
            <div
              className="grid gap-4"
              style={{ gridTemplateColumns: 'minmax(0,2.4fr) minmax(0,1fr)', alignItems: 'start' }}
            >
              <div className="flex flex-col gap-4">
                {confirm && !confirmed ? (
                  <NotCaptured />
                ) : (
                  <>
                    <Summary processing={processing} />
                    <Actions processing={processing} />
                    <TranscriptSection processing={processing} />
                  </>
                )}
              </div>
              <div className="flex flex-col gap-4">
                <PersonCard lens={lens} processing={processing} />
                <Records processing={processing} confirm={confirm && !confirmed} />
              </div>
            </div>
          </div>
        )}
      </div>

      <p className="text-xs" style={{ color: '#8A94A6' }}>
        Prototype · recap (dashboard v2, hierarchy pass) — weighted hero left, quiet rail right,
        light meta line, compact lens-aware party card.
      </p>
    </div>
  );
}

function Ctl({ label, children }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium tracking-wide uppercase" style={{ color: '#5B6472' }}>
        {label}
      </span>
      {children}
    </div>
  );
}
