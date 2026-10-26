'use client';

import { useCallback, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ChevronLeft,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  Send,
  Trash2,
  Undo2,
} from 'lucide-react';
import { toast } from 'sonner';

import { BaloCard, baloCardClassName } from '@/components/balo/card/balo-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { saveChangeOrderAction } from '@/app/(dashboard)/engagements/[id]/_actions/save-change-order';
import { parseDollarsToCents, formatWholeCurrency } from '@/lib/utils/currency';
import {
  currencySymbol,
  formatHours,
  signedHours,
  signedMoney,
} from '@/lib/engagement/change-order-format';
import { ToneBanner, TonePill, type ChangeOrderTone } from './change-order-tone';
import {
  blankRow,
  composerIssues,
  countLines,
  estimateCostCents,
  estimateTotals,
  hoursInputToMinutes,
  linesFrom,
  rowState,
  rowsFor,
  withPrefillLine,
  type ComposerMilestone,
  type ComposerMilestoneStatus,
  type ComposerPricing,
  type ComposerRow,
  type ComposerRowState,
  type ComposerSavedLine,
} from './change-order-composer-state';

export interface ChangeOrderComposerOrder {
  id: string;
  status: 'requested' | 'draft';
  requestNote: string | null;
  /** The banner lead for a client request, e.g. "Dana @ Northwind asked on 15 Oct". */
  requestedHeading: string | null;
  note: string | null;
  priceDeltaCents: number | null;
  lines: ComposerSavedLine[];
}

interface ChangeOrderComposerProps {
  engagementId: string;
  pricingMethod: ComposerPricing;
  clientCompanyName: string;
  projectTitle: string;
  currency: string;
  /** The expert-side effective price right now: the price, or the cap on T&M. */
  currentPriceCents: number;
  /** T&M: the expert's hourly rate in cents, when the project has one. Ignored on fixed. */
  hourlyRateCents?: number | null;
  /** T&M: the value of the time already logged, in cents; the cap cannot be lowered below it. */
  loggedValueCents?: number | null;
  /**
   * T&M: minutes of live time logged per milestone. Removing a milestone with time is refused,
   * and so is changing its estimate to less than the time logged.
   */
  loggedMinutesByMilestone?: Readonly<Record<string, number>>;
  milestones: ComposerMilestone[];
  order: ChangeOrderComposerOrder | null;
  /** An attempted change to open with as an extra line, from the redirect link. */
  prefillLine?: ComposerSavedLine | null;
}

/** The hourly rate in whole currency units, or with cents when it is not a whole amount. */
function formatRate(cents: number, currency: string): string {
  if (cents % 100 === 0) return formatWholeCurrency(cents, currency);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

const NO_LOGGED_MINUTES: Readonly<Record<string, number>> = {};
const NOTE_MAX_LENGTH = 2000;
const TITLE_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 4000;

const MILESTONE_STATUS: Record<ComposerMilestoneStatus, { label: string; tone: ChangeOrderTone }> =
  {
    pending: { label: 'To do', tone: 'muted' },
    in_progress: { label: 'In progress', tone: 'info' },
    completed: { label: 'Completed', tone: 'success' },
  };

const ROW_BORDER: Record<ComposerRowState, string> = {
  unchanged: 'border-border',
  edited: 'border-info/40',
  new: 'border-success/40',
  removed: 'border-destructive/30 bg-destructive/5',
};

const ROW_PILL: Record<
  ComposerRowState,
  { label: string; tone: ChangeOrderTone; icon?: typeof Plus }
> = {
  unchanged: { label: 'Unchanged', tone: 'muted' },
  edited: { label: 'Edited', tone: 'info', icon: Pencil },
  new: { label: 'New', tone: 'success', icon: Plus },
  removed: { label: 'Removed', tone: 'destructive', icon: Trash2 },
};

interface RowCardProps {
  row: ComposerRow;
  pricing: ComposerPricing;
  onPatch: (key: string, patch: Partial<ComposerRow>) => void;
  onDiscard: (key: string) => void;
}

function RowCard({ row, pricing, onPatch, onDiscard }: Readonly<RowCardProps>): React.JSX.Element {
  const state = rowState(row, pricing);
  const pill = ROW_PILL[state];
  const rowStatus = MILESTONE_STATUS[row.status];
  const { key, orig } = row;

  const setTitle = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void =>
      onPatch(key, { title: event.target.value }),
    [key, onPatch]
  );
  const setDescription = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>): void =>
      onPatch(key, { description: event.target.value }),
    [key, onPatch]
  );
  const setHours = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void =>
      onPatch(key, { hours: event.target.value }),
    [key, onPatch]
  );
  const markRemoved = useCallback((): void => onPatch(key, { removed: true }), [key, onPatch]);
  const keepIt = useCallback((): void => onPatch(key, { removed: false }), [key, onPatch]);
  const discard = useCallback((): void => onDiscard(key), [key, onDiscard]);

  const estimateChanged =
    orig !== null &&
    orig.estimatedMinutes !== null &&
    hoursInputToMinutes(row.hours) !== orig.estimatedMinutes;

  return (
    <div className={cn('rounded-xl border p-4', ROW_BORDER[state])}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <TonePill tone={pill.tone} icon={pill.icon}>
            {pill.label}
          </TonePill>
          {!row.isNew && <TonePill tone={rowStatus.tone}>{rowStatus.label}</TonePill>}
        </div>
        {row.isNew && (
          <Button type="button" variant="ghost" size="sm" onClick={discard}>
            <Trash2 className="size-3.5" aria-hidden />
            Discard
          </Button>
        )}
        {!row.isNew && row.removed && (
          <Button type="button" variant="ghost" size="sm" onClick={keepIt}>
            <Undo2 className="size-3.5" aria-hidden />
            Keep it
          </Button>
        )}
        {!row.isNew && !row.removed && (
          <Button type="button" variant="ghost" size="sm" onClick={markRemoved}>
            <Trash2 className="size-3.5" aria-hidden />
            Remove
          </Button>
        )}
      </div>

      {row.removed ? (
        <div>
          <p className="text-muted-foreground font-medium line-through">{orig?.title}</p>
          {row.status === 'completed' && (
            <p className="text-destructive mt-1 text-xs">This milestone is already completed.</p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <Input
            value={row.title}
            onChange={setTitle}
            maxLength={TITLE_MAX_LENGTH}
            placeholder="Milestone name"
            aria-label="Milestone name"
            className="font-medium"
          />
          <Textarea
            rows={2}
            value={row.description}
            onChange={setDescription}
            maxLength={DESCRIPTION_MAX_LENGTH}
            placeholder="What's delivered"
            aria-label="Description"
          />
          {pricing === 'tm' && (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="number"
                min="0.5"
                step="0.5"
                value={row.hours}
                onChange={setHours}
                aria-label="Estimate in hours"
                className="w-24"
              />
              <span className="text-muted-foreground text-sm">hrs estimated</span>
              {estimateChanged &&
                orig?.estimatedMinutes !== undefined &&
                orig.estimatedMinutes !== null && (
                  <span className="text-muted-foreground text-xs">
                    was {formatHours(orig.estimatedMinutes)}
                  </span>
                )}
            </div>
          )}
          {state === 'edited' && orig !== null && row.description.trim() !== orig.description && (
            <p className="text-muted-foreground text-xs leading-relaxed">
              Was: <span className="line-through">{orig.description || '—'}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The change-order composer (amendment mode): a pre-filled copy of the live plan in which each
 * milestone is Unchanged, Edited, New or Removed, plus the price (fixed) or estimate (T&M)
 * effect. "Save draft" keeps it private to the expert; "Send" puts it in front of the client
 * and nothing changes until they approve. The server re-checks every rule shown here.
 */
export function ChangeOrderComposer({
  engagementId,
  pricingMethod,
  clientCompanyName,
  projectTitle,
  currency,
  currentPriceCents,
  hourlyRateCents = null,
  loggedValueCents = null,
  loggedMinutesByMilestone = NO_LOGGED_MINUTES,
  milestones,
  order,
  prefillLine,
}: Readonly<ChangeOrderComposerProps>): React.JSX.Element {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const keyCounter = useRef(0);
  const newKey = useCallback((): string => {
    keyCounter.current += 1;
    return `new-${keyCounter.current}`;
  }, []);

  const [rows, setRows] = useState<ComposerRow[]>(() =>
    rowsFor(milestones, withPrefillLine(order?.lines ?? [], prefillLine ?? null), newKey)
  );
  const [note, setNote] = useState(order?.note ?? '');
  const [totalInput, setTotalInput] = useState(() =>
    String((currentPriceCents + (order?.priceDeltaCents ?? 0)) / 100)
  );
  const savedOrderId = useRef<string | undefined>(order?.id);
  const [attempted, setAttempted] = useState(false);

  const isFixed = pricingMethod === 'fixed';
  const lines = useMemo(() => linesFrom(rows, pricingMethod), [rows, pricingMethod]);
  const counts = useMemo(() => countLines(lines), [lines]);
  const totalCents = parseDollarsToCents(totalInput);
  const priceDeltaCents = totalCents === null ? 0 : totalCents - currentPriceCents;
  const issues = useMemo(
    () =>
      composerIssues({
        pricing: pricingMethod,
        note,
        lines,
        priceDeltaCents,
        priceValid: totalCents !== null,
        loggedValueCents,
        nextCapCents: totalCents ?? currentPriceCents,
        currency,
        milestones,
        loggedMinutesByMilestone,
      }),
    [
      pricingMethod,
      note,
      lines,
      priceDeltaCents,
      totalCents,
      loggedValueCents,
      currentPriceCents,
      currency,
      milestones,
      loggedMinutesByMilestone,
    ]
  );
  const estimates = useMemo(() => estimateTotals(milestones, rows), [milestones, rows]);
  const estimateCostCap = estimateCostCents(hourlyRateCents, estimates.nextMinutes);
  const capShortfall =
    !isFixed && estimateCostCap !== null && estimateCostCap > (totalCents ?? currentPriceCents);

  const patchRow = useCallback((key: string, patch: Partial<ComposerRow>): void => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }, []);
  const discardRow = useCallback((key: string): void => {
    setRows((current) => current.filter((row) => row.key !== key));
  }, []);
  const addRow = useCallback((): void => {
    setRows((current) => [...current, blankRow(newKey())]);
  }, [newKey]);
  const changeNote = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>): void => setNote(event.target.value),
    []
  );
  const changeTotal = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => setTotalInput(event.target.value),
    []
  );
  const priceKind = isFixed ? 'price' : 'cap';
  const priceNote =
    totalCents !== null && priceDeltaCents !== 0
      ? `That's ${signedMoney(priceDeltaCents, currency)}.`
      : `Leave it to keep the ${priceKind}.`;
  const raiseCap = useCallback((): void => {
    if (estimateCostCap !== null) setTotalInput(String(estimateCostCap / 100));
  }, [estimateCostCap]);

  const workspaceHref = `/engagements/${engagementId}`;
  const submit = useCallback(
    (send: boolean): void => {
      if (send) {
        setAttempted(true);
        if (issues.length > 0) return;
      } else if (lines.some((line) => line.title === '')) {
        toast.error('Give each milestone a name before saving.');
        return;
      }
      startTransition(async () => {
        const result = await saveChangeOrderAction({
          engagementId,
          ...(savedOrderId.current === undefined ? {} : { orderId: savedOrderId.current }),
          note: note.trim(),
          ...(totalCents === null ? {} : { newTotalCents: totalCents }),
          lines,
          send,
        });
        if (result.changeOrderId !== undefined) savedOrderId.current = result.changeOrderId;
        if (!result.success) {
          toast.error(result.error);
          if (result.changeOrderId !== undefined) router.refresh();
          return;
        }
        toast.success(
          send
            ? `Sent to ${clientCompanyName}. Nothing changes until they approve.`
            : 'Draft saved.'
        );
        router.push(workspaceHref);
      });
    },
    [clientCompanyName, engagementId, issues.length, lines, note, router, totalCents, workspaceHref]
  );
  const send = useCallback((): void => submit(true), [submit]);
  const saveDraft = useCallback((): void => submit(false), [submit]);

  const showIssues = attempted && issues.length > 0;

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={workspaceHref}
          className="text-muted-foreground hover:text-foreground mb-3 inline-flex items-center gap-1 text-sm"
        >
          <ChevronLeft className="size-4" aria-hidden />
          Back to project
        </Link>
        <h1 className="text-foreground text-2xl font-semibold tracking-tight">Propose a change</h1>
        <p className="text-muted-foreground mt-1">{projectTitle}</p>
      </div>

      {order !== null && order.requestNote !== null && order.requestNote !== '' && (
        <ToneBanner tone="warning" icon={MessageSquare} label="Change request">
          <span className="font-semibold">{order.requestedHeading ?? 'Your client asked'}:</span> “
          {order.requestNote}”
        </ToneBanner>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          <BaloCard className="p-5">
            <Label htmlFor="change-order-note" className="text-sm font-medium">
              What&apos;s changing and why
            </Label>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {clientCompanyName} reads this word for word. Describe the change, and leave amounts
              to the {isFixed ? 'price' : 'cap'} box.
            </p>
            <Textarea
              id="change-order-note"
              rows={3}
              maxLength={NOTE_MAX_LENGTH}
              value={note}
              onChange={changeNote}
              className="mt-2"
              placeholder="e.g. Adds a marketing dashboard, as requested, and extends lead routing to marketing leads."
            />
          </BaloCard>

          <BaloCard className="p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-foreground text-sm font-semibold">Milestones</h2>
              <span className="text-muted-foreground text-xs">
                Edit, add or remove. The difference is what {clientCompanyName} approves.
              </span>
            </div>
            {rows.length === 0 && (
              <p className="text-muted-foreground mb-3 text-sm">
                Add the first milestone this change brings in.
              </p>
            )}
            <div className="space-y-3">
              {rows.map((row) => (
                <RowCard
                  key={row.key}
                  row={row}
                  pricing={pricingMethod}
                  onPatch={patchRow}
                  onDiscard={discardRow}
                />
              ))}
            </div>
            <Button type="button" variant="outline" size="sm" className="mt-3" onClick={addRow}>
              <Plus className="size-3.5" aria-hidden />
              Add a milestone
            </Button>
          </BaloCard>
        </div>

        <aside
          aria-label="Summary of the change"
          className={cn(baloCardClassName(), 'p-5 lg:sticky lg:top-6')}
        >
          <h2 className="text-foreground text-sm font-semibold">The change</h2>
          <ul className="text-muted-foreground mt-3 space-y-1.5 text-sm">
            <li>{counts.added} added</li>
            <li>{counts.edited} edited</li>
            <li>{counts.removed} removed</li>
          </ul>

          {!isFixed && (
            <div className="border-border mt-4 border-t pt-4 text-sm">
              <p className="text-foreground font-medium">Estimate</p>
              <p className="text-muted-foreground mt-1">
                {formatHours(estimates.currentMinutes)} → {formatHours(estimates.nextMinutes)} (
                {signedHours(estimates.nextMinutes - estimates.currentMinutes)})
              </p>
            </div>
          )}

          <div className="border-border mt-4 border-t pt-4">
            <Label htmlFor="change-order-price" className="text-sm font-medium">
              {isFixed ? 'Project price' : 'Cap'}
            </Label>
            <div className="mt-1.5 flex items-center gap-2">
              <span className="text-muted-foreground text-sm">{currencySymbol(currency)}</span>
              <Input
                id="change-order-price"
                type="number"
                min="0"
                step="50"
                value={totalInput}
                onChange={changeTotal}
              />
            </div>
            <p className="text-muted-foreground mt-1.5 text-xs">
              Currently {formatWholeCurrency(currentPriceCents, currency)}. {priceNote}
            </p>
            {capShortfall && estimateCostCap !== null && hourlyRateCents !== null && (
              <div
                role="status"
                className="border-warning/25 bg-warning/10 text-foreground mt-2 space-y-2 rounded-xl border p-3 text-xs leading-relaxed"
              >
                <p>
                  At {formatRate(hourlyRateCents, currency)}/hr the new estimate comes to{' '}
                  {formatWholeCurrency(estimateCostCap, currency)}, above the{' '}
                  {formatWholeCurrency(totalCents ?? currentPriceCents, currency)} cap. Raise the
                  cap so the approved scope can be billed.
                </p>
                <Button type="button" variant="outline" size="sm" onClick={raiseCap}>
                  Raise cap to {formatWholeCurrency(estimateCostCap, currency)}
                </Button>
              </div>
            )}
          </div>

          {showIssues && (
            <ul
              aria-label="Fix before sending"
              className="border-destructive/30 bg-destructive/10 text-destructive mt-4 space-y-1 rounded-xl border p-3 text-xs"
            >
              {issues.map((issue) => (
                <li key={issue} className="flex items-start gap-1.5">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
                  {issue}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 flex flex-col gap-2">
            <Button type="button" disabled={isPending} onClick={send}>
              {isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Send className="size-4" aria-hidden />
              )}
              Send to {clientCompanyName}
            </Button>
            <Button type="button" variant="outline" disabled={isPending} onClick={saveDraft}>
              Save draft
            </Button>
            <Button type="button" variant="ghost" asChild>
              <Link href={workspaceHref}>Cancel</Link>
            </Button>
          </div>
          <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
            Nothing changes until {clientCompanyName} approves. While it&apos;s waiting, the project
            can&apos;t be marked ready.
          </p>
        </aside>
      </div>
    </div>
  );
}
