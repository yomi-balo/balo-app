'use client';

import { useCallback, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Check,
  ClipboardCheck,
  Clock,
  Loader2,
  PartyPopper,
  Receipt,
  ShieldCheck,
  User,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import type { KickoffBillingCapture } from '@/lib/billing/billing-capture';
import { RequestCard } from '../request-card';
import { ClientBillingAffordance } from './billing-details-dialog';
import { completeKickoffTaskAction } from '@/app/(dashboard)/projects/[requestId]/_actions/complete-kickoff-task';
import { approveKickoffAction } from '@/app/(dashboard)/projects/[requestId]/_actions/approve-kickoff';

/** The viewer lens — selects which row is "yours" and which action it fires. */
type KickoffLens = 'client' | 'expert' | 'admin';

interface KickoffBoardProps {
  requestId: string;
  acceptedRelationshipId: string;
  lens: KickoffLens;
  clientBillingConfirmed: boolean;
  expertTermsConfirmed: boolean;
  approved: boolean;
  expertName: string;
  /**
   * Client billing-capture context (BAL-323). Non-null ONLY for the client lens —
   * drives the client row's capture form / member notice. `null` for expert/admin.
   */
  billing?: KickoffBillingCapture | null;
  /** Tightens padding for the mobile bottom-sheet mount. */
  mobile?: boolean;
}

/** One checklist row's static identity — the dynamic `done` is derived per render. */
interface KickoffTaskDef {
  party: KickoffLens;
  label: string;
  doneCopy: string;
  outstandingCopy: string;
  icon: LucideIcon;
}

/**
 * The three kickoff gates, data-driven (never copy-pasted branches). Sub-copy is
 * generic — it never fabricates specific amounts, POs, or invoice numbers (those
 * are not in the view-model). Row order is client → expert → admin, mirroring the
 * dependency chain (admin settles only once both parties are ready).
 */
const KICKOFF_TASKS: readonly KickoffTaskDef[] = [
  {
    party: 'client',
    label: 'Add billing details',
    doneCopy: 'Billing details added',
    outstandingCopy: 'Add your billing details',
    icon: User,
  },
  {
    party: 'expert',
    label: 'Confirm payment terms',
    doneCopy: 'Payment terms confirmed',
    outstandingCopy: 'Confirm the payment terms',
    icon: ShieldCheck,
  },
  {
    party: 'admin',
    label: 'Raise & settle upfront invoice',
    doneCopy: 'Upfront invoice settled',
    outstandingCopy: 'Settle the upfront invoice to approve',
    icon: Receipt,
  },
] as const;

/** Resolved per-row state the renderer reads (keeps the JSX free of branches). */
interface KickoffRow extends KickoffTaskDef {
  done: boolean;
  mine: boolean;
  sub: string;
}

/** The action label for the viewer's own outstanding row. */
function actionLabelFor(party: KickoffLens): 'Complete' | 'Approve' {
  return party === 'admin' ? 'Approve' : 'Complete';
}

/** Notice shown on the client billing row for a member who can't complete it (never absence-framed). */
const MEMBER_BLOCKED_SUB =
  'A company owner or admin needs to add these billing details before kickoff.';

/** A row's sub-copy: the member notice for a blocked billing row, else done/outstanding. */
function rowSubCopy(task: KickoffTaskDef, done: boolean, blocked: boolean): string {
  if (blocked) return MEMBER_BLOCKED_SUB;
  return done ? task.doneCopy : task.outstandingCopy;
}

export function KickoffBoard({
  requestId,
  acceptedRelationshipId,
  lens,
  clientBillingConfirmed,
  expertTermsConfirmed,
  approved,
  expertName,
  billing = null,
  mobile = false,
}: Readonly<KickoffBoardProps>): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // Per-party done flags. Admin "done" IS approval (no separate persisted gate).
  const doneByParty: Record<KickoffLens, boolean> = {
    client: clientBillingConfirmed,
    expert: expertTermsConfirmed,
    admin: approved,
  };
  const doneCount = [clientBillingConfirmed, expertTermsConfirmed, approved].filter(Boolean).length;

  // Admin can only fire once both participant gates are in (the server enforces
  // this too — but never offer the admin a doomed click).
  const adminGatesReady = clientBillingConfirmed && expertTermsConfirmed;

  // A client-lens MEMBER (not owner/admin) is blocked from the outstanding billing
  // step — its row gets a "what happens next" notice. The blocked-VIEW analytics is
  // fired once from a single page-level tracker (see request-detail-shell), NOT here:
  // the board mounts twice per client (desktop + mobile sheet), so firing from the
  // component would over-count.
  const memberBlocked =
    lens === 'client' && !clientBillingConfirmed && billing !== null && !billing.canManage;

  const rows: KickoffRow[] = KICKOFF_TASKS.map((task) => {
    const done = doneByParty[task.party];
    const blockedHere = task.party === 'client' && memberBlocked;
    return {
      ...task,
      done,
      mine: task.party === lens,
      sub: rowSubCopy(task, done, blockedHere),
    };
  });

  const handleComplete = useCallback((): void => {
    if (pending) return;
    startTransition(() => {
      void (async (): Promise<void> => {
        const result = await completeKickoffTaskAction({
          requestId,
          relationshipId: acceptedRelationshipId,
        });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        // Expert-only now — the client's billing gate is confirmed by the billing
        // form (BAL-323), which emits its own `billing_details_submitted` event.
        track(PROJECT_EVENTS.PROJECT_KICKOFF_GATE_CONFIRMED, {
          request_id: requestId,
          relationship_id: acceptedRelationshipId,
          gate: result.gate,
          actor: 'expert',
        });
        toast.success('Marked as done');
        router.refresh();
      })();
    });
  }, [pending, requestId, acceptedRelationshipId, router]);

  const handleApprove = useCallback((): void => {
    if (pending) return;
    startTransition(() => {
      void (async (): Promise<void> => {
        const result = await approveKickoffAction({
          requestId,
          relationshipId: acceptedRelationshipId,
        });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        track(PROJECT_EVENTS.PROJECT_KICKOFF_APPROVED, {
          request_id: requestId,
          actor: 'admin',
        });
        track(PROJECT_EVENTS.PROJECT_REQUEST_STATUS_TRANSITIONED, {
          request_id: requestId,
          from: 'accepted',
          to: 'kickoff_approved',
          actor: 'admin',
        });
        toast.success('Kickoff approved — engagement created');
        router.refresh();
      })();
    });
  }, [pending, requestId, acceptedRelationshipId, router]);

  return (
    <div className="flex flex-col gap-4">
      {approved && <KickoffCelebration />}

      <RequestCard className={cn(mobile ? 'p-4' : 'p-6')}>
        <div className="mb-1 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="bg-primary/10 border-primary/20 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border">
              <ClipboardCheck className="text-primary h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <h3 className="text-foreground text-sm font-semibold">What&apos;s blocking kickoff</h3>
          </div>
          <span
            className={cn(
              'shrink-0 text-xs font-semibold tabular-nums',
              doneCount === 3 ? 'text-success' : 'text-muted-foreground'
            )}
          >
            {doneCount}/3 ready
          </span>
        </div>
        <p className="text-muted-foreground mb-4 text-[12.5px] leading-relaxed">
          Everyone sees the same checklist — so no one&apos;s left wondering who they&apos;re
          waiting on.
        </p>

        <ul className="flex flex-col gap-2.5">
          {rows.map((row) => (
            <KickoffRowItem
              key={row.party}
              row={row}
              lens={lens}
              expertName={expertName}
              pending={pending}
              adminGatesReady={adminGatesReady}
              billing={billing}
              requestId={requestId}
              relationshipId={acceptedRelationshipId}
              onComplete={handleComplete}
              onApprove={handleApprove}
            />
          ))}
        </ul>
      </RequestCard>
    </div>
  );
}

/** The celebratory terminal banner — rendered above the board once approved. */
function KickoffCelebration(): React.JSX.Element {
  return (
    <div className="border-success/30 from-success/10 to-success/[0.03] flex items-start gap-3 rounded-2xl border bg-gradient-to-br p-5">
      <span className="bg-success/15 border-success/30 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border">
        <PartyPopper className="text-success h-5 w-5" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="text-foreground text-[15px] font-semibold">Project kicked off 🎉</p>
        <p className="text-muted-foreground mt-0.5 text-sm leading-relaxed">
          This is now a live engagement — it&apos;s left the request pipeline and entered delivery.
        </p>
      </div>
    </div>
  );
}

interface KickoffRowItemProps {
  row: KickoffRow;
  lens: KickoffLens;
  expertName: string;
  pending: boolean;
  adminGatesReady: boolean;
  billing: KickoffBillingCapture | null;
  requestId: string;
  relationshipId: string;
  onComplete: () => void;
  onApprove: () => void;
}

/**
 * One checklist row. Renders the status badge, the party icon, the label + "You"
 * pill, the generic sub-copy, and the trailing affordance (action button for the
 * viewer's own outstanding row, "Waiting" for someone else's, "Done" once met).
 * The client's own billing row swaps the generic affordance for the BAL-323 capture
 * flow (form / member notice / view-edit).
 */
function KickoffRowItem({
  row,
  lens,
  expertName,
  pending,
  adminGatesReady,
  billing,
  requestId,
  relationshipId,
  onComplete,
  onApprove,
}: Readonly<KickoffRowItemProps>): React.JSX.Element {
  const RowIcon = row.icon;
  const highlight = row.mine && !row.done;
  // The client's billing row (client lens only) owns the capture flow.
  const isClientBillingRow = lens === 'client' && row.party === 'client' && billing !== null;

  return (
    <li
      // `aria-current="step"` ties the visual emphasis of the viewer's own
      // outstanding row (ring + "You" pill) to the assistive-tech tree.
      aria-current={highlight ? 'step' : undefined}
      className={cn(
        'flex items-center gap-3 rounded-xl border p-3.5',
        highlight
          ? 'border-primary/40 bg-primary/5 ring-primary/10 ring-2'
          : 'border-border bg-card'
      )}
    >
      <StatusBadge done={row.done} />

      <span
        className="bg-muted/60 border-border flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border"
        aria-hidden="true"
      >
        <RowIcon className="text-muted-foreground h-3.5 w-3.5" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-foreground text-sm font-medium">{row.label}</p>
          {row.mine && (
            <span className="text-primary bg-primary/10 border-primary/20 inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase">
              You
            </span>
          )}
        </div>
        <p className="text-muted-foreground mt-0.5 text-[12.5px] leading-relaxed">{row.sub}</p>
      </div>

      {isClientBillingRow && billing !== null ? (
        <ClientBillingAffordance
          done={row.done}
          canManage={billing.canManage}
          requestId={requestId}
          relationshipId={relationshipId}
          details={billing.details}
        />
      ) : (
        <RowAffordance
          row={row}
          expertName={expertName}
          pending={pending}
          adminGatesReady={adminGatesReady}
          onComplete={onComplete}
          onApprove={onApprove}
        />
      )}
    </li>
  );
}

/** The leading circular status badge — a check on success, a clock when pending. */
function StatusBadge({ done }: Readonly<{ done: boolean }>): React.JSX.Element {
  if (done) {
    return (
      <span
        className="from-success to-success/80 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br"
        aria-hidden="true"
      >
        <Check className="h-3.5 w-3.5 text-white" />
      </span>
    );
  }
  return (
    <span
      className="bg-muted border-border flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2"
      aria-hidden="true"
    >
      <Clock className="text-muted-foreground h-3.5 w-3.5" />
    </span>
  );
}

interface RowAffordanceProps {
  row: KickoffRow;
  expertName: string;
  pending: boolean;
  adminGatesReady: boolean;
  onComplete: () => void;
  onApprove: () => void;
}

/**
 * The trailing affordance for a row. Three terminal cases (done → "Done"; not
 * mine → "Waiting"; mine + outstanding → action button) selected via early
 * returns — no nested ternaries.
 */
function RowAffordance({
  row,
  expertName,
  pending,
  adminGatesReady,
  onComplete,
  onApprove,
}: Readonly<RowAffordanceProps>): React.JSX.Element {
  if (row.done) {
    return <span className="text-success shrink-0 text-xs font-semibold">Done</span>;
  }

  if (!row.mine) {
    return <span className="text-warning shrink-0 text-xs font-semibold">Waiting</span>;
  }

  // The viewer's own outstanding row → the action button.
  if (row.party === 'admin') {
    const disabled = pending || !adminGatesReady;
    const hint = adminGatesReady
      ? `Approve kickoff for ${expertName}`
      : 'Waiting on client & expert';
    return (
      <KickoffActionButton
        label="Approve"
        onClick={onApprove}
        disabled={disabled}
        spinning={pending}
        title={hint}
        ariaLabel={`${actionLabelFor('admin')} — ${hint}`}
      />
    );
  }

  return (
    <KickoffActionButton
      label="Complete"
      onClick={onComplete}
      disabled={pending}
      spinning={pending}
      ariaLabel={`${actionLabelFor(row.party)} ${row.label}`}
    />
  );
}

interface KickoffActionButtonProps {
  label: 'Complete' | 'Approve';
  onClick: () => void;
  disabled: boolean;
  spinning: boolean;
  title?: string;
  ariaLabel: string;
}

/** The row's primary action — a compact, accessible, spinner-aware button. */
function KickoffActionButton({
  label,
  onClick,
  disabled,
  spinning,
  title,
  ariaLabel,
}: Readonly<KickoffActionButtonProps>): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      className="bg-primary text-primary-foreground focus-visible:ring-ring inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-md px-3.5 text-[13px] font-semibold transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
    >
      {spinning && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
      {label}
    </button>
  );
}
