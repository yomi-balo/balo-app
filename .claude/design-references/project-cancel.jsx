import { useState, useEffect, useRef, forwardRef } from 'react';
import {
  Check,
  Clock,
  ChevronLeft,
  ChevronRight,
  DollarSign,
  Calendar,
  FileText,
  MoreHorizontal,
  Copy,
  Ban,
  Info,
  RotateCcw,
} from 'lucide-react';

/*
 * Balo — cancelling a project is one click deep, never a standing button
 * Suggested home: .claude/design-references/project-cancel.jsx
 * Applies to the project delivery page (apps/web/src/app/(dashboard)/engagements/[id]).
 *
 * Today the admin view shows an "Oversight" card whose only contents are a "Last delivery
 * activity" chip and a solid red "Cancel engagement" button — the loudest control on the page.
 * Balo doesn't encourage cancellation (same rule as consultations), so:
 *
 *  - The Oversight card goes. "Last delivery activity" becomes a chip in the header row.
 *  - Cancel moves into a "More actions" menu (⋯) beside the status badge, as the last item, in
 *    red text after a divider. Only Balo admin (CANCEL_ANY_ENGAGEMENT, ADR-1035) can cancel a
 *    project, so this is an admin-only view; clients and experts ask Balo.
 *  - The confirmation is plain and factual — staff usually cancel because one side asked, so it
 *    doesn't coach. It states what cancelling does and, when the client is reviewing, that the
 *    project is about to be accepted. The reason is required and both sides see it (it's in the
 *    engagement.cancelled notification).
 *  - "Keep the project" is the primary button. "Cancel project" is a ghost button with red text,
 *    disabled until a reason is entered — never the primary, never solid red.
 *
 * Also shown: the review banner states the auto-accept date as a fact. The "Auto-accepts in 7
 * days" countdown pill is dropped (review windows are facts, not countdowns).
 */

const FONT =
  'Geist, "Geist Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const cx = (...c) => c.filter(Boolean).join(' ');

/* ------------------------------------------------------------------ primitives */

const Btn = forwardRef(function Btn(
  { variant = 'outline', size = 'sm', className, children, ...props },
  ref
) {
  const v = {
    primary: 'border border-indigo-600 bg-indigo-600 text-white hover:bg-indigo-700',
    outline: 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
    ghost: 'border border-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-900',
    // The only destructive style allowed: ghost, red text. Never solid red, never primary.
    danger: 'border border-transparent text-rose-600 hover:bg-rose-50 hover:text-rose-700',
  }[variant];
  const s = size === 'sm' ? 'h-8 gap-1.5 px-3 text-sm' : 'h-10 gap-2 px-4 text-sm';
  return (
    <button
      ref={ref}
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
});

function Card({ className, children }) {
  return (
    <div className={cx('rounded-2xl border border-slate-200 bg-white', className)}>{children}</div>
  );
}

function Pill({ tone = 'slate', icon: Icon, children }) {
  const cls = {
    slate: 'border-slate-200 bg-slate-50 text-slate-600',
    amber: 'border-amber-200 bg-amber-50 text-amber-700',
    violet: 'border-violet-200 bg-violet-50 text-violet-700',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  }[tone];
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium whitespace-nowrap',
        cls
      )}
    >
      {Icon && <Icon size={14} />}
      {children}
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

/* ------------------------------------------------------------------ more-actions menu */

function MoreActionsMenu({ onCancel, initialOpen = false }) {
  const [open, setOpen] = useState(initialOpen);
  const [copied, setCopied] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1.5 w-56 rounded-xl border border-slate-200 bg-white p-1"
          style={{ boxShadow: '0 8px 24px rgba(15, 23, 42, 0.08)' }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? 'Link copied' : 'Copy project link'}
          </button>
          <div className="my-1 border-t border-slate-100" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onCancel();
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-rose-600 hover:bg-rose-50"
          >
            <Ban size={14} />
            Cancel project…
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ confirmation */

function CancelDialog({ project, onKeep, onConfirm }) {
  const [reason, setReason] = useState('');
  const keepRef = useRef(null);

  useEffect(() => {
    keepRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') onKeep();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onKeep]);

  const inReview = project.status === 'in_review';

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center p-4"
      style={{ background: 'rgba(15, 23, 42, 0.4)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onKeep();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cancel-title"
        className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6"
      >
        <h2 id="cancel-title" className="text-lg font-semibold text-slate-900">
          Cancel this project?
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          Delivery stops straight away for Gemini Corp and Charles, and it can't be undone. Both are
          told, with your reason.
        </p>

        {inReview && (
          <div className="mt-4 flex items-start gap-2 rounded-xl border border-violet-200 bg-violet-50 p-3 text-sm text-violet-900">
            <Info size={16} className="mt-0.5 shrink-0 text-violet-600" />
            <p>
              Charles has marked the project ready and Gemini Corp is reviewing it. If they don't
              respond, it's accepted on {project.autoAcceptOn}.
            </p>
          </div>
        )}

        <label htmlFor="cancel-reason" className="mt-4 block text-sm font-medium text-slate-800">
          Reason
        </label>
        <p className="text-xs text-slate-500">Gemini Corp and Charles both see this.</p>
        <textarea
          id="cancel-reason"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="mt-1.5 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-400"
        />

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          <Btn
            variant="danger"
            size="md"
            disabled={!reason.trim()}
            onClick={() => onConfirm(reason.trim())}
          >
            Cancel project
          </Btn>
          <Btn ref={keepRef} variant="primary" size="md" onClick={onKeep}>
            Keep the project
          </Btn>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ page */

const BASE = {
  title: 'National Dental Care — CRM & Marketing Automation Implementation',
  parties: 'Gemini Corp ↔ Charles Akintunde',
  price: 'A$12,500',
  kickoff: '23 Oct',
  readyOn: '23 Oct',
  autoAcceptOn: '30 Oct',
  lastActivity: 'today',
};

export function ProjectHeader({
  lens,
  status,
  initialMenuOpen = false,
  initialDialogOpen = false,
}) {
  const [dialog, setDialog] = useState(initialDialogOpen);
  const [cancelled, setCancelled] = useState(null);
  const project = { ...BASE, status };
  const isAdmin = lens === 'admin';

  const badge = cancelled ? (
    <Pill tone="slate" icon={Ban}>
      Cancelled
    </Pill>
  ) : status === 'in_review' ? (
    <Pill tone="violet" icon={Clock}>
      Awaiting client review
    </Pill>
  ) : (
    <Pill tone="emerald">Active</Pill>
  );

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
              {isAdmin ? project.parties : lens === 'client' ? 'With Charles' : 'For Gemini Corp'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {badge}
            {/* Only CANCEL_ANY_ENGAGEMENT holders get the menu; clients and experts have no cancel. */}
            {isAdmin && !cancelled && (
              <MoreActionsMenu initialOpen={initialMenuOpen} onCancel={() => setDialog(true)} />
            )}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <MetaChip icon={DollarSign}>Fixed price · {project.price}</MetaChip>
          <MetaChip icon={Calendar}>Kicked off {project.kickoff}</MetaChip>
          {/* Moved here from the old Oversight card, which held nothing else but the cancel button. */}
          {isAdmin && (
            <MetaChip icon={Clock}>Last delivery activity: {project.lastActivity}</MetaChip>
          )}
          <MetaChip icon={FileText} link>
            View request
          </MetaChip>
        </div>
      </div>

      {cancelled ? (
        <div className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3.5 text-sm text-slate-800">
          <Ban size={18} className="mt-0.5 shrink-0 text-slate-500" />
          <p className="leading-relaxed">
            <span className="font-semibold">You cancelled this project on 25 Oct.</span> Reason: “
            {cancelled}”
          </p>
        </div>
      ) : (
        status === 'in_review' && (
          <div className="flex items-start gap-3 rounded-2xl border border-violet-200 bg-violet-50 px-4 py-3.5 text-sm text-violet-900">
            <Clock size={18} className="mt-0.5 shrink-0 text-violet-600" />
            <p className="leading-relaxed">
              <span className="font-semibold">
                {lens === 'client'
                  ? 'Charles says the project is ready.'
                  : "Waiting on Gemini Corp's review."}
              </span>{' '}
              Marked ready on {project.readyOn}
              {lens === 'client' ? '' : ' by Charles'}. If{' '}
              {lens === 'client' ? "you don't" : "Gemini Corp doesn't"} respond, it's accepted on{' '}
              {project.autoAcceptOn} and the final invoice is raised then.
            </p>
          </div>
        )
      )}

      <Card className="p-6">
        <p className="text-slate-500">
          <span className="mr-2 text-3xl font-semibold tracking-tight text-slate-900">2 of 2</span>
          milestones completed
        </p>
        <div className="mt-5 flex gap-1.5">
          <div className="h-2 flex-1 rounded-full bg-gradient-to-r from-blue-600 to-violet-600" />
          <div className="h-2 flex-1 rounded-full bg-gradient-to-r from-blue-600 to-violet-600" />
        </div>
        <p className="mt-4 text-sm text-slate-400">
          The rest of the page is unchanged — see project-delivery.jsx.
        </p>
      </Card>

      {dialog && (
        <CancelDialog
          project={project}
          onKeep={() => setDialog(false)}
          onConfirm={(reason) => {
            setCancelled(reason);
            setDialog(false);
          }}
        />
      )}
    </div>
  );
}

export default function ProjectCancelPrototype() {
  const lens = 'admin';
  const [status, setStatus] = useState('in_review');
  const [resetKey, setResetKey] = useState(0);

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
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <span className="text-sm font-semibold text-slate-400">Prototype</span>
            <span className="text-sm text-slate-500">Balo admin view</span>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-slate-500">Project</span>
              <Segmented
                value={status}
                onChange={setStatus}
                options={[
                  { value: 'active', label: 'In delivery' },
                  { value: 'in_review', label: 'Marked ready' },
                ]}
              />
            </div>
            <button
              type="button"
              onClick={() => setResetKey((k) => k + 1)}
              className="ml-auto inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
            >
              <RotateCcw size={14} />
              Reset
            </button>
          </div>
          <p className="mt-3 border-t border-slate-200 pt-3 text-xs leading-relaxed text-slate-500">
            Cancel lives in the ⋯ menu. Open it to see the confirmation.
          </p>
        </div>

        <div className="mt-8">
          <ProjectHeader key={`${lens}-${status}-${resetKey}`} lens={lens} status={status} />
        </div>
      </div>
    </div>
  );
}
