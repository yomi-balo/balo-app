import { useState, useEffect } from 'react';
import {
  Check,
  Eye,
  RotateCcw,
  MessageSquare,
  Send,
  Plus,
  Lock,
  Calendar,
  FileText,
  DollarSign,
  Clock,
  Layers,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ArrowRight,
  Pencil,
  Trash2,
  Undo2,
  AlertTriangle,
  Sparkles,
  History,
  Info,
} from 'lucide-react';

/*
 * Balo — change orders and scope edits on a live project (ADR-1057; BAL-622, BAL-623)
 * Suggested home: .claude/design-references/project-change-orders.jsx
 * Companion to project-delivery.jsx, which owns milestone progress, review and T&M time.
 *
 * Flows shown here
 *  - Client: "Request a change" (a note) → order `requested`.
 *  - Expert: answers a request with "Propose a change" (the composer) or "Answer without a change
 *    order" (stored as `declined` with the expert's answer; shown to the client as "Answered").
 *  - Composer, amendment mode: pre-filled with the live plan. Each milestone is Unchanged, Edited,
 *    New or Removed. Fixed price edits the project total (stored as an expert-side delta); T&M edits
 *    estimates. "Save draft" → `draft`; "Send to Gemini Corp" → `sent`.
 *  - Client review card: the difference, their own price change, and how it's settled →
 *    "Approve change" (`approved`, applied in one transaction) or "Decline" (reason required).
 *    No auto-approve. The expert can withdraw a sent change.
 *  - One open change at a time. While a change is requested or sent, the project can't be marked
 *    ready, and milestones the sent change touches are locked.
 *  - Scope-edit guards (BAL-623): wording edits apply directly and the client is told; edited
 *    proposal milestones show "Changed since proposal" with before and after. Removing a
 *    contracted milestone on fixed price, adding scope on T&M and changing a T&M estimate go to
 *    "Propose a change" instead.
 *  - Balo admin: both sides of every amount, the margin, the current price and the final-invoice
 *    figure; the stale-change and credit-needed conditions that raise pending-actions items.
 *
 * Amounts: the expert-side figure is stored; the client figure is applyBaloFee(cents, balo_fee_bps).
 * This prototype uses 2500 bps. Fee concealment: experts see expert figures, clients see client
 * figures, only the admin lens shows both.
 */

const FONT =
  'Geist, "Geist Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const TODAY = '25 Oct';
const FEE_BPS = 2500;
const STALE_BUSINESS_DAYS = 5;

let seq = 1000;
const uid = () => `n${seq++}`;
const cx = (...c) => c.filter(Boolean).join(' ');
const clone = (o) => JSON.parse(JSON.stringify(o));
const fmtH = (h) => String(Math.round(h * 100) / 100);
const hrs = (h) => `${fmtH(Math.abs(h))} ${Math.abs(h) === 1 ? 'hr' : 'hrs'}`;
const signedHrs = (h) => (h > 0 ? `+${hrs(h)}` : h < 0 ? `−${hrs(h)}` : 'no change');
const clientCents = (c) => Math.round((c * (10000 + FEE_BPS)) / 10000);
const listify = (arr) =>
  arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`;

function money(cents) {
  const v = Math.abs(cents) / 100;
  const s = v.toLocaleString('en-AU', {
    minimumFractionDigits: Number.isInteger(v) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${cents < 0 ? '−' : ''}A$${s}`;
}
const signedMoney = (c) => (c > 0 ? `+${money(c)}` : c < 0 ? money(c) : 'no change');

const MILESTONE_STATUS = {
  todo: { label: 'To do', chip: 'border-slate-200 bg-slate-50 text-slate-600' },
  in_progress: { label: 'In progress', chip: 'border-blue-200 bg-blue-50 text-blue-700' },
  done: { label: 'Completed', chip: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
};

/* ------------------------------------------------------------------ seed data */

const FIXED_BASE = {
  pricing: 'fixed',
  title: 'National Dental Care — CRM & Marketing Automation Implementation',
  acceptedPriceCents: 1250000, // expert-side accepted proposal price (project_engagements.price_cents)
  priceCents: 1250000, // current = accepted + approved change orders
  upfrontClientCents: 468750, // 30% deposit already invoiced, client-side (upfrontDueCents)
  kickoff: '6 Oct',
  milestones: [
    {
      id: 'm1',
      title: 'Discovery',
      description:
        'Requirements workshops with sales leadership, a current-state process map, and a Sales Cloud solution design.',
      status: 'done',
      origin: 'proposal',
    },
    {
      id: 'm2',
      title: 'Data migration',
      description:
        'Clean up and import 2 years of historical account, contact and opportunity data.',
      status: 'done',
      origin: 'proposal',
    },
    {
      id: 'm3',
      title: 'Implementation',
      description:
        'Configure Sales Cloud, automate lead routing, and build real-time pipeline dashboards for leadership.',
      status: 'in_progress',
      origin: 'proposal',
      // A wording edit made directly (no money moved) → "Changed since proposal".
      edited: {
        at: '14 Oct',
        before: { description: 'Configure Sales Cloud and build pipeline dashboards.' },
      },
    },
    {
      id: 'm4',
      title: 'Handover runbook',
      description: 'A short admin runbook for the Gemini Corp team.',
      status: 'todo',
      origin: 'expert',
    },
  ],
  orders: [],
};

const FIXED_ORDER = {
  id: 'co1',
  requestNote:
    "Can we bring the marketing team in? They'd like their own campaign dashboard and lead-source reporting.",
  requestedAt: '15 Oct',
  summary:
    'Adds a marketing dashboard with lead-source reporting, and routes marketing leads through the new lead routing.',
  priceDeltaCents: 200000,
  lines: [
    {
      op: 'add',
      title: 'Marketing dashboard',
      description: 'Campaign performance and lead-source reporting for the marketing team.',
    },
    {
      op: 'edit',
      milestoneId: 'm3',
      title: 'Implementation',
      description:
        'Configure Sales Cloud, automate lead routing for sales and marketing leads, and build real-time pipeline dashboards for leadership.',
      before: {
        title: 'Implementation',
        description:
          'Configure Sales Cloud, automate lead routing, and build real-time pipeline dashboards for leadership.',
      },
    },
  ],
  sentAt: '16 Oct',
  businessDaysWaiting: 6,
};

const FIXED_CUT_ORDER = {
  id: 'co2',
  requestNote: 'Our own admins will take over the implementation. Can we scale the project back?',
  requestedAt: '20 Oct',
  summary:
    "Gemini Corp's admins will handle implementation. Charles keeps discovery, data migration and the handover runbook.",
  priceDeltaCents: -900000,
  lines: [
    {
      op: 'remove',
      milestoneId: 'm3',
      title: 'Implementation',
      before: {
        title: 'Implementation',
        description:
          'Configure Sales Cloud, automate lead routing, and build real-time pipeline dashboards for leadership.',
      },
    },
  ],
  sentAt: '21 Oct',
  businessDaysWaiting: 0,
};

const TM_BASE = {
  pricing: 'tm',
  title: 'National Dental Care — Patient Recall Journeys',
  acceptedEstimate: 56,
  kickoff: '6 Oct',
  milestones: [
    {
      id: 't1',
      title: 'Journey design',
      description: 'Map the current recall process and design the reminder journeys.',
      status: 'done',
      origin: 'proposal',
      estimate: 12,
      logged: 11.5,
    },
    {
      id: 't2',
      title: 'Data extensions and sync',
      description:
        'Patient and appointment data extensions, synced daily from the practice management system.',
      status: 'in_progress',
      origin: 'proposal',
      estimate: 16,
      logged: 14,
    },
    {
      id: 't3',
      title: 'Recall journeys build',
      description: 'Build and test the three recall journeys, with email steps.',
      status: 'in_progress',
      origin: 'proposal',
      estimate: 20,
      logged: 6,
    },
    {
      id: 't4',
      title: 'UAT and handover',
      description: "Support Gemini Corp's testing, fix issues, and hand over with a short runbook.",
      status: 'todo',
      origin: 'proposal',
      estimate: 8,
      logged: 0,
    },
  ],
  orders: [],
};

const TM_ORDER = {
  id: 'co1',
  requestNote:
    "Could the recall journeys also send SMS reminders to lapsed patients? Email alone isn't reaching them.",
  requestedAt: '15 Oct',
  summary:
    'Adds SMS reminders for lapsed patients, and a second daily sync so appointment changes reach the journeys sooner.',
  lines: [
    {
      op: 'add',
      title: 'SMS reminders for lapsed patients',
      description: 'SMS steps in the lapsed-patient journey, with opt-out handling.',
      estimate: 10,
    },
    {
      op: 'edit',
      milestoneId: 't2',
      title: 'Data extensions and sync',
      description:
        'Patient and appointment data extensions, synced twice daily from the practice management system.',
      estimate: 20,
      before: {
        title: 'Data extensions and sync',
        description:
          'Patient and appointment data extensions, synced daily from the practice management system.',
        estimate: 16,
      },
    },
  ],
  sentAt: '16 Oct',
  businessDaysWaiting: 6,
};

// Approve applies every line in one go — in the real thing, one transaction (BAL-622).
function applyOrder(project, order) {
  let milestones = project.milestones.slice();
  for (const line of order.lines || []) {
    if (line.op === 'add') {
      milestones.push({
        id: uid(),
        title: line.title,
        description: line.description,
        status: 'todo',
        origin: 'change',
        estimate: line.estimate,
        logged: 0,
      });
    } else if (line.op === 'edit') {
      milestones = milestones.map((m) =>
        m.id === line.milestoneId
          ? {
              ...m,
              title: line.title,
              description: line.description,
              estimate: line.estimate ?? m.estimate,
              changedByOrder: true,
            }
          : m
      );
    } else if (line.op === 'remove') {
      milestones = milestones.filter((m) => m.id !== line.milestoneId);
    }
  }
  return {
    ...project,
    milestones,
    priceCents: (project.priceCents || 0) + (order.priceDeltaCents || 0),
  };
}

function buildProject(pricing, scenario) {
  let p = clone(pricing === 'fixed' ? FIXED_BASE : TM_BASE);
  const o = clone(pricing === 'fixed' ? FIXED_ORDER : TM_ORDER);
  if (scenario === 'requested') {
    p.orders = [
      { id: o.id, status: 'requested', requestNote: o.requestNote, requestedAt: o.requestedAt },
    ];
  } else if (scenario === 'sent') {
    p.orders = [{ ...o, status: 'sent' }];
  } else if (scenario === 'approved') {
    const approved = { ...o, status: 'approved', decidedAt: '24 Oct' };
    p = applyOrder(p, approved);
    p.orders = [approved];
  } else if (scenario === 'cut' && pricing === 'fixed') {
    const cut = { ...clone(FIXED_CUT_ORDER), status: 'approved', decidedAt: '24 Oct' };
    p = applyOrder(p, cut);
    p.orders = [cut];
  }
  return p;
}

/* ------------------------------------------------------------------ primitives */

function Btn({ variant = 'outline', size = 'sm', className, children, ...props }) {
  const v = {
    primary: 'border border-indigo-600 bg-indigo-600 text-white hover:bg-indigo-700',
    outline: 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
    ghost: 'border border-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  }[variant];
  const s = size === 'sm' ? 'h-8 gap-1.5 px-3 text-sm' : 'h-10 gap-2 px-4 text-sm';
  return (
    <button
      type="button"
      className={cx(
        'inline-flex items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 disabled:cursor-not-allowed disabled:opacity-40',
        v,
        s,
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

// Flat, shared bounding box — no shadow (the repo's card convention).
function Card({ border = 'border-slate-200', className, style, children }) {
  return (
    <div className={cx('rounded-2xl border bg-white', border, className)} style={style}>
      {children}
    </div>
  );
}

function Pill({ tone = 'slate', icon: Icon, children }) {
  const cls = {
    slate: 'border-slate-200 bg-slate-50 text-slate-600',
    amber: 'border-amber-200 bg-amber-50 text-amber-700',
    violet: 'border-violet-200 bg-violet-50 text-violet-700',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    sky: 'border-sky-200 bg-sky-50 text-sky-700',
    rose: 'border-rose-200 bg-rose-50 text-rose-700',
    blue: 'border-blue-200 bg-blue-50 text-blue-700',
  }[tone];
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
        cls
      )}
    >
      {Icon && <Icon size={12} />}
      {children}
    </span>
  );
}

function Segmented({ value, onChange, options }) {
  return (
    <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cx(
            'rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300',
            value === o.value ? 'bg-slate-900 text-white' : 'text-slate-600 hover:text-slate-900'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Banner({ tone, icon: Icon, children, action }) {
  const box = {
    amber: 'border-amber-200 bg-amber-50 text-amber-900',
    violet: 'border-violet-200 bg-violet-50 text-violet-900',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    slate: 'border-slate-200 bg-slate-50 text-slate-800',
    rose: 'border-rose-200 bg-rose-50 text-rose-900',
  }[tone];
  const ic = {
    amber: 'text-amber-600',
    violet: 'text-violet-600',
    emerald: 'text-emerald-600',
    slate: 'text-slate-500',
    rose: 'text-rose-600',
  }[tone];
  return (
    <div
      className={cx(
        'flex flex-wrap items-start gap-x-3 gap-y-3 rounded-2xl border px-4 py-3.5 text-sm',
        box
      )}
    >
      <Icon size={18} className={cx('mt-0.5 shrink-0', ic)} />
      <div className="min-w-0 flex-1 leading-relaxed">{children}</div>
      {action && <div className="flex shrink-0 flex-wrap gap-2">{action}</div>}
    </div>
  );
}

function MetaChip({ icon: Icon, link, children }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm',
        link
          ? 'cursor-pointer border-indigo-200 bg-indigo-50 font-medium text-indigo-700'
          : 'border-slate-200 text-slate-600'
      )}
    >
      <Icon size={14} />
      {children}
      {link && <ChevronRight size={14} />}
    </span>
  );
}

function StatusDot({ status }) {
  const base = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-full';
  if (status === 'done')
    return (
      <div className={cx(base, 'bg-gradient-to-br from-blue-600 to-violet-600 text-white')}>
        <Check size={15} strokeWidth={3} />
      </div>
    );
  if (status === 'in_progress')
    return (
      <div className={cx(base, 'border-2 border-blue-400 bg-white')}>
        <div className="h-2.5 w-2.5 rounded-full bg-blue-500" />
      </div>
    );
  return <div className={cx(base, 'border-2 border-slate-300 bg-white')} />;
}

const inputCls =
  'w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-indigo-400';

/* ------------------------------------------------------------------ shared change-order pieces */

// How an order reads in each lens.
function orderLabel(order, lens) {
  switch (order.status) {
    case 'requested':
      return { tone: 'amber', label: lens === 'client' ? 'Requested' : 'Request from Gemini Corp' };
    case 'draft':
      return lens === 'client'
        ? { tone: 'amber', label: 'Requested' }
        : { tone: 'slate', label: 'Draft' };
    case 'sent':
      return {
        tone: 'violet',
        label: lens === 'client' ? 'Waiting on you' : 'Waiting on Gemini Corp',
      };
    case 'approved':
      return { tone: 'emerald', label: 'Approved' };
    case 'declined':
      return { tone: 'slate', label: order.answeredByExpert ? 'Answered' : 'Declined' };
    case 'withdrawn':
      return { tone: 'slate', label: 'Withdrawn' };
    default:
      return { tone: 'slate', label: order.status };
  }
}

function estimateDelta(order) {
  return (order.lines || []).reduce((s, l) => {
    if (l.op === 'add') return s + (l.estimate || 0);
    if (l.op === 'remove') return s - (l.before?.estimate || 0);
    if (l.op === 'edit' && l.before && l.estimate != null)
      return s + (l.estimate - (l.before.estimate || 0));
    return s;
  }, 0);
}

function OrderLines({ order, pricing }) {
  const lines = order.lines || [];
  if (lines.length === 0) {
    return <p className="mt-3 text-sm text-slate-500">No change to the milestones.</p>;
  }
  return (
    <ul className="mt-3 space-y-2">
      {lines.map((l, idx) => (
        <li key={idx} className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            {l.op === 'add' && (
              <Pill tone="emerald" icon={Plus}>
                New
              </Pill>
            )}
            {l.op === 'edit' && (
              <Pill tone="sky" icon={Pencil}>
                Edited
              </Pill>
            )}
            {l.op === 'remove' && (
              <Pill tone="rose" icon={Trash2}>
                Removed
              </Pill>
            )}
            <span
              className={cx(
                'font-medium text-slate-900',
                l.op === 'remove' && 'text-slate-500 line-through'
              )}
            >
              {l.title}
            </span>
            {pricing === 'tm' && l.op === 'add' && l.estimate != null && (
              <span className="text-xs text-slate-500">Estimate {hrs(l.estimate)}</span>
            )}
          </div>
          {l.op === 'add' && l.description && (
            <p className="mt-1.5 leading-relaxed text-slate-600">{l.description}</p>
          )}
          {l.op === 'edit' && l.before && (
            <div className="mt-2 space-y-1.5">
              {l.before.title !== l.title && (
                <BeforeAfter label="Name" before={l.before.title} after={l.title} />
              )}
              {l.before.description !== l.description && (
                <BeforeAfter
                  label="Description"
                  before={l.before.description}
                  after={l.description}
                />
              )}
              {pricing === 'tm' && l.before.estimate !== l.estimate && (
                <BeforeAfter
                  label="Estimate"
                  before={hrs(l.before.estimate)}
                  after={hrs(l.estimate)}
                  inline
                />
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function BeforeAfter({ label, before, after, inline }) {
  if (inline) {
    return (
      <p className="flex flex-wrap items-center gap-1.5 text-sm">
        <span className="text-xs font-medium text-slate-500">{label}</span>
        <span className="text-slate-400 line-through">{before}</span>
        <ArrowRight size={12} className="text-slate-400" />
        <span className="font-medium text-slate-800">{after}</span>
      </p>
    );
  }
  return (
    <div className="grid gap-1 text-sm sm:grid-cols-2 sm:gap-3">
      <div>
        <p className="text-xs font-medium text-slate-500">{label} before</p>
        <p className="leading-relaxed text-slate-500 line-through">{before || '—'}</p>
      </div>
      <div>
        <p className="text-xs font-medium text-slate-500">{label} after</p>
        <p className="leading-relaxed text-slate-800">{after || '—'}</p>
      </div>
    </div>
  );
}

// The price or estimate effect of an order, in the viewer's own terms (fee concealment).
function PriceEffect({ order, project, lens, settled }) {
  if (project.pricing === 'tm') {
    const d = estimateDelta(order);
    const current = project.milestones.reduce((s, m) => s + (m.estimate || 0), 0);
    const from = settled ? current - d : current;
    const to = settled ? current : current + d;
    return (
      <div className="mt-4 rounded-xl bg-slate-50 p-3 text-sm">
        <p className="text-slate-700">
          <span className="font-medium">Estimate</span> {hrs(from)} → {hrs(to)}{' '}
          <span className="text-slate-500">({signedHrs(d)})</span>
        </p>
        {lens === 'client' && !settled && (
          <p className="mt-1 text-slate-500">You're billed for the time logged, as now.</p>
        )}
      </div>
    );
  }
  const delta = order.priceDeltaCents || 0;
  const fromExpert = settled ? project.priceCents - delta : project.priceCents;
  const toExpert = fromExpert + delta;
  if (lens === 'admin') {
    return (
      <div className="mt-4 rounded-xl bg-slate-50 p-3 text-sm text-slate-700">
        <p>
          Expert {money(fromExpert)} → {money(toExpert)} ({signedMoney(delta)}) · Client{' '}
          {money(clientCents(fromExpert))} → {money(clientCents(toExpert))} (
          {signedMoney(clientCents(toExpert) - clientCents(fromExpert))}) · Balo margin{' '}
          {signedMoney(clientCents(toExpert) - toExpert - (clientCents(fromExpert) - fromExpert))}
        </p>
      </div>
    );
  }
  const isClient = lens === 'client';
  const from = isClient ? clientCents(fromExpert) : fromExpert;
  const to = isClient ? clientCents(toExpert) : toExpert;
  const d = to - from;
  return (
    <div className="mt-4 rounded-xl bg-slate-50 p-3 text-sm">
      {d === 0 ? (
        <p className="text-slate-700">The price doesn't change.</p>
      ) : (
        <p className="text-slate-700">
          <span className="font-medium">Project price</span> {money(from)} → {money(to)}{' '}
          <span className="text-slate-500">({signedMoney(d)})</span>
        </p>
      )}
      {!settled && d !== 0 && (
        <p className="mt-1 text-slate-500">
          {isClient
            ? d > 0
              ? `If you approve, ${money(d)} is added to your final invoice.`
              : `If you approve, ${money(-d)} comes off your final invoice.`
            : 'If Gemini Corp approves, the difference is settled at the end of the project.'}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ composer (expert) */

function rowsFor(project, order) {
  const pricing = project.pricing;
  const rows = project.milestones.map((m) => ({
    key: m.id,
    milestoneId: m.id,
    status: m.status,
    origin: m.origin,
    title: m.title,
    description: m.description || '',
    estimate: pricing === 'tm' ? String(m.estimate ?? '') : '',
    removed: false,
    isNew: false,
    orig: { title: m.title, description: m.description || '', estimate: m.estimate },
  }));
  for (const l of order?.lines || []) {
    if (l.op === 'add') {
      rows.push({
        key: uid(),
        milestoneId: null,
        status: 'todo',
        origin: 'change',
        title: l.title,
        description: l.description || '',
        estimate: l.estimate != null ? String(l.estimate) : '',
        removed: false,
        isNew: true,
        orig: null,
      });
    } else {
      const r = rows.find((x) => x.milestoneId === l.milestoneId);
      if (!r) continue;
      if (l.op === 'remove') r.removed = true;
      if (l.op === 'edit') {
        r.title = l.title;
        r.description = l.description || '';
        if (pricing === 'tm' && l.estimate != null) r.estimate = String(l.estimate);
      }
    }
  }
  return rows;
}

function linesFrom(rows, pricing) {
  const num = (v) => (v === '' || v == null ? null : Number(v));
  return rows.flatMap((r) => {
    if (r.isNew) {
      if (r.removed) return [];
      return [
        {
          op: 'add',
          title: r.title.trim(),
          description: r.description.trim(),
          estimate: pricing === 'tm' ? num(r.estimate) : undefined,
        },
      ];
    }
    if (r.removed) {
      return [{ op: 'remove', milestoneId: r.milestoneId, title: r.orig.title, before: r.orig }];
    }
    const estimateChanged = pricing === 'tm' && num(r.estimate) !== r.orig.estimate;
    const changed =
      r.title.trim() !== r.orig.title ||
      r.description.trim() !== r.orig.description ||
      estimateChanged;
    if (!changed) return [];
    return [
      {
        op: 'edit',
        milestoneId: r.milestoneId,
        title: r.title.trim(),
        description: r.description.trim(),
        estimate: pricing === 'tm' ? num(r.estimate) : undefined,
        before: r.orig,
      },
    ];
  });
}

function rowState(r, pricing) {
  if (r.isNew) return 'new';
  if (r.removed) return 'removed';
  const changed =
    r.title.trim() !== r.orig.title ||
    r.description.trim() !== r.orig.description ||
    (pricing === 'tm' && Number(r.estimate) !== r.orig.estimate);
  return changed ? 'edited' : 'unchanged';
}

function Composer({ project, context, onCancel, onSave }) {
  const pricing = project.pricing;
  const order = context.orderId ? project.orders.find((o) => o.id === context.orderId) : null;

  const [rows, setRows] = useState(() => {
    const r = rowsFor(project, order?.lines ? order : null);
    if (context.kind === 'remove') {
      const t = r.find((x) => x.milestoneId === context.milestoneId);
      if (t) t.removed = true;
    }
    if (context.kind === 'add') {
      r.push({
        key: uid(),
        milestoneId: null,
        status: 'todo',
        origin: 'change',
        title: '',
        description: '',
        estimate: '',
        removed: false,
        isNew: true,
        orig: null,
      });
    }
    return r;
  });
  const [summary, setSummary] = useState(order?.summary || '');
  const [newTotal, setNewTotal] = useState(() =>
    pricing === 'fixed' ? String((project.priceCents + (order?.priceDeltaCents || 0)) / 100) : ''
  );
  const [attempted, setAttempted] = useState(false);

  const lines = linesFrom(rows, pricing);
  const totalCents = Math.round(parseFloat(newTotal) * 100);
  const priceDelta =
    pricing === 'fixed' && Number.isFinite(totalCents) ? totalCents - project.priceCents : 0;
  const counts = {
    added: lines.filter((l) => l.op === 'add').length,
    edited: lines.filter((l) => l.op === 'edit').length,
    removed: lines.filter((l) => l.op === 'remove').length,
  };
  const currentEstimate = project.milestones.reduce((s, m) => s + (m.estimate || 0), 0);
  const newEstimate =
    pricing === 'tm'
      ? rows.filter((r) => !r.removed).reduce((s, r) => s + (Number(r.estimate) || 0), 0)
      : 0;

  // Mirrors assertChangeOrderCoherent (BAL-622) so the expert sees problems before sending.
  const errors = [];
  if (!summary.trim()) errors.push("Add a short summary of what's changing and why.");
  if (lines.length === 0 && priceDelta === 0)
    errors.push('Change at least one milestone or the price.');
  for (const l of lines) {
    if (l.op === 'add' && !l.title) errors.push('Give each new milestone a name.');
    if (pricing === 'tm' && (l.op === 'add' || l.op === 'edit') && !(l.estimate > 0))
      errors.push(`Add an estimate in hours for ${l.title || 'the new milestone'}.`);
  }
  if (pricing === 'fixed' && (!Number.isFinite(totalCents) || totalCents < 0))
    errors.push('Enter a project price of A$0 or more.');
  const uniqueErrors = [...new Set(errors)];

  const update = (key, patch) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const payload = () => ({
    summary: summary.trim(),
    lines,
    priceDeltaCents: pricing === 'fixed' ? priceDelta : undefined,
  });

  const contextLine =
    context.kind === 'remove'
      ? `You're proposing to remove ${rows.find((r) => r.milestoneId === context.milestoneId)?.orig?.title}. Removing a milestone from the accepted proposal needs Gemini Corp's agreement.`
      : context.kind === 'add' && pricing === 'tm'
        ? "New scope on a time & materials project needs Gemini Corp's agreement, because it adds to what they're billed for."
        : context.kind === 'estimate'
          ? `Change the estimate for ${rows.find((r) => r.milestoneId === context.milestoneId)?.orig?.title} below. A higher estimate needs Gemini Corp's agreement.`
          : null;

  return (
    <div className="space-y-5">
      <div>
        <button
          type="button"
          onClick={onCancel}
          className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"
        >
          <ChevronLeft size={16} />
          Back to project
        </button>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Propose a change</h1>
        <p className="mt-1 text-slate-500">{project.title}</p>
      </div>

      {order?.requestNote && (
        <Banner tone="amber" icon={MessageSquare}>
          <span className="font-semibold">Frank @ Gemini Corp asked on {order.requestedAt}:</span> “
          {order.requestNote}”
        </Banner>
      )}
      {contextLine && (
        <Banner tone="slate" icon={Info}>
          {contextLine}
        </Banner>
      )}

      <div className="flex flex-wrap items-start gap-5">
        <div className="min-w-0 space-y-5" style={{ flex: '1 1 520px' }}>
          <Card className="p-5">
            <label htmlFor="co-summary" className="block text-sm font-medium text-slate-800">
              What's changing and why
            </label>
            <p className="mt-0.5 text-xs text-slate-500">Gemini Corp reads this first.</p>
            <textarea
              id="co-summary"
              rows={3}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="e.g. Adds a marketing dashboard, as Frank asked, and extends lead routing to marketing leads."
              className={cx(inputCls, 'mt-2 py-2')}
            />
          </Card>

          <Card className="p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-slate-800">Milestones</h2>
              <span className="text-xs text-slate-500">
                Edit, add or remove — the difference is what Gemini Corp approves.
              </span>
            </div>
            <div className="space-y-3">
              {rows.map((r) => {
                const state = rowState(r, pricing);
                const tone = {
                  unchanged: 'border-slate-200',
                  edited: 'border-sky-200',
                  new: 'border-emerald-200',
                  removed: 'border-rose-200 bg-rose-50',
                }[state];
                return (
                  <div key={r.key} className={cx('rounded-xl border p-4', tone)}>
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {state === 'unchanged' && <Pill>Unchanged</Pill>}
                        {state === 'edited' && (
                          <Pill tone="sky" icon={Pencil}>
                            Edited
                          </Pill>
                        )}
                        {state === 'new' && (
                          <Pill tone="emerald" icon={Plus}>
                            New
                          </Pill>
                        )}
                        {state === 'removed' && (
                          <Pill tone="rose" icon={Trash2}>
                            Removed
                          </Pill>
                        )}
                        {!r.isNew && (
                          <span
                            className={cx(
                              'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium',
                              MILESTONE_STATUS[r.status].chip
                            )}
                          >
                            {MILESTONE_STATUS[r.status].label}
                          </span>
                        )}
                      </div>
                      {r.isNew ? (
                        <Btn
                          variant="ghost"
                          onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                        >
                          <Trash2 size={14} />
                          Discard
                        </Btn>
                      ) : r.removed ? (
                        <Btn variant="ghost" onClick={() => update(r.key, { removed: false })}>
                          <Undo2 size={14} />
                          Keep it
                        </Btn>
                      ) : (
                        <Btn variant="ghost" onClick={() => update(r.key, { removed: true })}>
                          <Trash2 size={14} />
                          Remove
                        </Btn>
                      )}
                    </div>

                    {r.removed ? (
                      <div>
                        <p className="font-medium text-slate-500 line-through">{r.orig.title}</p>
                        {r.status === 'done' && (
                          <p className="mt-1 text-xs text-rose-700">
                            This milestone is already completed.
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <input
                          value={r.title}
                          onChange={(e) => update(r.key, { title: e.target.value })}
                          placeholder="Milestone name"
                          aria-label="Milestone name"
                          className={cx(inputCls, 'h-9 font-medium')}
                        />
                        <textarea
                          rows={2}
                          value={r.description}
                          onChange={(e) => update(r.key, { description: e.target.value })}
                          placeholder="What's delivered"
                          aria-label="Description"
                          className={cx(inputCls, 'py-2')}
                        />
                        {pricing === 'tm' && (
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              type="number"
                              min="0.5"
                              step="0.5"
                              value={r.estimate}
                              onChange={(e) => update(r.key, { estimate: e.target.value })}
                              aria-label="Estimate in hours"
                              autoFocus={
                                context.kind === 'estimate' && context.milestoneId === r.milestoneId
                              }
                              className="h-9 w-24 rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-indigo-400"
                            />
                            <span className="text-sm text-slate-500">hrs estimated</span>
                            {!r.isNew && Number(r.estimate) !== r.orig.estimate && (
                              <span className="text-xs text-slate-500">
                                was {hrs(r.orig.estimate)}
                              </span>
                            )}
                          </div>
                        )}
                        {state === 'edited' && r.description.trim() !== r.orig.description && (
                          <p className="text-xs leading-relaxed text-slate-500">
                            Was: <span className="line-through">{r.orig.description}</span>
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <Btn
              className="mt-3"
              onClick={() =>
                setRows((rs) => [
                  ...rs,
                  {
                    key: uid(),
                    milestoneId: null,
                    status: 'todo',
                    origin: 'change',
                    title: '',
                    description: '',
                    estimate: '',
                    removed: false,
                    isNew: true,
                    orig: null,
                  },
                ])
              }
            >
              <Plus size={14} />
              Add a milestone
            </Btn>
          </Card>
        </div>

        <Card
          className="p-5"
          style={{ flex: '1 1 280px', maxWidth: 360, position: 'sticky', top: 24 }}
        >
          <h2 className="text-sm font-semibold text-slate-800">The change</h2>
          <ul className="mt-3 space-y-1.5 text-sm text-slate-600">
            <li>{counts.added} added</li>
            <li>{counts.edited} edited</li>
            <li>{counts.removed} removed</li>
          </ul>

          {pricing === 'fixed' ? (
            <div className="mt-4 border-t border-slate-100 pt-4">
              <label htmlFor="co-price" className="block text-sm font-medium text-slate-800">
                Project price
              </label>
              <div className="mt-1.5 flex items-center gap-2">
                <span className="text-sm text-slate-500">A$</span>
                <input
                  id="co-price"
                  type="number"
                  min="0"
                  step="50"
                  value={newTotal}
                  onChange={(e) => setNewTotal(e.target.value)}
                  className={cx(inputCls, 'h-9')}
                />
              </div>
              <p className="mt-1.5 text-xs text-slate-500">
                Currently {money(project.priceCents)}.{' '}
                {Number.isFinite(totalCents) && priceDelta !== 0
                  ? `That's ${signedMoney(priceDelta)}.`
                  : 'Leave it to keep the price.'}
              </p>
            </div>
          ) : (
            <div className="mt-4 border-t border-slate-100 pt-4 text-sm">
              <p className="font-medium text-slate-800">Estimate</p>
              <p className="mt-1 text-slate-600">
                {hrs(currentEstimate)} → {hrs(newEstimate)}{' '}
                <span className="text-slate-500">({signedHrs(newEstimate - currentEstimate)})</span>
              </p>
            </div>
          )}

          {attempted && uniqueErrors.length > 0 && (
            <ul className="mt-4 space-y-1 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
              {uniqueErrors.map((e) => (
                <li key={e} className="flex items-start gap-1.5">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  {e}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 flex flex-col gap-2">
            <Btn
              variant="primary"
              size="md"
              onClick={() => {
                setAttempted(true);
                if (uniqueErrors.length === 0) onSave(payload(), true);
              }}
            >
              <Send size={16} />
              Send to Gemini Corp
            </Btn>
            <Btn size="md" onClick={() => onSave(payload(), false)}>
              Save draft
            </Btn>
            <Btn variant="ghost" size="md" onClick={onCancel}>
              Cancel
            </Btn>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            Nothing changes until Gemini Corp approves. While it's waiting, the project can't be
            marked ready.
          </p>
        </Card>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ admin money panel */

function AdminPanel({ project }) {
  const approved = project.orders.filter((o) => o.status === 'approved');
  const sent = project.orders.find((o) => o.status === 'sent');

  if (project.pricing === 'tm') {
    const current = project.milestones.reduce((s, m) => s + (m.estimate || 0), 0);
    const logged = project.milestones.reduce((s, m) => s + (m.logged || 0), 0);
    return (
      <Card border="border-slate-300" className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-800">Hours and changes</h2>
          <Pill icon={Lock}>Balo staff only</Pill>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <tbody className="divide-y divide-slate-100">
              <tr>
                <td className="py-2 text-slate-600">Accepted estimate</td>
                <td className="py-2 text-right font-medium text-slate-800">
                  {hrs(project.acceptedEstimate)}
                </td>
              </tr>
              {approved.map((o) => (
                <tr key={o.id}>
                  <td className="py-2 text-slate-600">Change approved {o.decidedAt}</td>
                  <td className="py-2 text-right text-slate-800">{signedHrs(estimateDelta(o))}</td>
                </tr>
              ))}
              <tr>
                <td className="py-2 font-medium text-slate-800">Current estimate</td>
                <td className="py-2 text-right font-semibold text-slate-900">{hrs(current)}</td>
              </tr>
              <tr>
                <td className="py-2 text-slate-600">Logged so far</td>
                <td className="py-2 text-right text-slate-800">{hrs(logged)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {sent && (
          <p className="mt-3 text-xs text-slate-500">
            Waiting on Gemini Corp: {signedHrs(estimateDelta(sent))} (not in the totals yet).
          </p>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Billed each period from logged time. Change orders move the estimate, not the invoice.
        </p>
      </Card>
    );
  }

  const acc = project.acceptedPriceCents;
  const cur = project.priceCents;
  const finalInvoice = clientCents(cur) - project.upfrontClientCents;
  const Row = ({ label, expert, strong }) => {
    const client = clientCents(expert);
    return (
      <tr>
        <td className={cx('py-2 pr-3', strong ? 'font-medium text-slate-800' : 'text-slate-600')}>
          {label}
        </td>
        <td className="py-2 pr-3 text-right text-slate-800">{money(expert)}</td>
        <td className="py-2 pr-3 text-right text-slate-800">{money(client)}</td>
        <td className="py-2 text-right text-slate-500">{money(client - expert)}</td>
      </tr>
    );
  };
  return (
    <Card border="border-slate-300" className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-800">Price and final invoice</h2>
        <Pill icon={Lock}>Balo staff only</Pill>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm" style={{ minWidth: 520 }}>
          <thead>
            <tr className="text-xs text-slate-500">
              <th className="pr-3 pb-2 font-medium" />
              <th className="pr-3 pb-2 text-right font-medium">Expert</th>
              <th className="pr-3 pb-2 text-right font-medium">Client</th>
              <th className="pb-2 text-right font-medium">Balo margin</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            <Row label="Accepted price" expert={acc} />
            {approved.map((o) => {
              const d = o.priceDeltaCents || 0;
              const dc = clientCents(acc + d) - clientCents(acc);
              return (
                <tr key={o.id}>
                  <td className="py-2 pr-3 text-slate-600">Change approved {o.decidedAt}</td>
                  <td className="py-2 pr-3 text-right text-slate-800">{signedMoney(d)}</td>
                  <td className="py-2 pr-3 text-right text-slate-800">{signedMoney(dc)}</td>
                  <td className="py-2 text-right text-slate-500">{signedMoney(dc - d)}</td>
                </tr>
              );
            })}
            <Row label="Current price" expert={cur} strong />
            <tr>
              <td className="py-2 pr-3 text-slate-600">Already invoiced upfront</td>
              <td className="py-2 pr-3 text-right text-slate-400">—</td>
              <td className="py-2 pr-3 text-right text-slate-800">
                {money(-project.upfrontClientCents)}
              </td>
              <td className="py-2 text-right text-slate-400">—</td>
            </tr>
            <tr>
              <td className="py-2 pr-3 font-medium text-slate-800">Final invoice</td>
              <td className="py-2 pr-3 text-right text-slate-400">—</td>
              <td
                className={cx(
                  'py-2 pr-3 text-right font-semibold',
                  finalInvoice < 0 ? 'text-rose-700' : 'text-slate-900'
                )}
              >
                {money(finalInvoice)}
              </td>
              <td className="py-2 text-right text-slate-400">—</td>
            </tr>
          </tbody>
        </table>
      </div>
      {sent && (
        <p className="mt-3 text-xs text-slate-500">
          Waiting on Gemini Corp: {signedMoney(sent.priceDeltaCents || 0)} expert,{' '}
          {signedMoney(clientCents(cur + (sent.priceDeltaCents || 0)) - clientCents(cur))} client
          (not in the totals yet).
        </p>
      )}
      {finalInvoice < 0 && (
        <div className="mt-3">
          <Banner tone="rose" icon={AlertTriangle}>
            <span className="font-semibold">Credit needed: {money(-finalInvoice)}.</span> The
            approved change took the price below what Gemini Corp has already been invoiced. Issue
            an adjustment note, then close the item in the pending-actions queue.
          </Banner>
        </div>
      )}
      <p className="mt-3 text-xs text-slate-500">
        Under v1 manual invoicing, the final invoice figure is what goes into Xero when the project
        is accepted.
      </p>
    </Card>
  );
}

/* ------------------------------------------------------------------ delivery page */

function ProjectPage({ lens, project, setProject }) {
  const pricing = project.pricing;
  const isExpert = lens === 'expert';
  const isClient = lens === 'client';
  const isAdmin = lens === 'admin';

  const [composer, setComposer] = useState(null);
  const [guard, setGuard] = useState(null);
  const [editing, setEditing] = useState(null);
  const [editDraft, setEditDraft] = useState({ title: '', description: '' });
  const [notice, setNotice] = useState(null);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [requestText, setRequestText] = useState('');
  const [answering, setAnswering] = useState(false);
  const [answerText, setAnswerText] = useState('');
  const [declining, setDeclining] = useState(false);
  const [declineText, setDeclineText] = useState('');
  const [openBefore, setOpenBefore] = useState({});
  const [openHistory, setOpenHistory] = useState({});

  const orders = project.orders;
  const latest = orders[orders.length - 1];
  const request = orders.find((o) => o.status === 'requested');
  const draft = orders.find((o) => o.status === 'draft');
  const sent = orders.find((o) => o.status === 'sent');
  const openOrder = request || draft || sent;
  const lockedIds = new Set(
    (sent?.lines || []).filter((l) => l.milestoneId).map((l) => l.milestoneId)
  );
  const doneCount = project.milestones.filter((m) => m.status === 'done').length;
  const total = project.milestones.length;
  const estimateTotal = project.milestones.reduce((s, m) => s + (m.estimate || 0), 0);

  const setOrders = (fn) => setProject((p) => ({ ...p, orders: fn(p.orders) }));
  const patchOrder = (id, patch) =>
    setOrders((os) => os.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  const flash = (msg) => setNotice(msg);

  // ── actions ──
  const requestChange = () => {
    const note = requestText.trim();
    if (!note) return;
    setOrders((os) => [
      ...os,
      { id: uid(), status: 'requested', requestNote: note, requestedAt: TODAY },
    ]);
    setRequesting(false);
    setRequestText('');
  };
  const answerRequest = () => {
    const a = answerText.trim();
    if (!a || !request) return;
    patchOrder(request.id, {
      status: 'declined',
      answeredByExpert: true,
      answer: a,
      decidedAt: TODAY,
    });
    setAnswering(false);
    setAnswerText('');
  };
  const saveOrder = (payload, send) => {
    const status = send ? 'sent' : 'draft';
    const extra = send ? { sentAt: TODAY, businessDaysWaiting: 0 } : {};
    if (composer.orderId) {
      patchOrder(composer.orderId, { ...payload, status, ...extra });
    } else {
      setOrders((os) => [...os, { id: uid(), ...payload, status, ...extra }]);
    }
    setComposer(null);
    setGuard(null);
    flash(send ? 'Sent to Gemini Corp. Nothing changes until they approve.' : 'Draft saved.');
  };
  const discardDraft = () => {
    if (!draft) return;
    if (draft.requestNote) {
      patchOrder(draft.id, {
        status: 'requested',
        summary: undefined,
        lines: undefined,
        priceDeltaCents: undefined,
      });
    } else {
      setOrders((os) => os.filter((o) => o.id !== draft.id));
    }
  };
  const withdraw = () => sent && patchOrder(sent.id, { status: 'withdrawn', decidedAt: TODAY });
  const approve = () => {
    if (!sent) return;
    setProject((p) => {
      const approved = { ...sent, status: 'approved', decidedAt: TODAY };
      const applied = applyOrder(p, approved);
      return { ...applied, orders: p.orders.map((o) => (o.id === sent.id ? approved : o)) };
    });
  };
  const decline = () => {
    const reason = declineText.trim();
    if (!reason || !sent) return;
    patchOrder(sent.id, { status: 'declined', declineReason: reason, decidedAt: TODAY });
    setDeclining(false);
    setDeclineText('');
  };
  const saveWording = (m) => {
    const title = editDraft.title.trim();
    const description = editDraft.description.trim();
    if (!title) return;
    setProject((p) => ({
      ...p,
      milestones: p.milestones.map((x) =>
        x.id === m.id
          ? {
              ...x,
              title,
              description,
              edited:
                x.origin === 'proposal'
                  ? {
                      at: TODAY,
                      before: x.edited?.before || { title: x.title, description: x.description },
                    }
                  : x.edited,
            }
          : x
      ),
    }));
    setEditing(null);
    flash('Saved. Gemini Corp will be told about this edit.');
  };
  const removeDirect = (m) => {
    setProject((p) => ({ ...p, milestones: p.milestones.filter((x) => x.id !== m.id) }));
    flash(`${m.title} removed. Gemini Corp will be told.`);
  };
  const addDirect = () => {
    const title = newTitle.trim();
    if (!title) return;
    setProject((p) => ({
      ...p,
      milestones: [
        ...p.milestones,
        { id: uid(), title, description: '', status: 'todo', origin: 'expert' },
      ],
    }));
    setNewTitle('');
    setAdding(false);
    flash(`${title} added. Gemini Corp will be told.`);
  };
  const openComposer = (ctx) => {
    if (draft) setComposer({ kind: 'draft', orderId: draft.id });
    else if (request) setComposer({ ...ctx, orderId: request.id });
    else setComposer(ctx);
  };

  if (composer && isExpert) {
    return (
      <Composer
        project={project}
        context={composer}
        onCancel={() => setComposer(null)}
        onSave={saveOrder}
      />
    );
  }

  // ── header ──
  const priceChip =
    pricing === 'fixed' ? (
      <MetaChip icon={DollarSign}>
        {isAdmin
          ? `Fixed price · ${money(clientCents(project.priceCents))} client · ${money(project.priceCents)} expert`
          : `Fixed price · ${money(isClient ? clientCents(project.priceCents) : project.priceCents)}`}
      </MetaChip>
    ) : (
      <>
        <MetaChip icon={Clock}>Time & materials</MetaChip>
        <MetaChip icon={Layers}>Estimate {hrs(estimateTotal)}</MetaChip>
      </>
    );

  const canProposeNew = !sent;
  const readyReason =
    request || (draft && draft.requestNote)
      ? "Answer Gemini Corp's change request first. The project can't be marked ready while it's open."
      : sent
        ? "A change is waiting on Gemini Corp. You can mark the project ready once it's decided."
        : doneCount < total
          ? `${total - doneCount} ${total - doneCount === 1 ? 'milestone' : 'milestones'} still to complete.`
          : "Everything's complete.";
  const canMarkReady = !request && !sent && !(draft && draft.requestNote) && doneCount === total;

  return (
    <div className="space-y-5">
      <div>
        <button
          type="button"
          className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"
        >
          <ChevronLeft size={16} />
          Projects
        </button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
              {project.title}
            </h1>
            <p className="mt-1 text-slate-500">
              {isClient ? 'With Charles' : isAdmin ? 'Gemini Corp with Charles' : 'For Gemini Corp'}
            </p>
          </div>
          <Pill tone="emerald" icon={Layers}>
            Active
          </Pill>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {priceChip}
          <MetaChip icon={Calendar}>Kicked off {project.kickoff}</MetaChip>
          <MetaChip icon={FileText} link>
            View request
          </MetaChip>
        </div>
      </div>

      {isAdmin && <AdminPanel project={project} />}

      {notice && (
        <Banner
          tone="slate"
          icon={Check}
          action={
            <Btn variant="ghost" onClick={() => setNotice(null)}>
              Dismiss
            </Btn>
          }
        >
          {notice}
        </Banner>
      )}

      {/* ── expert states ── */}
      {isExpert && request && (
        <Card border="border-amber-200" className="p-5">
          <div className="flex items-start gap-3">
            <div className="rounded-full bg-amber-50 p-2 text-amber-600">
              <MessageSquare size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold text-slate-900">
                Frank @ Gemini Corp asked for a change on {request.requestedAt}
              </h3>
              <p className="mt-1 leading-relaxed text-slate-700">“{request.requestNote}”</p>
              {!answering ? (
                <>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Btn
                      variant="primary"
                      size="md"
                      onClick={() => openComposer({ kind: 'request' })}
                    >
                      <Pencil size={16} />
                      Propose a change
                    </Btn>
                    <Btn size="md" onClick={() => setAnswering(true)}>
                      Answer without a change order
                    </Btn>
                  </div>
                  <p className="mt-2 text-xs text-slate-500">
                    Propose a change if this affects scope or price. If it doesn't — say you've just
                    reworded something — answer here.
                  </p>
                </>
              ) : (
                <div className="mt-4 space-y-2">
                  <textarea
                    autoFocus
                    rows={3}
                    value={answerText}
                    onChange={(e) => setAnswerText(e.target.value)}
                    placeholder="e.g. That's already covered by Implementation — I've updated its description to say so."
                    className={cx(inputCls, 'py-2')}
                  />
                  <div className="flex gap-2">
                    <Btn variant="primary" disabled={!answerText.trim()} onClick={answerRequest}>
                      Send answer
                    </Btn>
                    <Btn variant="ghost" onClick={() => setAnswering(false)}>
                      Cancel
                    </Btn>
                  </div>
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      {isExpert && draft && (
        <Banner
          tone="slate"
          icon={Pencil}
          action={
            <>
              <Btn
                variant="primary"
                onClick={() => setComposer({ kind: 'draft', orderId: draft.id })}
              >
                Continue editing
              </Btn>
              <Btn variant="ghost" onClick={discardDraft}>
                Discard
              </Btn>
            </>
          }
        >
          <span className="font-semibold">You have a draft change that hasn't been sent.</span>{' '}
          {draft.requestNote ? 'Gemini Corp is still waiting for your answer.' : ''}
        </Banner>
      )}

      {isExpert && sent && (
        <Banner
          tone="violet"
          icon={Send}
          action={
            <Btn variant="ghost" onClick={withdraw}>
              Withdraw
            </Btn>
          }
        >
          <span className="font-semibold">Change sent to Gemini Corp on {sent.sentAt}.</span>{' '}
          Nothing changes until they approve. The milestones it touches are locked until then.
        </Banner>
      )}

      {isExpert && latest?.status === 'declined' && !latest.answeredByExpert && !openOrder && (
        <Banner
          tone="amber"
          icon={MessageSquare}
          action={
            <Btn variant="primary" onClick={() => openComposer({ kind: 'fresh' })}>
              Propose a different change
            </Btn>
          }
        >
          <span className="font-semibold">Frank @ Gemini Corp declined the change</span> on{' '}
          {latest.decidedAt}: “{latest.declineReason}”
        </Banner>
      )}

      {isExpert && latest?.status === 'approved' && !openOrder && (
        <Banner tone="emerald" icon={Sparkles}>
          <span className="font-semibold">
            Gemini Corp approved the change on {latest.decidedAt}.
          </span>{' '}
          The plan{pricing === 'fixed' ? ' and price are' : ' and estimate are'} updated.
        </Banner>
      )}

      {/* ── client states ── */}
      {isClient && sent && (
        <Card border="border-violet-200" className="p-6">
          <div className="flex items-start gap-3">
            <div className="rounded-full bg-violet-50 p-2 text-violet-600">
              <Eye size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold text-slate-900">Charles proposed a change</h3>
              <p className="mt-1 text-sm text-slate-500">
                Sent {sent.sentAt}. Nothing changes unless you approve it.
              </p>
              {sent.requestNote && (
                <p className="mt-3 text-sm text-slate-500">You asked: “{sent.requestNote}”</p>
              )}
              <p className="mt-3 leading-relaxed text-slate-800">{sent.summary}</p>
              <OrderLines order={sent} pricing={pricing} />
              <PriceEffect order={sent} project={project} lens="client" />
              {!declining ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  <Btn variant="primary" size="md" onClick={approve}>
                    <Check size={16} />
                    Approve change
                  </Btn>
                  <Btn size="md" onClick={() => setDeclining(true)}>
                    Decline
                  </Btn>
                </div>
              ) : (
                <div className="mt-4 space-y-2">
                  <label
                    htmlFor="decline-reason"
                    className="block text-sm font-medium text-slate-700"
                  >
                    Why are you declining?
                  </label>
                  <textarea
                    id="decline-reason"
                    autoFocus
                    rows={3}
                    value={declineText}
                    onChange={(e) => setDeclineText(e.target.value)}
                    placeholder="Charles sees this and can suggest something else."
                    className={cx(inputCls, 'py-2')}
                  />
                  <div className="flex gap-2">
                    <Btn variant="primary" disabled={!declineText.trim()} onClick={decline}>
                      Decline change
                    </Btn>
                    <Btn variant="ghost" onClick={() => setDeclining(false)}>
                      Cancel
                    </Btn>
                  </div>
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      {isClient && (request || draft?.requestNote) && (
        <Banner tone="slate" icon={MessageSquare}>
          You asked for a change on {(request || draft).requestedAt}. Charles will reply with a
          proposed change or an answer.
        </Banner>
      )}

      {isClient && latest?.status === 'declined' && latest.answeredByExpert && !openOrder && (
        <Banner tone="slate" icon={MessageSquare}>
          <span className="font-semibold">Charles answered your request:</span> “{latest.answer}”
        </Banner>
      )}
      {isClient && latest?.status === 'approved' && !openOrder && (
        <Banner tone="emerald" icon={Check}>
          <span className="font-semibold">You approved the change on {latest.decidedAt}.</span> The
          plan
          {pricing === 'fixed' ? ' and price are' : ' and estimate are'} updated.
        </Banner>
      )}
      {isClient && latest?.status === 'withdrawn' && !openOrder && (
        <Banner tone="slate" icon={Info}>
          Charles withdrew the proposed change. Nothing changed.
        </Banner>
      )}

      {/* ── admin state line ── */}
      {isAdmin && openOrder && (
        <Banner
          tone={sent && sent.businessDaysWaiting > STALE_BUSINESS_DAYS ? 'amber' : 'slate'}
          icon={sent ? Clock : MessageSquare}
        >
          {sent ? (
            <>
              <span className="font-semibold">Waiting on Gemini Corp since {sent.sentAt}</span> (
              {sent.businessDaysWaiting} business days).
              {sent.businessDaysWaiting > STALE_BUSINESS_DAYS &&
                " It's in the pending-actions queue."}
            </>
          ) : draft ? (
            'Charles is drafting a change.'
          ) : (
            'Gemini Corp asked for a change. Waiting on Charles.'
          )}
        </Banner>
      )}

      {/* ── progress ── */}
      <Card className="p-6">
        <p className="text-slate-500">
          <span className="mr-2 text-3xl font-semibold tracking-tight text-slate-900">
            {doneCount} of {total}
          </span>
          milestones completed
        </p>
        <div className="mt-5 flex gap-1.5">
          {project.milestones.map((m) => (
            <div
              key={m.id}
              className={cx(
                'h-2 flex-1 rounded-full',
                lockedIds.has(m.id)
                  ? 'bg-violet-300'
                  : m.status === 'done'
                    ? 'bg-gradient-to-r from-blue-600 to-violet-600'
                    : m.status === 'in_progress'
                      ? 'bg-blue-400'
                      : 'bg-slate-200'
              )}
            />
          ))}
        </div>
        {isExpert && (
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-5">
            <p className="text-sm text-slate-500">{readyReason}</p>
            <Btn
              variant="primary"
              size="md"
              disabled={!canMarkReady}
              onClick={() =>
                flash(
                  'In the full flow this tells Gemini Corp the project is ready (see project-delivery.jsx).'
                )
              }
            >
              <Send size={16} />
              Mark project ready
            </Btn>
          </div>
        )}
      </Card>

      {/* ── milestones ── */}
      <Card className="p-6">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">
            Delivery plan
          </h2>
          {isExpert && (
            <div className="flex flex-wrap gap-1">
              {pricing === 'fixed' && (
                <Btn variant="ghost" onClick={() => setAdding(true)}>
                  <Plus size={16} />
                  Add milestone
                </Btn>
              )}
              <Btn
                variant="ghost"
                disabled={!canProposeNew}
                title={canProposeNew ? undefined : 'A change is already waiting on Gemini Corp'}
                onClick={() => openComposer(pricing === 'tm' ? { kind: 'add' } : { kind: 'fresh' })}
              >
                <Pencil size={16} />
                {draft ? 'Continue draft change' : 'Propose a change'}
              </Btn>
            </div>
          )}
        </div>

        <div>
          {project.milestones.map((m, idx) => {
            const last = idx === project.milestones.length - 1 && !adding;
            const locked = lockedIds.has(m.id);
            const contracted = m.origin === 'proposal';
            return (
              <div key={m.id} className="flex gap-4">
                <div className="flex flex-col items-center">
                  <StatusDot status={m.status} />
                  {!last && <div className="my-1 w-0.5 flex-1 rounded-full bg-slate-200" />}
                </div>
                <div className={cx('min-w-0 flex-1', last ? 'pb-2' : 'pb-8')}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="leading-7 font-semibold text-slate-900">{m.title}</h3>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {m.edited && (
                        <button
                          type="button"
                          onClick={() => setOpenBefore((o) => ({ ...o, [m.id]: !o[m.id] }))}
                          className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
                          aria-expanded={Boolean(openBefore[m.id])}
                        >
                          <Pill tone="sky" icon={History}>
                            Changed since proposal
                          </Pill>
                        </button>
                      )}
                      {m.changedByOrder && <Pill tone="emerald">Updated by approved change</Pill>}
                      {m.origin === 'change' && (
                        <Pill tone="emerald">Added by approved change</Pill>
                      )}
                      {locked && (
                        <Pill tone="violet" icon={Lock}>
                          Change pending
                        </Pill>
                      )}
                      <span
                        className={cx(
                          'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium',
                          MILESTONE_STATUS[m.status].chip
                        )}
                      >
                        {MILESTONE_STATUS[m.status].label}
                      </span>
                    </div>
                  </div>

                  {editing === m.id ? (
                    <div className="mt-2 space-y-2">
                      <input
                        autoFocus
                        value={editDraft.title}
                        onChange={(e) => setEditDraft((d) => ({ ...d, title: e.target.value }))}
                        aria-label="Milestone name"
                        className={cx(inputCls, 'h-9 font-medium')}
                      />
                      <textarea
                        rows={3}
                        value={editDraft.description}
                        onChange={(e) =>
                          setEditDraft((d) => ({ ...d, description: e.target.value }))
                        }
                        aria-label="Description"
                        className={cx(inputCls, 'py-2')}
                      />
                      <p className="text-xs text-slate-500">
                        Wording only. Gemini Corp is told about the edit
                        {contracted ? ' and sees what it said before.' : '.'} Changes to scope or
                        price go through Propose a change.
                      </p>
                      <div className="flex gap-2">
                        <Btn
                          variant="primary"
                          disabled={!editDraft.title.trim()}
                          onClick={() => saveWording(m)}
                        >
                          Save wording
                        </Btn>
                        <Btn variant="ghost" onClick={() => setEditing(null)}>
                          Cancel
                        </Btn>
                      </div>
                    </div>
                  ) : (
                    m.description && (
                      <p className="mt-2 leading-relaxed text-slate-600">{m.description}</p>
                    )
                  )}

                  {pricing === 'tm' && (
                    <p className="mt-2 text-sm text-slate-500">
                      {fmtH(m.logged || 0)} of {hrs(m.estimate || 0)} logged
                    </p>
                  )}

                  {m.edited && openBefore[m.id] && (
                    <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 p-3">
                      <p className="mb-2 text-xs font-medium text-sky-800">Edited {m.edited.at}</p>
                      {m.edited.before.title && m.edited.before.title !== m.title && (
                        <BeforeAfter label="Name" before={m.edited.before.title} after={m.title} />
                      )}
                      {m.edited.before.description !== undefined &&
                        m.edited.before.description !== m.description && (
                          <BeforeAfter
                            label="Description"
                            before={m.edited.before.description}
                            after={m.description}
                          />
                        )}
                    </div>
                  )}

                  {guard?.milestoneId === m.id && (
                    <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                      <p className="flex items-start gap-2">
                        <Lock size={14} className="mt-0.5 shrink-0" />
                        {guard.kind === 'remove'
                          ? `${m.title} is part of the accepted proposal, so removing it needs Gemini Corp's agreement.`
                          : "Changing an estimate needs Gemini Corp's agreement, because it changes what they're billed for."}
                      </p>
                      <div className="mt-2 flex gap-2">
                        <Btn
                          variant="primary"
                          disabled={!canProposeNew}
                          onClick={() => openComposer({ kind: guard.kind, milestoneId: m.id })}
                        >
                          Propose a change
                        </Btn>
                        <Btn variant="ghost" onClick={() => setGuard(null)}>
                          Cancel
                        </Btn>
                      </div>
                    </div>
                  )}

                  {isExpert && editing !== m.id && guard?.milestoneId !== m.id && (
                    <div className="mt-3 flex flex-wrap items-center gap-1">
                      {locked ? (
                        <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                          <Lock size={12} />
                          Locked while Gemini Corp reviews a change to it
                        </span>
                      ) : (
                        <>
                          <Btn
                            variant="ghost"
                            onClick={() => {
                              setEditing(m.id);
                              setEditDraft({ title: m.title, description: m.description || '' });
                            }}
                          >
                            <Pencil size={14} />
                            Edit wording
                          </Btn>
                          {pricing === 'tm' && (
                            <Btn
                              variant="ghost"
                              onClick={() => setGuard({ milestoneId: m.id, kind: 'estimate' })}
                            >
                              <Clock size={14} />
                              Change estimate
                            </Btn>
                          )}
                          <Btn
                            variant="ghost"
                            onClick={() =>
                              pricing === 'fixed' && contracted
                                ? setGuard({ milestoneId: m.id, kind: 'remove' })
                                : removeDirect(m)
                            }
                          >
                            <Trash2 size={14} />
                            Remove
                          </Btn>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {adding && (
            <div className="flex gap-4">
              <div className="h-7 w-7 shrink-0 rounded-full border-2 border-dashed border-slate-300" />
              <div className="flex min-w-0 flex-1 flex-wrap gap-2 pb-2">
                <input
                  autoFocus
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addDirect();
                    if (e.key === 'Escape') setAdding(false);
                  }}
                  placeholder="Milestone name"
                  className="h-8 min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-indigo-400"
                />
                <Btn variant="primary" disabled={!newTitle.trim()} onClick={addDirect}>
                  Add
                </Btn>
                <Btn variant="ghost" onClick={() => setAdding(false)}>
                  Cancel
                </Btn>
              </div>
            </div>
          )}
        </div>

        {isExpert && pricing === 'fixed' && adding && (
          <p className="mt-3 text-xs text-slate-500">
            An added milestone doesn't change the price. To charge for new work, propose a change
            instead.
          </p>
        )}
      </Card>

      {/* ── client: request a change ── */}
      {isClient && (
        <Card className="p-5">
          {openOrder ? (
            <p className="text-sm text-slate-500">
              You have a change in progress. You can request another once it's decided.
            </p>
          ) : !requesting ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-slate-700">Need something different from the plan?</p>
              <Btn onClick={() => setRequesting(true)}>
                <MessageSquare size={14} />
                Request a change
              </Btn>
            </div>
          ) : (
            <div className="space-y-2">
              <label htmlFor="request-note" className="block text-sm font-medium text-slate-800">
                What would you like to change?
              </label>
              <textarea
                id="request-note"
                autoFocus
                rows={3}
                value={requestText}
                onChange={(e) => setRequestText(e.target.value)}
                className={cx(inputCls, 'py-2')}
              />
              <p className="text-xs text-slate-500">
                Charles replies with a proposed change, including any change to the{' '}
                {pricing === 'fixed' ? 'price' : 'estimate'}, or an answer. Nothing changes until
                you approve.
              </p>
              <div className="flex gap-2">
                <Btn variant="primary" disabled={!requestText.trim()} onClick={requestChange}>
                  Send request
                </Btn>
                <Btn variant="ghost" onClick={() => setRequesting(false)}>
                  Cancel
                </Btn>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* ── history ── */}
      {orders.filter((o) => !(isClient && o.status === 'draft' && !o.requestNote)).length > 0 && (
        <Card className="p-6">
          <h2 className="text-sm font-semibold text-slate-800">Changes to this project</h2>
          <ul className="mt-4 divide-y divide-slate-100">
            {orders
              .filter((o) => !(isClient && o.status === 'draft' && !o.requestNote))
              .slice()
              .reverse()
              .map((o) => {
                const l = orderLabel(o, lens);
                const open = Boolean(openHistory[o.id]);
                const hasDetail = (o.lines && o.lines.length > 0) || o.declineReason || o.answer;
                const showDetail = !(isClient && o.status === 'draft');
                const dates = [
                  o.requestedAt && `Requested ${o.requestedAt}`,
                  o.sentAt && `Sent ${o.sentAt}`,
                  o.decidedAt && `${l.label} ${o.decidedAt}`,
                ]
                  .filter(Boolean)
                  .join(' · ');
                return (
                  <li key={o.id} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Pill tone={l.tone}>{l.label}</Pill>
                          {showDetail && o.lines && pricing === 'fixed' && (
                            <span className="text-sm text-slate-600">
                              {(() => {
                                const d = o.priceDeltaCents || 0;
                                if (isAdmin) return `${signedMoney(d)} expert`;
                                if (isClient)
                                  return signedMoney(
                                    clientCents(project.acceptedPriceCents + d) -
                                      clientCents(project.acceptedPriceCents)
                                  );
                                return signedMoney(d);
                              })()}
                            </span>
                          )}
                          {showDetail && o.lines && pricing === 'tm' && (
                            <span className="text-sm text-slate-600">
                              {signedHrs(estimateDelta(o))}
                            </span>
                          )}
                        </div>
                        <p className="mt-1.5 text-sm leading-relaxed text-slate-700">
                          {showDetail && o.summary
                            ? o.summary
                            : o.requestNote
                              ? `“${o.requestNote}”`
                              : 'Draft change, not sent yet'}
                        </p>
                        <p className="mt-1 text-xs text-slate-400">{dates}</p>
                      </div>
                      {showDetail && hasDetail && (
                        <Btn
                          variant="ghost"
                          onClick={() => setOpenHistory((h) => ({ ...h, [o.id]: !h[o.id] }))}
                          aria-expanded={open}
                        >
                          <ChevronDown
                            size={14}
                            className={cx('transition-transform', open && 'rotate-180')}
                          />
                          {open ? 'Hide' : 'Details'}
                        </Btn>
                      )}
                    </div>
                    {open && showDetail && (
                      <div className="mt-2">
                        {o.answer && (
                          <p className="text-sm text-slate-600">Charles answered: “{o.answer}”</p>
                        )}
                        {o.declineReason && (
                          <p className="text-sm text-slate-600">
                            {isClient ? 'You declined' : 'Frank @ Gemini Corp declined'}: “
                            {o.declineReason}”
                          </p>
                        )}
                        {o.lines && <OrderLines order={o} pricing={pricing} />}
                        {o.lines && o.status === 'approved' && (
                          <PriceEffect order={o} project={project} lens={lens} settled />
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
          </ul>
        </Card>
      )}

      <p className="text-sm leading-relaxed text-slate-500">
        {isClient
          ? pricing === 'fixed'
            ? "Charles can tidy the wording of a milestone at any time, and you'll be told. Anything that changes scope or price comes to you to approve first. Approved price changes are settled on your final invoice."
            : "Charles can tidy the wording of a milestone at any time, and you'll be told. Anything that adds scope or raises an estimate comes to you to approve first. You're billed for the time logged, as now."
          : isAdmin
            ? 'Amounts on the panel above are visible to Balo staff only.'
            : 'Wording edits apply straight away and Gemini Corp is told. Changes to scope or price go to Gemini Corp as a change, and nothing changes until they approve. One change can be open at a time.'}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ page */

const SCENARIOS = [
  { value: 'clean', label: 'No changes yet' },
  { value: 'requested', label: 'Client asked for a change' },
  { value: 'sent', label: 'Change sent, waiting on client' },
  { value: 'approved', label: 'Change approved' },
  { value: 'cut', label: 'Price cut below the deposit', fixedOnly: true },
];

export default function ProjectChangeOrdersPrototype() {
  const [pricing, setPricing] = useState('fixed');
  const [lens, setLens] = useState('expert');
  const [scenario, setScenario] = useState('requested');
  const [project, setProject] = useState(() => buildProject('fixed', 'requested'));
  const [resetKey, setResetKey] = useState(0);

  const load = (p, s) => {
    const sc = s === 'cut' && p === 'tm' ? 'clean' : s;
    setPricing(p);
    setScenario(sc);
    setProject(buildProject(p, sc));
    setResetKey((k) => k + 1);
  };

  useEffect(() => {
    try {
      if (!document.getElementById('geist-font')) {
        const l = document.createElement('link');
        l.id = 'geist-font';
        l.rel = 'stylesheet';
        l.href = 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap';
        document.head.appendChild(l);
      }
    } catch (e) {
      // Cosmetic only.
    }
  }, []);

  return (
    <div className="min-h-screen bg-white text-slate-900 antialiased" style={{ fontFamily: FONT }}>
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <span className="text-sm font-semibold text-slate-400">Prototype</span>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-slate-500">Pricing</span>
              <Segmented
                value={pricing}
                onChange={(p) => load(p, scenario)}
                options={[
                  { value: 'fixed', label: 'Fixed price' },
                  { value: 'tm', label: 'Time & materials' },
                ]}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-slate-500">Viewing as</span>
              <Segmented
                value={lens}
                onChange={setLens}
                options={[
                  { value: 'expert', label: 'Charles (expert)' },
                  { value: 'client', label: 'Frank @ Gemini Corp' },
                  { value: 'admin', label: 'Balo admin' },
                ]}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="scenario" className="text-sm text-slate-500">
                Start from
              </label>
              <select
                id="scenario"
                value={scenario}
                onChange={(e) => load(pricing, e.target.value)}
                className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-700"
              >
                {SCENARIOS.filter((s) => !(s.fixedOnly && pricing === 'tm')).map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={() => load(pricing, scenario)}
              className="ml-auto inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
            >
              <RotateCcw size={14} />
              Reset
            </button>
          </div>
          <p className="mt-3 border-t border-slate-200 pt-3 text-xs leading-relaxed text-slate-500">
            One change open at a time: requested → draft → sent → approved, declined or withdrawn.
            An expert can also answer a request without a change order. Money only moves when the
            client approves; wording edits apply directly and the client is told.
          </p>
        </div>

        <div className="mt-8">
          <ProjectPage
            key={`${lens}-${resetKey}`}
            lens={lens}
            project={project}
            setProject={setProject}
          />
        </div>
      </div>
    </div>
  );
}
