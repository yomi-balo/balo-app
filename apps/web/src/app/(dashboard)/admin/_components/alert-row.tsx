'use client';

import { useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  ChevronDown,
  Clock,
  RotateCw,
  User,
  Lock,
  ExternalLink,
  Check,
  type LucideIcon,
  UserPlus,
  CreditCard,
  Receipt,
  AlertTriangle,
  RotateCcw,
  Film,
  FileText,
  CalendarClock,
  CalendarX,
  AlertOctagon,
  Layers,
  Building2,
  Wallet,
  Video,
  Activity,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { track, ADMIN_ALERTS_EVENTS } from '@/lib/analytics';
import { adminAlertAgeBucket, type AdminQueueRowView } from '../_lib/admin-queue-view';
import {
  ADMIN_ALERT_GROUPS,
  ADMIN_ALERT_NOTE_MIN,
  type AdminAlertGroup,
} from '@balo/shared/admin-alerts';
import { closeAdminAlert } from '../_actions/close-admin-alert';

/**
 * BAL-548 / ADR-1055 — one queue row (design reference `AlertRow`, `admin-home.jsx:1464`).
 *
 * ⚠ The kind→icon and entityType→icon maps below are a WEB-ONLY presentational choice — the
 * shipped registry (`@balo/shared/admin-alerts`) deliberately carries no `icon` field (it is
 * pure vocabulary + policy, no React/Lucide dependency). A kind absent from `KIND_ICONS` (a
 * future kind, or the "unresolved kind" fallback) falls back to `Layers`, matching the design
 * prototype's own fallback.
 */
const KIND_ICONS: Readonly<Record<string, LucideIcon>> = {
  'expert.application_pending': UserPlus,
  'receivable.open': CreditCard,
  'session.settled_no_ledger_credit': Receipt,
  'topup.unresolved_pi': AlertTriangle,
  'topup.partial_refund': RotateCcw,
  'session.open_refused': AlertTriangle,
  'recording.failed': Film,
  'transcript.failed': FileText,
  'transcript_capture.withheld_source': Clock,
  'calendar.subscription_lapse': CalendarClock,
  'calendar.amend_failed': CalendarX,
  'sweep.failed': AlertOctagon,
};

const ENTITY_ICONS: Readonly<Record<string, LucideIcon>> = {
  expert: User,
  company: Building2,
  wallet: Wallet,
  session: Clock,
  meeting: CalendarClock,
  recording: Video,
  transcript: FileText,
  calendar: CalendarClock,
  sweep: Activity,
};

const GROUP_TONE: Readonly<
  Record<AdminAlertGroup, { readonly text: string; readonly bg: string }>
> = {
  marketplace: { text: 'text-primary', bg: 'bg-primary/10' },
  money: { text: 'text-warning', bg: 'bg-warning/10' },
  capture: { text: 'text-violet', bg: 'bg-violet/10' },
  meetings: { text: 'text-info', bg: 'bg-info/10' },
  platform: { text: 'text-muted-foreground', bg: 'bg-muted' },
};

/**
 * BAL-548 fix round (B-F4) — the per-row group label (design reference `admin-home.jsx:1584`:
 * `!mobile && <Pill>{g.label}</Pill>`). `ADMIN_ALERT_GROUPS` only names the four TILE groups
 * (`@balo/shared/admin-alerts`'s own docblock: "FIVE GROUPS EXIST, FOUR HAVE TILES") — the
 * fifth, `platform`, has no tile but still reaches a row (`sweep.failed`), so it needs a label
 * here even though it has none in the shared vocabulary.
 */
const GROUP_LABEL: Readonly<Record<AdminAlertGroup, string>> = {
  marketplace: ADMIN_ALERT_GROUPS.marketplace.label,
  money: ADMIN_ALERT_GROUPS.money.label,
  capture: ADMIN_ALERT_GROUPS.capture.label,
  meetings: ADMIN_ALERT_GROUPS.meetings.label,
  platform: 'Platform',
};

function MoneyBlock({
  money,
}: Readonly<{ money: NonNullable<AdminQueueRowView['money']> }>): React.JSX.Element {
  const rows: readonly [string, string | null][] = [
    ['Client all-in', money.client],
    ...(money.extra === undefined ? [] : [money.extra as [string, string]]),
    ['Expert earnings', money.expert],
    [
      'Balo margin',
      money.margin !== null && money.markup !== null
        ? `${money.margin} (${money.markup} markup)`
        : null,
    ],
  ];
  return (
    <div className="border-warning/40 bg-warning/10 rounded-xl border p-3">
      <div className="mb-2 flex items-center gap-1.5">
        <CreditCard className="text-warning size-3" aria-hidden="true" />
        <span className="text-warning text-[11px] font-bold tracking-wide uppercase">Money</span>
        <span className="text-muted-foreground text-[11px]">
          · from the rate snapshots on the row
        </span>
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <span className="text-muted-foreground text-[12.5px]">{label}</span>
            {value === null ? (
              <span className="text-muted-foreground inline-flex items-center justify-end gap-1 text-[11.5px]">
                <Lock className="size-2.5" aria-hidden="true" />
                Needs fee visibility
              </span>
            ) : (
              <span className="text-foreground text-right text-[12.5px] font-semibold tabular-nums">
                {value}
              </span>
            )}
          </div>
        ))}
      </div>
      {rows.some(([, value]) => value === null) && (
        <p className="text-muted-foreground mt-2 text-[11px] leading-relaxed">
          Expert earnings and margin render only for holders of MANAGE_PLATFORM_FEES.
        </p>
      )}
    </div>
  );
}

interface AlertRowProps {
  readonly row: AdminQueueRowView;
  readonly index: number;
  readonly last: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly canResolve: boolean;
  readonly onClosed: (alertId: string) => void;
}

export function AlertRow({
  row,
  index,
  last,
  expanded,
  onToggle,
  canResolve,
  onClosed,
}: Readonly<AlertRowProps>): React.JSX.Element {
  const [closing, setClosing] = useState(false);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);

  const KindIcon = KIND_ICONS[row.kind] ?? Layers;
  const EntityIcon = ENTITY_ICONS[row.entityType] ?? Layers;
  const tone = GROUP_TONE[row.group];

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onToggle();
    }
  }

  async function handleClose(): Promise<void> {
    setPending(true);
    try {
      const result = await closeAdminAlert({ alertId: row.id, note });
      if (result.success) {
        toast.success('Closed — the note is on the record.');
        // BAL-548 analytics — CLIENT-side, fired after the Server Action confirms success (a
        // refused close, per the discriminated `reason`, is not a close).
        track(ADMIN_ALERTS_EVENTS.ALERT_CLOSED, {
          kind: row.kind,
          age_bucket: adminAlertAgeBucket(row.ageDays),
        });
        onClosed(row.id);
      } else {
        toast.error(result.error);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className={cn(
        'animate-in fade-in transition-colors motion-reduce:animate-none',
        !last && 'border-border border-b',
        expanded && 'bg-primary/5'
      )}
      style={{ animationDelay: `${60 + index * 30}ms` }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={handleKeyDown}
        aria-expanded={expanded}
        className="focus-visible:ring-ring hover:bg-muted/40 flex min-h-11 cursor-pointer items-start gap-3 p-4 focus-visible:ring-2 focus-visible:outline-none"
      >
        <div
          className={cn(
            'flex size-[30px] shrink-0 items-center justify-center rounded-lg',
            tone.bg
          )}
        >
          <KindIcon className={cn('size-3.5', tone.text)} aria-hidden="true" />
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-foreground text-sm leading-snug font-bold">{row.title}</p>
          <p className="text-muted-foreground mt-1 flex items-center gap-1.5 text-[12.5px] font-semibold">
            <EntityIcon className="size-3" aria-hidden="true" />
            {row.entityLabel}
          </p>
          <p className="text-muted-foreground mt-1 text-[12.5px] leading-relaxed">{row.evidence}</p>
          <p className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-1.5 text-[11.5px]">
            <span>First seen {row.ageLabel} ago</span>
            {row.occurrences > 1 && (
              <>
                <span className="text-border">·</span>
                <span>raised {row.occurrences}×</span>
              </>
            )}
            <span className="text-border">·</span>
            {row.selfCloses ? (
              <span className="text-success inline-flex items-center gap-1">
                <RotateCw className="size-2.5" aria-hidden="true" />
                {row.closes}
              </span>
            ) : (
              <span className="text-warning inline-flex items-center gap-1">
                <User className="size-2.5" aria-hidden="true" />
                {row.closes}
              </span>
            )}
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Badge
            variant="outline"
            className={cn('hidden border-transparent md:inline-flex', tone.text, tone.bg)}
          >
            {GROUP_LABEL[row.group]}
          </Badge>
          <span
            className={cn(
              'inline-flex items-center gap-1 text-[15px] font-extrabold tabular-nums',
              row.ageEmphasised ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            <Clock className="size-3" aria-hidden="true" />
            {row.ageLabel}
          </span>
        </div>
        <ChevronDown
          className={cn(
            'text-muted-foreground mt-1 size-4 shrink-0 transition-transform',
            expanded && 'rotate-180'
          )}
          aria-hidden="true"
        />
      </div>

      {expanded && (
        <div className="px-4 pb-4 pl-[60px]">
          <div className={cn('grid gap-3.5', row.money !== null && 'md:grid-cols-[1.2fr_1fr]')}>
            <div className="grid gap-x-4 gap-y-2 md:grid-cols-2">
              {row.facts.map(([label, value]) => (
                <div key={label}>
                  <p className="text-muted-foreground text-[11px] font-bold tracking-wide uppercase">
                    {label}
                  </p>
                  <p className="text-foreground mt-0.5 text-[12.5px] leading-relaxed">{value}</p>
                </div>
              ))}
            </div>
            {row.money !== null && <MoneyBlock money={row.money} />}
          </div>

          <div className="mt-3.5 flex flex-wrap items-center gap-2.5">
            <Button asChild size="sm">
              <Link
                href={row.target.href}
                onClick={() =>
                  track(ADMIN_ALERTS_EVENTS.ALERT_OPENED, {
                    kind: row.kind,
                    age_bucket: adminAlertAgeBucket(row.ageDays),
                  })
                }
              >
                <ExternalLink className="size-3.5" aria-hidden="true" />
                Open {row.target.label}
              </Link>
            </Button>
            {row.noteCloseable && !closing && (
              <Button
                variant="ghost"
                size="sm"
                disabled={!canResolve}
                title={canResolve ? undefined : 'Closing needs the resolve-alerts capability'}
                onClick={() => setClosing(true)}
              >
                <Check className="size-3.5" aria-hidden="true" />
                Close with a note
              </Button>
            )}
            {row.selfCloses && (
              <span className="text-muted-foreground text-xs">
                No manual close — a sweep closes this when the condition clears.
              </span>
            )}
          </div>

          {closing && (
            <div className="mt-3">
              <Textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="What was done, and why this can close — this note is the audit row"
                aria-label="What was done, and why this can close"
                rows={2}
              />
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  disabled={note.trim().length < ADMIN_ALERT_NOTE_MIN || pending}
                  onClick={() => void handleClose()}
                >
                  <Check className="size-3.5" aria-hidden="true" />
                  Close
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setClosing(false)}
                  disabled={pending}
                >
                  Keep open
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
