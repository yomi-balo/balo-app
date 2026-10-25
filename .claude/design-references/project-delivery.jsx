import { useState, useEffect, Fragment } from 'react';
import {
  Check,
  Eye,
  RotateCcw,
  MessageSquare,
  Send,
  Plus,
  Flag,
  Lock,
  GripVertical,
  Clock,
  Calendar,
  FileText,
  DollarSign,
  Layers,
  ChevronLeft,
  ChevronRight,
  ArrowRight,
  Timer,
  Sparkles,
  AlertTriangle,
  Receipt,
} from 'lucide-react';

/*
 * Balo — delivery views for fixed-price projects, T&M projects and retainers
 * Suggested home: .claude/design-references/project-delivery.jsx
 *
 * Two separate choices give three setups:
 *   - shape of the work: planned milestones (list) or an open queue (board)
 *   - what the client pays for: a fixed price, or hours
 *
 * Projects (fixed price and T&M) — the expert owns milestone status
 *   - Milestones: todo → in_progress → done, all moved by the expert. The client is kept posted but
 *     never has to act on a milestone.
 *   - The client acts once, at project level: when the expert marks the project ready
 *     (phase delivery → in_review), the client accepts it or requests changes.
 *   - Requesting changes needs a comment; tagging milestones is optional. Tagged milestones reopen
 *     to in_progress with the feedback attached; with no tags, the expert decides what to reopen.
 *     The project shows "Changes requested" until it's marked ready again, so it never reads as
 *     finished while feedback is outstanding.
 *   - Fixed price: acceptance is what the payment hangs on. No hours shown — experts price on value.
 *   - T&M: logged vs estimated hours per milestone and overall, plus the current billing period.
 *     Time is billed each period regardless of review status, so acceptance is close-out. No
 *     approval step on hours: every entry needs a note instead, and the client is notified when a
 *     milestone goes over its estimate. Estimates are soft; a bigger change in scope goes through a
 *     new proposal.
 *
 * Retainer — the client accepts each item
 *   - Items: todo → in_progress → in_review → done. The expert moves work up to In review (drag,
 *     or "Move to" in an opened card as the keyboard/mobile fallback). Only the client moves an
 *     item into Done. Requesting changes needs a comment and returns the item to In progress.
 *   - Clients create requests in To do. Logged hours roll up to the monthly allowance.
 *
 * Shared: work items and time entries live on the engagement seam, not under project tables.
 * T&M invoicing and retainer allowances both read time entries. The time-based views show hours,
 * never rates or amounts, so fee concealment doesn't depend on which lens renders.
 */

const FONT =
  'Geist, "Geist Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const TODAY = '24 Oct';
const EXPERT = { name: 'Charles', role: 'expert' };
const CLIENT = { name: 'Frank', company: 'Gemini Corp', role: 'client' };

let seq = 1000;
const uid = () => `n${seq++}`;
const cx = (...c) => c.filter(Boolean).join(' ');
const clone = (o) => JSON.parse(JSON.stringify(o));
const fmtH = (h) => String(Math.round(h * 100) / 100);
const hrs = (h) => `${fmtH(h)} ${Math.round(h * 100) / 100 === 1 ? 'hr' : 'hrs'}`;
const hoursOf = (i) => (i.entries || []).reduce((s, e) => s + e.hours, 0);
const who = (a) => (a.company ? `${a.name} @ ${a.company}` : a.name);
const actorFor = (lens) => (lens === 'expert' ? EXPERT : CLIENT);
const listify = (arr) =>
  arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`;

const STATUS = {
  todo: {
    label: 'To do',
    chip: 'border-slate-200 bg-slate-50 text-slate-600',
    dot: 'bg-slate-400',
    bar: 'bg-slate-200',
  },
  in_progress: {
    label: 'In progress',
    chip: 'border-blue-200 bg-blue-50 text-blue-700',
    dot: 'bg-blue-500',
    bar: 'bg-blue-400',
  },
  in_review: {
    label: 'In review',
    chip: 'border-violet-200 bg-violet-50 text-violet-700',
    dot: 'bg-violet-500',
    bar: 'bg-violet-400',
  },
  done: {
    label: 'Done',
    chip: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    dot: 'bg-emerald-500',
    bar: 'bg-gradient-to-r from-blue-600 to-violet-600',
  },
};
const ORDER = ['todo', 'in_progress', 'in_review', 'done'];

// Expert transitions. Nothing here reaches "done" — only the client accepts.
const EXPERT_MOVES = {
  todo: ['in_progress', 'in_review'],
  in_progress: ['todo', 'in_review'],
  in_review: ['in_progress'],
};

/* ------------------------------------------------------------------ seed data */

const FIXED_SEED = {
  phase: 'changes_requested', // delivery | in_review | changes_requested | accepted
  // Project-level feedback, newest first. milestoneIds is optional tagging (may be empty).
  feedback: [
    {
      id: 'f1',
      author: CLIENT,
      text: 'We agreed 2 years of history, but I can only see opportunities from this year. Can you check the import?',
      at: '24 Oct',
      milestoneIds: ['m2'],
    },
  ],
  items: [
    {
      id: 'm1',
      title: 'Discovery',
      description:
        'Requirements workshops with sales leadership, a current-state process map, and a Sales Cloud (Enterprise Edition) solution design.',
      status: 'done',
      startedAt: '23 Oct',
      completedAt: '23 Oct',
      comments: [],
    },
    {
      id: 'm2',
      title: 'Data migration',
      description:
        'Clean up and import 2 years of historical account, contact and opportunity data.',
      status: 'in_progress',
      startedAt: '23 Oct',
      changesRequested: true,
      comments: [
        {
          id: 'c1',
          author: CLIENT,
          text: 'We agreed 2 years of history, but I can only see opportunities from this year. Can you check the import?',
          at: '24 Oct',
        },
      ],
    },
    {
      id: 'm3',
      title: 'Implementation',
      description:
        'Configure Sales Cloud, automate lead routing, and build real-time pipeline dashboards for leadership.',
      status: 'done',
      startedAt: '23 Oct',
      completedAt: '23 Oct',
      comments: [
        {
          id: 'c2',
          author: EXPERT,
          text: 'Dashboards are live under Leadership Pipeline. Lead routing rules are written up in the handover notes.',
          at: '23 Oct',
        },
      ],
    },
  ],
};

const TM_SEED = {
  phase: 'delivery',
  feedback: [],
  billing: { period: '13–26 Oct', nextInvoice: '27 Oct', cadence: 'fortnightly' },
  items: [
    {
      id: 't1',
      title: 'Journey design',
      description:
        'Map the current recall process and design the reminder journeys for check-ups, cleans and lapsed patients.',
      status: 'done',
      startedAt: '8 Oct',
      completedAt: '15 Oct',
      estimate: 12,
      entries: [
        {
          id: 'e1',
          at: '14 Oct',
          hours: 4,
          note: 'Journey design workshop with the recall team',
          current: true,
        },
        {
          id: 'e2',
          at: '9 Oct',
          hours: 4.5,
          note: 'Mapped the current recall process and drop-off points',
        },
        { id: 'e3', at: '8 Oct', hours: 3, note: 'Kickoff and requirements' },
      ],
      comments: [],
    },
    {
      id: 't2',
      title: 'Data extensions and sync',
      description:
        'Patient and appointment data extensions, synced daily from the practice management system.',
      status: 'in_progress',
      startedAt: '10 Oct',
      estimate: 16,
      entries: [
        {
          id: 'e4',
          at: '23 Oct',
          hours: 3.5,
          note: 'Daily sync for appointment history',
          current: true,
        },
        {
          id: 'e5',
          at: '21 Oct',
          hours: 4,
          note: 'Built patient and appointment data extensions',
          current: true,
        },
        {
          id: 'e6',
          at: '16 Oct',
          hours: 2.5,
          note: 'Field mapping session with Gemini Corp IT',
          current: true,
        },
        { id: 'e7', at: '10 Oct', hours: 4, note: 'Data model design' },
      ],
      comments: [],
    },
    {
      id: 't3',
      title: 'Recall journeys build',
      description: 'Build and test the three recall journeys, with email and SMS steps.',
      status: 'in_progress',
      startedAt: '17 Oct',
      estimate: 20,
      entries: [
        {
          id: 'e8',
          at: '22 Oct',
          hours: 3,
          note: 'First journey: 6-month check-up reminder',
          current: true,
        },
        {
          id: 'e9',
          at: '17 Oct',
          hours: 3,
          note: 'Journey templates and email content blocks',
          current: true,
        },
      ],
      comments: [],
    },
    {
      id: 't4',
      title: 'UAT and handover',
      description: 'Support Gemini Corp’s testing, fix issues, and hand over with a short runbook.',
      status: 'todo',
      estimate: 8,
      entries: [],
      comments: [],
    },
  ],
};

const RETAINER_SEED = {
  allowance: 40,
  earlierHours: 6, // hours on items accepted earlier this month, not shown on the board
  items: [
    {
      id: 'r1',
      title: 'Add a Referral source picklist to Leads',
      detail:
        'Values: Website, Partner, Event, Existing client. It should also appear on the lead conversion screen.',
      status: 'todo',
      requestedBy: 'Frank',
      hours: 0,
      comments: [],
    },
    {
      id: 'r2',
      title: 'Duplicate rule is flagging shared clinic inboxes',
      detail: 'Contacts using reception@ addresses get flagged as duplicates across clinics.',
      status: 'todo',
      requestedBy: 'Priya',
      hours: 0,
      comments: [],
    },
    {
      id: 'r3',
      title: 'Pipeline dashboard: break out Victoria',
      detail: 'Leadership wants Victoria shown separately from the national view.',
      status: 'in_progress',
      requestedBy: 'Frank',
      hours: 3.5,
      comments: [],
    },
    {
      id: 'r4',
      title: 'Round-robin routing for new clinic enquiries',
      detail: 'Spread new web enquiries evenly across the front-desk team.',
      status: 'in_progress',
      requestedBy: 'Priya',
      hours: 6,
      changesRequested: true,
      comments: [
        {
          id: 'rc1',
          author: CLIENT,
          text: 'Weekend enquiries are still all going to Sam. Can they rotate too?',
          at: '23 Oct',
        },
      ],
    },
    {
      id: 'r5',
      title: 'Update the quote PDF template with the new ABN',
      detail: 'Gemini Corp’s ABN changed after the restructure.',
      status: 'in_review',
      requestedBy: 'Frank',
      hours: 1.5,
      comments: [
        {
          id: 'rc2',
          author: EXPERT,
          text: 'Template updated and the two open quotes regenerated. Ready for you to check.',
          at: '24 Oct',
        },
      ],
    },
    {
      id: 'r6',
      title: 'Deactivate 3 departed users and reassign their records',
      detail: '',
      status: 'done',
      requestedBy: 'Priya',
      hours: 1,
      acceptedAt: '22 Oct',
      comments: [],
    },
  ],
};

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

// Flat, shared bounding box — no shadow (matches the repo’s card convention).
function Card({ border = 'border-slate-200', className, children }) {
  return <div className={cx('rounded-2xl border bg-white', border, className)}>{children}</div>;
}

function StatusChip({ status, label }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
        STATUS[status].chip
      )}
    >
      {label || STATUS[status].label}
    </span>
  );
}

function ChangesChip() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-medium whitespace-nowrap text-amber-700">
      <RotateCcw size={12} />
      Changes requested
    </span>
  );
}

function AddressedChip({ lens }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-2.5 py-0.5 text-xs font-medium whitespace-nowrap text-sky-700">
      <Check size={12} />
      {lens === 'client' ? 'Updated after your feedback' : 'Feedback addressed'}
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

function Avatar({ author }) {
  const client = author.role === 'client';
  return (
    <div
      className={cx(
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
        client ? 'bg-amber-100 text-amber-800' : 'bg-violet-100 text-violet-700'
      )}
    >
      {author.name[0]}
    </div>
  );
}

function CommentThread({ comments, lens, onAdd }) {
  const [text, setText] = useState('');
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onAdd({ id: uid(), author: actorFor(lens), text: t, at: TODAY });
    setText('');
  };
  return (
    <div className="mt-3 space-y-3 rounded-xl bg-slate-50 p-3">
      {comments.map((c) => (
        <div key={c.id} className="flex gap-2.5">
          <Avatar author={c.author} />
          <div className="min-w-0">
            <p className="text-xs text-slate-500">
              <span className="font-medium text-slate-800">
                {c.author.role === lens ? 'You' : who(c.author)}
              </span>{' '}
              · {c.at}
            </p>
            <p className="mt-0.5 text-sm leading-relaxed text-slate-700">{c.text}</p>
          </div>
        </div>
      ))}
      <div className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder={comments.length ? 'Reply…' : 'Add a comment…'}
          className="h-8 min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-indigo-400"
        />
        <Btn variant="primary" disabled={!text.trim()} onClick={submit} aria-label="Send comment">
          <Send size={14} />
        </Btn>
      </div>
    </div>
  );
}

function Banner({ tone, icon: Icon, children }) {
  const box = {
    amber: 'border-amber-200 bg-amber-50 text-amber-900',
    violet: 'border-violet-200 bg-violet-50 text-violet-900',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  }[tone];
  const ic = { amber: 'text-amber-600', violet: 'text-violet-600', emerald: 'text-emerald-600' }[
    tone
  ];
  return (
    <div className={cx('flex items-start gap-3 rounded-2xl border px-4 py-3.5 text-sm', box)}>
      <Icon size={18} className={cx('mt-0.5 shrink-0', ic)} />
      <div className="leading-relaxed">{children}</div>
    </div>
  );
}

function StatusBadge({ label, tone, icon: Icon }) {
  const cls = {
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    violet: 'border-violet-200 bg-violet-50 text-violet-700',
  }[tone];
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium',
        cls
      )}
    >
      <Icon size={14} />
      {label}
    </span>
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

function PageHeader({ back, title, subtitle, badge, children }) {
  return (
    <div>
      <button
        type="button"
        className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"
      >
        <ChevronLeft size={16} />
        {back}
      </button>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
          <p className="mt-1 text-slate-500">{subtitle}</p>
        </div>
        {badge}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function FeedbackCallout({ comment, lens }) {
  return (
    <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3">
      <p className="text-xs font-medium text-amber-800">
        {lens === 'client' ? 'Your feedback' : `${who(comment.author)} requested changes`} ·{' '}
        {comment.at}
      </p>
      <p className="mt-1 text-sm leading-relaxed text-amber-900">{comment.text}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ prototype chrome */

function Edge({ children }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-slate-400">
      <ArrowRight size={12} />
      {children}
    </span>
  );
}

function StateModel({ mode }) {
  if (mode === 'retainer') {
    return (
      <div className="mt-4 border-t border-slate-200 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip status="todo" />
          <Edge>expert</Edge>
          <StatusChip status="in_progress" />
          <Edge>expert</Edge>
          <StatusChip status="in_review" />
          <Edge>client accepts</Edge>
          <StatusChip status="done" />
          <span className="inline-flex items-center gap-1 text-xs text-slate-400">
            <RotateCcw size={12} />
            or client requests changes, comment required
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          Retainer: the client accepts each item as it lands in In review. Only the client moves
          work into Done.
        </p>
      </div>
    );
  }
  return (
    <div className="mt-4 space-y-2.5 border-t border-slate-200 pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-20 text-xs font-medium text-slate-500">Milestones</span>
        <StatusChip status="todo" />
        <Edge>expert</Edge>
        <StatusChip status="in_progress" />
        <Edge>expert</Edge>
        <StatusChip status="done" label="Completed" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-20 text-xs font-medium text-slate-500">Project</span>
        <Pill tone="violet">Ready for review</Pill>
        <Edge>client</Edge>
        <Pill tone="emerald">Accepted</Pill>
        <span className="text-xs text-slate-400">or</span>
        <Pill tone="amber">Changes requested</Pill>
        <span className="text-xs text-slate-400">
          comment required, tagging milestones optional
        </span>
      </div>
      <p className="text-xs leading-relaxed text-slate-500">
        The expert owns milestone status; the client acts once, when the project is marked ready.{' '}
        {mode === 'tm'
          ? 'Time & materials: time is billed each period whatever the review status, so acceptance closes the project out.'
          : 'Fixed price: acceptance is what the payment hangs on.'}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ projects (fixed price and T&M) */

function projectMeta(i) {
  if (i.status === 'todo') return 'Not started';
  if (i.status === 'in_progress') return `Started ${i.startedAt || TODAY}`;
  return `Started ${i.startedAt || TODAY} · Completed ${i.completedAt || TODAY} by Charles`;
}

function Pill({ tone, children }) {
  const cls = {
    amber: 'border-amber-200 bg-amber-50 text-amber-700',
    violet: 'border-violet-200 bg-violet-50 text-violet-700',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  }[tone];
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
        cls
      )}
    >
      {children}
    </span>
  );
}

function Legend({ items }) {
  const groups = [
    ['Completed', 'bg-violet-600', items.filter((i) => i.status === 'done').length],
    ['Changes requested', 'bg-amber-400', items.filter((i) => i.changesRequested).length],
    [
      'In progress',
      'bg-blue-400',
      items.filter((i) => i.status === 'in_progress' && !i.changesRequested).length,
    ],
    [
      'To do',
      'bg-slate-300',
      items.filter((i) => i.status === 'todo' && !i.changesRequested).length,
    ],
  ].filter((g) => g[2] > 0);
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
      {groups.map(([label, dot, n]) => (
        <span key={label} className="inline-flex items-center gap-1.5">
          <span className={cx('h-2 w-2 rounded-full', dot)} />
          {label} {n}
        </span>
      ))}
    </div>
  );
}

function StatusDot({ item }) {
  const base = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-full';
  if (item.status === 'done')
    return (
      <div className={cx(base, 'bg-gradient-to-br from-blue-600 to-violet-600 text-white')}>
        <Check size={15} strokeWidth={3} />
      </div>
    );
  if (item.changesRequested)
    return (
      <div className={cx(base, 'border-2 border-amber-400 bg-amber-50 text-amber-600')}>
        <RotateCcw size={13} strokeWidth={2.5} />
      </div>
    );
  if (item.status === 'in_review')
    return (
      <div className={cx(base, 'border-2 border-violet-400 bg-violet-50 text-violet-600')}>
        <Eye size={13} strokeWidth={2.5} />
      </div>
    );
  if (item.status === 'in_progress')
    return (
      <div className={cx(base, 'border-2 border-blue-400 bg-white')}>
        <div className="h-2.5 w-2.5 rounded-full bg-blue-500" />
      </div>
    );
  return <div className={cx(base, 'border-2 border-slate-300 bg-white')} />;
}

// Soft estimate: amber from 80%, rose once over. Going over is allowed but never silent.
function HoursBar({ logged, estimate }) {
  const ratio = estimate ? logged / estimate : 0;
  const tone = ratio > 1 ? 'over' : ratio >= 0.8 ? 'near' : 'ok';
  const fill = { ok: 'bg-blue-500', near: 'bg-amber-400', over: 'bg-rose-500' }[tone];
  return (
    <div className="mt-3 max-w-md">
      <div className="flex flex-wrap items-center justify-between gap-x-3 text-xs">
        <span className="text-slate-500">
          <span className="font-medium text-slate-700">
            {fmtH(logged)} of {fmtH(estimate)} hrs
          </span>{' '}
          logged
        </span>
        {tone === 'near' && (
          <span className="font-medium text-amber-700">
            {hrs(estimate - logged)} left of estimate
          </span>
        )}
        {tone === 'over' && (
          <span className="font-medium text-rose-600">{hrs(logged - estimate)} over estimate</span>
        )}
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div
          className={cx('h-full rounded-full transition-all', fill)}
          style={{ width: `${Math.min(100, ratio * 100)}%` }}
        />
      </div>
    </div>
  );
}

function TimeLog({ entries, lens }) {
  return (
    <div className="mt-3 rounded-xl bg-slate-50 p-3">
      {entries.length === 0 ? (
        <p className="text-sm text-slate-500">No time logged yet.</p>
      ) : (
        <ul className="divide-y divide-slate-200">
          {entries.map((e) => (
            <li key={e.id} className="flex items-baseline gap-3 py-2 text-sm first:pt-0 last:pb-0">
              <span className="w-14 shrink-0 text-xs text-slate-500">{e.at}</span>
              <span className="min-w-0 flex-1 text-slate-700">{e.note}</span>
              <span className="shrink-0 font-medium text-slate-800">{fmtH(e.hours)} hrs</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-slate-400">
        Logged by {lens === 'expert' ? 'you' : 'Charles'}
      </p>
    </div>
  );
}

function ProjectView({ lens, pricing, data, setData }) {
  const { phase, items } = data;
  const isExpert = lens === 'expert';
  const isTm = pricing === 'tm';
  const locked = phase === 'in_review' || phase === 'accepted';

  const [open, setOpen] = useState({});
  const [logOpen, setLogOpen] = useState({});
  const [logging, setLogging] = useState(null);
  const [logDraft, setLogDraft] = useState({ hours: '1', note: '' });
  const [reviewing, setReviewing] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [picked, setPicked] = useState([]);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newEstimate, setNewEstimate] = useState('');

  const doneCount = items.filter((i) => i.status === 'done').length;
  const notDone = items.length - doneCount;
  const allDone = items.length > 0 && notDone === 0;
  const reopened = items.filter((i) => i.changesRequested);
  const latest = (data.feedback || [])[0] || null;
  const tagged = latest
    ? items.filter((i) => latest.milestoneIds.includes(i.id)).map((i) => i.title)
    : [];
  // Tagged work is all complete again: the banner switches from "work to do" to "ready to send".
  const changesDone =
    phase === 'changes_requested' && tagged.length > 0 && reopened.length === 0 && allDone;

  // Time & materials only
  const totalEstimate = items.reduce((s, i) => s + (i.estimate || 0), 0);
  const totalLogged = items.reduce((s, i) => s + hoursOf(i), 0);
  const periodHours = items.reduce(
    (s, i) => s + (i.entries || []).filter((e) => e.current).reduce((a, e) => a + e.hours, 0),
    0
  );
  const overItems = isTm ? items.filter((i) => i.estimate && hoursOf(i) > i.estimate) : [];

  const patch = (id, fn) =>
    setData((d) => ({ ...d, items: d.items.map((i) => (i.id === id ? { ...i, ...fn(i) } : i)) }));

  // No approval step on hours: a note on every entry is the trade-off.
  const logTime = (id) => {
    const hours = parseFloat(logDraft.hours);
    const note = logDraft.note.trim();
    if (!(hours > 0) || !note) return;
    patch(id, (i) => ({
      entries: [{ id: uid(), at: TODAY, hours, note, current: true }, ...(i.entries || [])],
    }));
    setLogging(null);
    setLogDraft({ hours: '1', note: '' });
  };

  // The expert owns milestone status. Completing one notifies the client; it never asks them to act.
  const move = (id, to) =>
    patch(id, (i) => ({
      status: to,
      startedAt: i.startedAt || (to !== 'todo' ? TODAY : undefined),
      completedAt: to === 'done' ? TODAY : i.completedAt,
      changesRequested: to === 'done' ? false : i.changesRequested,
      addressed: to === 'done' ? Boolean(i.changesRequested || i.addressed) : i.addressed,
    }));

  // The client's one touchpoint: the project is ready.
  const markReady = () => setData((d) => ({ ...d, phase: 'in_review' }));

  const acceptProject = () =>
    setData((d) => ({
      ...d,
      phase: 'accepted',
      acceptedAt: TODAY,
      items: d.items.map((i) => ({ ...i, changesRequested: false, addressed: false })),
    }));

  const requestChanges = () => {
    const text = feedback.trim();
    if (!text) return;
    setData((d) => ({
      ...d,
      phase: 'changes_requested',
      feedback: [
        { id: uid(), author: CLIENT, text, at: TODAY, milestoneIds: picked },
        ...(d.feedback || []),
      ],
      items: d.items.map((i) =>
        picked.includes(i.id)
          ? {
              ...i,
              status: 'in_progress',
              changesRequested: true,
              addressed: false,
              comments: [...i.comments, { id: uid(), author: CLIENT, text, at: TODAY }],
            }
          : { ...i, addressed: false }
      ),
    }));
    setReviewing(false);
    setFeedback('');
    setPicked([]);
  };

  const canAddMilestone = Boolean(newTitle.trim()) && (!isTm || parseFloat(newEstimate) > 0);
  const addMilestone = () => {
    if (!canAddMilestone) return;
    const title = newTitle.trim();
    setData((d) => ({
      ...d,
      items: [
        ...d.items,
        {
          id: uid(),
          title,
          description: '',
          status: 'todo',
          comments: [],
          ...(isTm ? { estimate: parseFloat(newEstimate), entries: [] } : {}),
        },
      ],
    }));
    setNewTitle('');
    setNewEstimate('');
    setAdding(false);
  };

  const badge =
    phase === 'accepted' ? (
      <StatusBadge label="Completed" tone="emerald" icon={Check} />
    ) : phase === 'in_review' ? (
      <StatusBadge label="In review" tone="violet" icon={Eye} />
    ) : (
      <StatusBadge label="Active" tone="emerald" icon={Layers} />
    );

  const reviewPill =
    phase === 'changes_requested' ? (
      <Pill tone="amber">Changes requested</Pill>
    ) : phase === 'in_review' ? (
      <Pill tone="violet">{isExpert ? 'Waiting on Gemini Corp' : 'Ready for your review'}</Pill>
    ) : phase === 'accepted' ? (
      <Pill tone="emerald">Accepted {data.acceptedAt}</Pill>
    ) : null;

  return (
    <div className="space-y-5">
      <PageHeader
        back="Projects"
        title={
          isTm
            ? 'National Dental Care — Patient Recall Journeys'
            : 'National Dental Care — CRM & Marketing Automation Implementation'
        }
        subtitle={isExpert ? 'For Gemini Corp' : 'With Charles'}
        badge={badge}
      >
        {isTm ? (
          <>
            {/* Hours only: no rate on the delivery page, so fee concealment holds in either lens. */}
            <MetaChip icon={Clock}>Time & materials</MetaChip>
            <MetaChip icon={Receipt}>Billed {data.billing.cadence}</MetaChip>
            <MetaChip icon={Calendar}>Kicked off 8 Oct</MetaChip>
          </>
        ) : (
          <>
            {/* Client lens: amount comes from the client-priced serializer, never the expert figure (fee concealment). */}
            <MetaChip icon={DollarSign}>
              {isExpert ? 'Fixed price · A$12,500' : 'Fixed price'}
            </MetaChip>
            <MetaChip icon={Calendar}>Kicked off 23 Oct</MetaChip>
          </>
        )}
        <MetaChip icon={FileText} link>
          View request
        </MetaChip>
      </PageHeader>

      {overItems.length > 0 && (
        <Banner tone="amber" icon={AlertTriangle}>
          {isExpert ? (
            <>
              <span className="font-semibold">
                {listify(overItems.map((i) => i.title))} {overItems.length === 1 ? 'is' : 'are'}{' '}
                over estimate.
              </span>{' '}
              Gemini Corp has been notified. If the scope has grown, raise a new proposal rather
              than logging on.
            </>
          ) : (
            <>
              <span className="font-semibold">
                {listify(overItems.map((i) => i.title))} {overItems.length === 1 ? 'has' : 'have'}{' '}
                gone over estimate.
              </span>{' '}
              The time log on each milestone shows what the hours went on. If the scope has grown,
              Charles can send a new proposal.
            </>
          )}
        </Banner>
      )}

      {phase === 'changes_requested' &&
        (isExpert ? (
          changesDone ? (
            // State change, not a footnote: new tone, new headline, and the action right here.
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-violet-200 bg-violet-50 px-4 py-4 text-sm">
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet-600 text-white">
                  <Check size={14} strokeWidth={3} />
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-violet-900">
                    Changes made. Ready to send back to Gemini Corp?
                  </p>
                  {latest && (
                    <p className="mt-1 leading-relaxed text-violet-800">
                      {who(latest.author)} asked: “{latest.text}”
                    </p>
                  )}
                </div>
              </div>
              <Btn variant="primary" size="md" onClick={markReady}>
                <Send size={16} />
                Mark project ready again
              </Btn>
            </div>
          ) : (
            <Banner tone="amber" icon={MessageSquare}>
              <span className="font-semibold">
                {latest ? who(latest.author) : 'Gemini Corp'} requested changes
                {tagged.length ? ` on ${listify(tagged)}` : ''}.
              </span>
              {latest && <span className="mt-1.5 block">“{latest.text}”</span>}
              <span className="mt-1.5 block">
                {reopened.length
                  ? `${listify(reopened.map((i) => i.title))} ${
                      reopened.length === 1 ? 'is' : 'are'
                    } back in progress. Complete ${
                      reopened.length === 1 ? 'it' : 'them'
                    }, then mark the project ready again.`
                  : tagged.length
                    ? 'Your changes are in. Finish the remaining milestones, then mark the project ready again.'
                    : 'No milestones were tagged, so reopen whatever needs work, then mark the project ready again.'}
              </span>
            </Banner>
          )
        ) : (
          <Banner tone="amber" icon={MessageSquare}>
            You requested changes{tagged.length ? ` on ${listify(tagged)}` : ''}. Charles is working
            on them, and you’ll be told when the project is ready again.
          </Banner>
        ))}

      {phase === 'in_review' && isExpert && (
        <Banner tone="violet" icon={Eye}>
          <span className="font-semibold">Gemini Corp has been told the project is ready.</span>{' '}
          You’ll be notified when they accept it or request changes.
        </Banner>
      )}

      {phase === 'accepted' && (
        <Banner tone="emerald" icon={Sparkles}>
          {isExpert ? (
            <>
              <span className="font-semibold">Gemini Corp accepted the project.</span>{' '}
              Congratulations on a great delivery.
              {isTm && ' Any time logged since the last invoice goes on the final one.'}
            </>
          ) : (
            <>
              <span className="font-semibold">Project accepted.</span> Thanks for working with
              Charles.
            </>
          )}
        </Banner>
      )}

      {/* Milestones completed is the expert's count; the pill carries the client's review state. */}
      <Card className="p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
            <p className="text-slate-500">
              <span className="mr-2 text-3xl font-semibold tracking-tight text-slate-900">
                {doneCount} of {items.length}
              </span>
              milestones completed
            </p>
            {reviewPill}
          </div>
          <Legend items={items} />
        </div>
        <div className="mt-5 flex gap-1.5">
          {items.map((i) => (
            <div
              key={i.id}
              title={`${i.title}: ${
                i.changesRequested
                  ? 'Changes requested'
                  : i.status === 'done'
                    ? 'Completed'
                    : STATUS[i.status].label
              }`}
              className={cx(
                'h-2 flex-1 rounded-full transition-colors',
                i.changesRequested ? 'bg-amber-400' : STATUS[i.status].bar
              )}
            />
          ))}
        </div>

        {isTm && (
          <div className="mt-6 grid gap-5 border-t border-slate-100 pt-5 sm:grid-cols-2">
            <div>
              <p className="text-sm text-slate-500">
                <span className="font-semibold text-slate-900">
                  {fmtH(totalLogged)} of {fmtH(totalEstimate)} hrs
                </span>{' '}
                logged against the estimate
              </p>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
                <div
                  className={cx(
                    'h-full rounded-full transition-all',
                    totalLogged > totalEstimate
                      ? 'bg-rose-500'
                      : 'bg-gradient-to-r from-blue-600 to-violet-600'
                  )}
                  style={{ width: `${Math.min(100, (totalLogged / totalEstimate) * 100)}%` }}
                />
              </div>
            </div>
            <div>
              <p className="text-sm text-slate-500">
                <span className="font-semibold text-slate-900">{fmtH(periodHours)} hrs</span> this
                billing period
              </p>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
                {data.billing.period} ·{' '}
                {isExpert
                  ? `billed to Gemini Corp on ${data.billing.nextInvoice}, whatever the review status`
                  : `invoiced on ${data.billing.nextInvoice} for the time Charles has logged`}
              </p>
            </div>
          </div>
        )}

        {/* Hidden while the banner carries the action, so there's one primary button on screen. */}
        {isExpert && !locked && !changesDone && (
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-5">
            <p className="text-sm text-slate-500">
              {allDone
                ? 'Everything’s complete. Gemini Corp gets one notification that the project is ready.'
                : `${notDone} ${notDone === 1 ? 'milestone' : 'milestones'} still to complete.`}
            </p>
            <Btn variant="primary" size="md" disabled={!allDone} onClick={markReady}>
              <Send size={16} />
              {phase === 'changes_requested' ? 'Mark project ready again' : 'Mark project ready'}
            </Btn>
          </div>
        )}
      </Card>

      {phase === 'in_review' && !isExpert && (
        <Card border="border-violet-200" className="p-6">
          <div className="flex items-start gap-3">
            <div className="rounded-full bg-violet-50 p-2 text-violet-600">
              <Eye size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold text-slate-900">Charles says the project is ready</h3>
              <p className="mt-1 text-sm text-slate-500">
                {isTm
                  ? 'Have a look through the milestones below, then accept the project to close it out or request changes. Time already logged is billed as usual either way.'
                  : 'Have a look through the milestones below, then accept the project or request changes.'}
              </p>

              {!reviewing ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  <Btn variant="primary" size="md" onClick={acceptProject}>
                    <Check size={16} />
                    Accept project
                  </Btn>
                  <Btn size="md" onClick={() => setReviewing(true)}>
                    <RotateCcw size={16} />
                    Request changes
                  </Btn>
                </div>
              ) : (
                <div className="mt-4 space-y-4">
                  <div>
                    <label
                      htmlFor="feedback"
                      className="mb-1.5 block text-sm font-medium text-slate-700"
                    >
                      What needs to change?
                    </label>
                    <textarea
                      id="feedback"
                      autoFocus
                      rows={3}
                      value={feedback}
                      onChange={(e) => setFeedback(e.target.value)}
                      placeholder="Be as specific as you can."
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-400"
                    />
                  </div>
                  <div>
                    <p className="mb-1.5 text-sm font-medium text-slate-700">
                      Is this about particular milestones?{' '}
                      <span className="font-normal text-slate-400">Optional</span>
                    </p>
                    <div className="space-y-1.5">
                      {items.map((i) => (
                        <label
                          key={i.id}
                          className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50"
                        >
                          <input
                            type="checkbox"
                            checked={picked.includes(i.id)}
                            onChange={() =>
                              setPicked((p) =>
                                p.includes(i.id) ? p.filter((x) => x !== i.id) : [...p, i.id]
                              )
                            }
                            className="h-4 w-4"
                          />
                          <span className="font-medium text-slate-800">{i.title}</span>
                        </label>
                      ))}
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                      Milestones you pick go back to Charles with your feedback. If you don’t pick
                      any, Charles works out what needs to change.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Btn
                      variant="primary"
                      size="md"
                      disabled={!feedback.trim()}
                      onClick={requestChanges}
                    >
                      Request changes
                    </Btn>
                    <Btn variant="ghost" size="md" onClick={() => setReviewing(false)}>
                      Cancel
                    </Btn>
                  </div>
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      <Card className="p-6">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-wide text-slate-500 uppercase">
            <Flag size={16} />
            Delivery plan
          </h2>
          {isExpert && !locked && (
            <Btn variant="ghost" onClick={() => setAdding(true)}>
              <Plus size={16} />
              Add milestone
            </Btn>
          )}
        </div>

        <div>
          {items.map((i, idx) => {
            const last = idx === items.length - 1 && !adding;
            const fb = i.changesRequested
              ? [...i.comments].reverse().find((c) => c.author.role === 'client')
              : null;
            return (
              <div key={i.id} className="flex gap-4">
                <div className="flex flex-col items-center">
                  <StatusDot item={i} />
                  {!last && (
                    <div
                      className={cx(
                        'my-1 w-0.5 flex-1 rounded-full',
                        i.status === 'done' ? 'bg-violet-300' : 'bg-slate-200'
                      )}
                    />
                  )}
                </div>
                <div className={cx('min-w-0 flex-1', last ? 'pb-2' : 'pb-8')}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="leading-7 font-semibold text-slate-900">{i.title}</h3>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {i.changesRequested && <ChangesChip />}
                      {!i.changesRequested && i.addressed && phase !== 'accepted' && (
                        <AddressedChip lens={lens} />
                      )}
                      <StatusChip
                        status={i.status}
                        label={i.status === 'done' ? 'Completed' : undefined}
                      />
                    </div>
                  </div>
                  {i.description && (
                    <p className="mt-2 leading-relaxed text-slate-600">{i.description}</p>
                  )}
                  <p className="mt-2 text-sm text-slate-400">{projectMeta(i)}</p>

                  {isTm && <HoursBar logged={hoursOf(i)} estimate={i.estimate} />}

                  {fb && <FeedbackCallout comment={fb} lens={lens} />}

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {isExpert && !locked && i.status === 'todo' && (
                      <Btn onClick={() => move(i.id, 'in_progress')}>
                        <ArrowRight size={14} />
                        Start
                      </Btn>
                    )}
                    {isExpert && !locked && i.status === 'in_progress' && (
                      <Btn variant="primary" onClick={() => move(i.id, 'done')}>
                        <Check size={14} />
                        Mark complete
                      </Btn>
                    )}
                    {isTm &&
                      isExpert &&
                      !locked &&
                      i.status === 'in_progress' &&
                      logging !== i.id && (
                        <Btn
                          onClick={() => {
                            setLogging(i.id);
                            setLogDraft({ hours: '1', note: '' });
                          }}
                        >
                          <Timer size={14} />
                          Log time
                        </Btn>
                      )}
                    {isExpert && !locked && i.status === 'done' && (
                      <Btn variant="ghost" onClick={() => move(i.id, 'in_progress')}>
                        <RotateCcw size={14} />
                        Move back to in progress
                      </Btn>
                    )}
                    <Btn
                      variant="ghost"
                      onClick={() => setOpen((o) => ({ ...o, [i.id]: !o[i.id] }))}
                    >
                      <MessageSquare size={14} />
                      {i.comments.length
                        ? `${i.comments.length} ${i.comments.length === 1 ? 'comment' : 'comments'}`
                        : 'Comment'}
                    </Btn>
                    {isTm && (
                      <Btn
                        variant="ghost"
                        onClick={() => setLogOpen((o) => ({ ...o, [i.id]: !o[i.id] }))}
                        aria-expanded={Boolean(logOpen[i.id])}
                      >
                        <Clock size={14} />
                        Time log ({(i.entries || []).length})
                      </Btn>
                    )}
                  </div>

                  {logging === i.id &&
                    (() => {
                      const add = parseFloat(logDraft.hours) || 0;
                      const projected = hoursOf(i) + add;
                      const wasOver = hoursOf(i) > i.estimate;
                      const crosses = projected > i.estimate;
                      return (
                        <div className="mt-3 rounded-xl border border-slate-200 p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              type="number"
                              min="0.25"
                              step="0.25"
                              value={logDraft.hours}
                              onChange={(e) =>
                                setLogDraft((d) => ({ ...d, hours: e.target.value }))
                              }
                              aria-label="Hours"
                              className="h-8 w-20 rounded-lg border border-slate-200 px-2 text-sm outline-none focus:border-indigo-400"
                            />
                            <span className="text-sm text-slate-500">hrs</span>
                            <input
                              autoFocus
                              value={logDraft.note}
                              onChange={(e) => setLogDraft((d) => ({ ...d, note: e.target.value }))}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') logTime(i.id);
                                if (e.key === 'Escape') setLogging(null);
                              }}
                              placeholder="What did you work on?"
                              aria-label="Note"
                              className="h-8 min-w-0 flex-1 rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-indigo-400"
                              style={{ minWidth: 180 }}
                            />
                          </div>
                          {crosses && (
                            <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-amber-700">
                              <AlertTriangle size={14} className="mt-px shrink-0" />
                              {wasOver
                                ? `${i.title} is already over its ${fmtH(i.estimate)} hr estimate. This takes it to ${hrs(projected)}.`
                                : `This takes ${i.title} ${hrs(projected - i.estimate)} over its ${fmtH(i.estimate)} hr estimate. Gemini Corp will be notified.`}
                            </p>
                          )}
                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            <Btn
                              variant="primary"
                              disabled={!(add > 0) || !logDraft.note.trim()}
                              onClick={() => logTime(i.id)}
                            >
                              Log time
                            </Btn>
                            <Btn variant="ghost" onClick={() => setLogging(null)}>
                              Cancel
                            </Btn>
                            <span className="text-xs text-slate-400">
                              Gemini Corp sees every entry and its note.
                            </span>
                          </div>
                        </div>
                      );
                    })()}

                  {isTm && logOpen[i.id] && <TimeLog entries={i.entries || []} lens={lens} />}

                  {open[i.id] && (
                    <CommentThread
                      comments={i.comments}
                      lens={lens}
                      onAdd={(c) => patch(i.id, (x) => ({ comments: [...x.comments, c] }))}
                    />
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
                    if (e.key === 'Enter') addMilestone();
                    if (e.key === 'Escape') setAdding(false);
                  }}
                  placeholder="Milestone name"
                  className="h-8 min-w-0 flex-1 rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-indigo-400"
                />
                {isTm && (
                  <input
                    type="number"
                    min="0.5"
                    step="0.5"
                    value={newEstimate}
                    onChange={(e) => setNewEstimate(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') addMilestone();
                    }}
                    placeholder="Est. hrs"
                    aria-label="Estimated hours"
                    className="h-8 w-24 rounded-lg border border-slate-200 px-2 text-sm outline-none focus:border-indigo-400"
                  />
                )}
                <Btn variant="primary" disabled={!canAddMilestone} onClick={addMilestone}>
                  Add
                </Btn>
                <Btn variant="ghost" onClick={() => setAdding(false)}>
                  Cancel
                </Btn>
              </div>
            </div>
          )}
        </div>

        <p className="mt-6 border-t border-slate-100 pt-5 text-sm leading-relaxed text-slate-500">
          {isTm
            ? isExpert
              ? 'Time you log is billed to Gemini Corp each billing period, and they see every entry and its note. Gemini Corp is kept posted as milestones complete and told if one goes over its estimate, but doesn’t need to do anything until you mark the project ready. Estimates come from the accepted proposal — a bigger change in scope goes through a new proposal.'
              : 'You’re invoiced each billing period for the time Charles logs, and every entry shows what it was for. You’re kept posted as milestones complete and told if one goes over its estimate. There’s nothing for you to do until Charles marks the project ready. A bigger change in scope goes through a new proposal.'
            : isExpert
              ? 'Gemini Corp and Balo are kept posted as milestones complete or the plan changes. Gemini Corp doesn’t need to do anything until you mark the project ready, then accepts it or requests changes. Pricing is fixed from the accepted proposal — changes to price go through a new proposal.'
              : 'You’re kept posted as Charles completes milestones. There’s nothing for you to do until the project is ready, then you accept it or request changes. Pricing is fixed from the accepted proposal — changes to price go through a new proposal.'}
        </p>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ retainer */

function RetainerBoard({ lens, data, setData }) {
  const isExpert = lens === 'expert';
  const [dragId, setDragId] = useState(null);
  const [hoverCol, setHoverCol] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState({ title: '', detail: '' });
  const [changing, setChanging] = useState(null);
  const [changeText, setChangeText] = useState('');
  const [logFor, setLogFor] = useState(null);
  const [logHours, setLogHours] = useState('1');

  const used = data.earlierHours + data.items.reduce((s, i) => s + i.hours, 0);
  const left = Math.max(0, data.allowance - used);
  const pct = Math.min(100, (used / data.allowance) * 100);
  const dragItem = data.items.find((i) => i.id === dragId);

  const patch = (id, fn) =>
    setData((d) => ({ ...d, items: d.items.map((i) => (i.id === id ? { ...i, ...fn(i) } : i)) }));
  const canMove = (item, to) =>
    isExpert && Boolean(item) && (EXPERT_MOVES[item.status] || []).includes(to);
  const move = (id, to) =>
    patch(id, (i) => ({
      status: to,
      changesRequested: to === 'in_review' ? false : i.changesRequested,
    }));
  const accept = (id) =>
    patch(id, () => ({ status: 'done', acceptedAt: TODAY, changesRequested: false }));
  const requestChanges = (id) => {
    const text = changeText.trim();
    if (!text) return;
    patch(id, (i) => ({
      status: 'in_progress',
      changesRequested: true,
      comments: [...i.comments, { id: uid(), author: CLIENT, text, at: TODAY }],
    }));
    setChanging(null);
    setChangeText('');
  };
  const addRequest = () => {
    const title = draft.title.trim();
    if (!title) return;
    setData((d) => ({
      ...d,
      items: [
        {
          id: uid(),
          title,
          detail: draft.detail.trim(),
          status: 'todo',
          requestedBy: 'Frank',
          hours: 0,
          comments: [],
        },
        ...d.items,
      ],
    }));
    setDraft({ title: '', detail: '' });
    setComposing(false);
  };
  const logTime = (id) => {
    const h = parseFloat(logHours);
    if (!(h > 0)) return;
    patch(id, (i) => ({ hours: Math.round((i.hours + h) * 100) / 100 }));
    setLogFor(null);
    setLogHours('1');
  };

  const columns = [
    {
      key: 'todo',
      label: 'To do',
      hint: isExpert ? 'Requests from Gemini Corp' : 'Your requests. Charles picks them up.',
      empty: isExpert ? 'No new requests' : 'Nothing queued. Add a request with +.',
    },
    {
      key: 'in_progress',
      label: 'In progress',
      hint: isExpert ? 'You’re working on these' : 'Charles is working on these',
      empty: 'Nothing in progress',
    },
    {
      key: 'in_review',
      label: 'In review',
      hint: isExpert ? 'Waiting on Gemini Corp' : 'Your turn: accept or request changes',
      empty: isExpert ? 'Nothing waiting on Gemini Corp' : 'Nothing waiting on you',
    },
    {
      key: 'done',
      label: 'Done',
      hint: isExpert ? 'Accepted by Gemini Corp' : 'Accepted by you',
      empty: 'Accepted work shows here',
    },
  ];

  const renderCard = (item) => {
    const isOpen = expanded === item.id;
    const draggable = isExpert && item.status !== 'done' && !isOpen;
    const fb = item.changesRequested
      ? [...item.comments].reverse().find((c) => c.author.role === 'client')
      : null;
    const targets = ORDER.filter((s) => canMove(item, s));
    const requester = !isExpert && item.requestedBy === 'Frank' ? 'you' : item.requestedBy;

    return (
      <div
        key={item.id}
        draggable={draggable}
        onDragStart={(e) => {
          setDragId(item.id);
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', item.id);
        }}
        onDragEnd={() => {
          setDragId(null);
          setHoverCol(null);
        }}
        className={cx(
          'rounded-xl border border-slate-200 bg-white p-3 transition-opacity',
          draggable && 'cursor-grab active:cursor-grabbing',
          dragId === item.id && 'opacity-40'
        )}
      >
        <div className="flex items-start gap-1.5">
          {draggable && <GripVertical size={14} className="mt-0.5 shrink-0 text-slate-300" />}
          <button
            type="button"
            onClick={() => setExpanded(isOpen ? null : item.id)}
            aria-expanded={isOpen}
            className="min-w-0 flex-1 rounded text-left text-sm leading-snug font-medium text-slate-900 hover:text-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
          >
            {item.title}
          </button>
        </div>

        {item.changesRequested && (
          <div className="mt-2">
            <ChangesChip />
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
          <span>Requested by {requester}</span>
          {item.hours > 0 && (
            <span className="inline-flex items-center gap-1">
              <Clock size={12} />
              {fmtH(item.hours)} hrs
            </span>
          )}
          {item.comments.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <MessageSquare size={12} />
              {item.comments.length}
            </span>
          )}
        </div>

        {fb && !isOpen && <FeedbackCallout comment={fb} lens={lens} />}

        {!isExpert && item.status === 'in_review' && changing !== item.id && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Btn variant="primary" className="flex-1" onClick={() => accept(item.id)}>
              <Check size={14} />
              Accept
            </Btn>
            <Btn
              className="flex-1"
              onClick={() => {
                setChanging(item.id);
                setChangeText('');
              }}
            >
              <RotateCcw size={14} />
              Request changes
            </Btn>
          </div>
        )}

        {changing === item.id && (
          <div className="mt-3 space-y-2">
            <textarea
              autoFocus
              rows={3}
              value={changeText}
              onChange={(e) => setChangeText(e.target.value)}
              placeholder="What needs to change?"
              className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm outline-none focus:border-indigo-400"
            />
            <div className="flex flex-wrap gap-1.5">
              <Btn
                variant="primary"
                disabled={!changeText.trim()}
                onClick={() => requestChanges(item.id)}
              >
                Request changes
              </Btn>
              <Btn variant="ghost" onClick={() => setChanging(null)}>
                Cancel
              </Btn>
            </div>
          </div>
        )}

        {isOpen && (
          <div className="mt-3 border-t border-slate-100 pt-3">
            {item.detail && <p className="text-sm leading-relaxed text-slate-600">{item.detail}</p>}
            {item.status === 'done' && (
              <p className="mt-2 text-xs text-slate-400">
                Accepted {item.acceptedAt} by {isExpert ? 'Frank @ Gemini Corp' : 'you'}
              </p>
            )}

            {targets.length > 0 && (
              <div className="mt-3">
                <p className="mb-1.5 text-xs font-medium text-slate-500">Move to</p>
                <div className="flex flex-wrap gap-1.5">
                  {targets.map((t) => (
                    <Btn key={t} onClick={() => move(item.id, t)}>
                      {STATUS[t].label}
                    </Btn>
                  ))}
                </div>
              </div>
            )}

            {isExpert &&
              item.status === 'in_progress' &&
              (logFor === item.id ? (
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <input
                    type="number"
                    min="0.25"
                    step="0.25"
                    value={logHours}
                    onChange={(e) => setLogHours(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') logTime(item.id);
                    }}
                    aria-label="Hours"
                    className="h-8 w-20 rounded-lg border border-slate-200 px-2 text-sm outline-none focus:border-indigo-400"
                  />
                  <span className="text-sm text-slate-500">hrs</span>
                  <Btn variant="primary" onClick={() => logTime(item.id)}>
                    Log time
                  </Btn>
                  <Btn variant="ghost" onClick={() => setLogFor(null)}>
                    Cancel
                  </Btn>
                </div>
              ) : (
                <Btn
                  className="mt-3"
                  onClick={() => {
                    setLogFor(item.id);
                    setLogHours('1');
                  }}
                >
                  <Timer size={14} />
                  Log time
                </Btn>
              ))}

            <CommentThread
              comments={item.comments}
              lens={lens}
              onAdd={(c) => patch(item.id, (x) => ({ comments: [...x.comments, c] }))}
            />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-5">
      <PageHeader
        back="Retainers"
        title="Salesforce support retainer"
        subtitle={isExpert ? 'For Gemini Corp' : 'With Charles'}
        badge={<StatusBadge label="Active" tone="emerald" icon={Layers} />}
      >
        <MetaChip icon={Timer}>40 hrs / month</MetaChip>
        <MetaChip icon={Calendar}>Started 1 Oct</MetaChip>
        <MetaChip icon={FileText} link>
          View agreement
        </MetaChip>
      </PageHeader>

      <Card className="p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-slate-500">
            <span className="mr-2 text-3xl font-semibold tracking-tight text-slate-900">
              {fmtH(used)} of {data.allowance}
            </span>
            hours used in October
          </p>
          <p className="text-sm text-slate-500">{fmtH(left)} hrs left · resets 1 Nov</p>
        </div>
        <div className="mt-5 h-2 overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-gradient-to-r from-blue-600 to-violet-600 transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </Card>

      <div className="-mx-1 overflow-x-auto pb-2">
        <div className="flex gap-3 px-1">
          {columns.map((col) => {
            const colItems = data.items.filter((i) => i.status === col.key);
            const hovering = Boolean(dragId) && hoverCol === col.key;
            const allowed = hovering && canMove(dragItem, col.key);
            const blocked = hovering && !allowed && dragItem && dragItem.status !== col.key;
            const yourTurn = !isExpert && !dragId && col.key === 'in_review' && colItems.length > 0;

            return (
              <div
                key={col.key}
                onDragOver={(e) => {
                  if (!dragId) return;
                  if (hoverCol !== col.key) setHoverCol(col.key);
                  if (canMove(dragItem, col.key)) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                  }
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget))
                    setHoverCol((h) => (h === col.key ? null : h));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (canMove(dragItem, col.key)) move(dragId, col.key);
                  setDragId(null);
                  setHoverCol(null);
                }}
                className={cx(
                  'relative flex flex-1 flex-col rounded-2xl border p-3 transition-colors',
                  allowed
                    ? 'border-indigo-300 bg-indigo-50'
                    : blocked
                      ? 'border-dashed border-slate-300 bg-slate-50'
                      : yourTurn
                        ? 'border-violet-200 bg-violet-50'
                        : 'border-slate-200 bg-slate-50'
                )}
                style={{ minWidth: 248 }}
              >
                <div className="mb-3 px-1">
                  <div className="flex items-center justify-between">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                      <span className={cx('h-2 w-2 rounded-full', STATUS[col.key].dot)} />
                      {col.label}
                      <span className="font-normal text-slate-400">{colItems.length}</span>
                    </h3>
                    {col.key === 'todo' && !isExpert && (
                      <button
                        type="button"
                        onClick={() => setComposing(true)}
                        aria-label="New request"
                        className="rounded-md p-1 text-slate-500 hover:bg-white hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
                      >
                        <Plus size={16} />
                      </button>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">{col.hint}</p>
                </div>

                {col.key === 'todo' && composing && !isExpert && (
                  <div className="mb-2 rounded-xl border border-indigo-200 bg-white p-3">
                    <input
                      autoFocus
                      value={draft.title}
                      onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') addRequest();
                        if (e.key === 'Escape') setComposing(false);
                      }}
                      placeholder="What do you need?"
                      className="w-full text-sm font-medium text-slate-900 outline-none"
                    />
                    <textarea
                      rows={2}
                      value={draft.detail}
                      onChange={(e) => setDraft((d) => ({ ...d, detail: e.target.value }))}
                      placeholder="Add detail (optional)"
                      className="mt-2 w-full resize-none text-sm text-slate-600 outline-none"
                    />
                    <div className="mt-2 flex justify-end gap-1.5">
                      <Btn variant="ghost" onClick={() => setComposing(false)}>
                        Cancel
                      </Btn>
                      <Btn variant="primary" disabled={!draft.title.trim()} onClick={addRequest}>
                        Add request
                      </Btn>
                    </div>
                  </div>
                )}

                <div className="flex flex-1 flex-col gap-2" style={{ minHeight: 120 }}>
                  {colItems.map(renderCard)}
                  {colItems.length === 0 && !(col.key === 'todo' && composing) && (
                    <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400">
                      {col.empty}
                    </div>
                  )}
                </div>

                {blocked && col.key === 'done' && (
                  <div
                    className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-2xl p-4 text-center"
                    style={{ background: 'rgba(248, 250, 252, 0.9)' }}
                  >
                    <p className="flex items-center gap-2 text-sm font-medium text-slate-600">
                      <Lock size={16} />
                      Only Gemini Corp can accept work
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <p className="text-sm leading-relaxed text-slate-500">
        {isExpert
          ? 'Gemini Corp adds requests to To do. Drag cards across as you go, or open a card and use Move to. When something’s ready, move it to In review and Gemini Corp accepts it or requests changes. Time you log counts toward this month’s 40 hours.'
          : 'Add requests to To do and Charles picks them up. When something’s ready it lands in In review, where you accept it or request changes. Time Charles logs counts toward this month’s 40 hours.'}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ page */

export default function ProjectDeliveryPrototype() {
  const [mode, setMode] = useState('fixed');
  const [lens, setLens] = useState('expert');
  const [fixed, setFixed] = useState(() => clone(FIXED_SEED));
  const [tm, setTm] = useState(() => clone(TM_SEED));
  const [retainer, setRetainer] = useState(() => clone(RETAINER_SEED));
  const [resetKey, setResetKey] = useState(0);

  const reset = () => {
    setFixed(clone(FIXED_SEED));
    setTm(clone(TM_SEED));
    setRetainer(clone(RETAINER_SEED));
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
      // Font is cosmetic; the fallback stack is fine.
    }
  }, []);

  return (
    <div className="min-h-screen bg-white text-slate-900 antialiased" style={{ fontFamily: FONT }}>
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <span className="text-sm font-semibold text-slate-400">Prototype</span>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-slate-500">Engagement</span>
              <Segmented
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'fixed', label: 'Fixed price' },
                  { value: 'tm', label: 'Time & materials' },
                  { value: 'retainer', label: 'Retainer' },
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
                ]}
              />
            </div>
            <button
              type="button"
              onClick={reset}
              className="ml-auto inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
            >
              <RotateCcw size={14} />
              Reset
            </button>
          </div>
          <StateModel mode={mode} />
        </div>

        <div className={cx('mt-8', mode !== 'retainer' && 'mx-auto max-w-4xl')}>
          {mode === 'fixed' ? (
            <ProjectView
              key={`f-${lens}-${resetKey}`}
              lens={lens}
              pricing="fixed"
              data={fixed}
              setData={setFixed}
            />
          ) : mode === 'tm' ? (
            <ProjectView
              key={`t-${lens}-${resetKey}`}
              lens={lens}
              pricing="tm"
              data={tm}
              setData={setTm}
            />
          ) : (
            <RetainerBoard
              key={`r-${lens}-${resetKey}`}
              lens={lens}
              data={retainer}
              setData={setRetainer}
            />
          )}
        </div>
      </div>
    </div>
  );
}
