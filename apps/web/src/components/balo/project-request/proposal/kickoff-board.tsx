'use client';

import { useCallback, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  BadgeCheck,
  Banknote,
  Check,
  ClipboardCheck,
  Clock,
  Loader2,
  PartyPopper,
  Receipt,
  User,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import type { KickoffBillingCapture } from '@/lib/billing/billing-capture';
import type { KickoffUpfront } from '@/lib/project-request/request-detail-view';
import { RequestCard } from '../request-card';
import { ClientBillingAffordance } from './billing-details-dialog';
import { formatProposalAmount } from './proposal-format';
import { markUpfrontInvoiceRaisedAction } from '@/app/(dashboard)/projects/[requestId]/_actions/mark-upfront-invoice-raised';
import { approveKickoffAction } from '@/app/(dashboard)/projects/[requestId]/_actions/approve-kickoff';

/** The viewer lens — selects which row is "yours" and which action it fires. */
type KickoffLens = 'client' | 'expert' | 'admin';

interface KickoffBoardProps {
  requestId: string;
  acceptedRelationshipId: string;
  lens: KickoffLens;
  clientBillingConfirmed: boolean;
  upfrontInvoiceRaised: boolean;
  approved: boolean;
  expertName: string;
  /** The client company — named on the rows other viewers are waiting on it for. */
  clientCompanyName: string;
  /**
   * What the accepted proposal makes due before kickoff, or `null` when nothing is —
   * the checklist then drops the invoice steps for a single Balo approval.
   */
  upfront: KickoffUpfront | null;
  /**
   * Client billing-capture context (BAL-323). Non-null ONLY for the client lens —
   * drives the client row's capture form / member notice. `null` for expert/admin.
   */
  billing?: KickoffBillingCapture | null;
  /** Tightens padding for the mobile bottom-sheet mount. */
  mobile?: boolean;
}

/**
 * The checklist steps, in dependency order:
 *  - `billing`  — the client adds billing details.
 *  - `invoice`  — Balo raises the upfront invoice and marks it sent.
 *  - `payment`  — the client pays it; Balo confirming payment IS the kickoff approval.
 *  - `approval` — replaces `invoice` + `payment` when nothing is due upfront.
 */
type KickoffStepKey = 'billing' | 'invoice' | 'payment' | 'approval';

/** One resolved checklist row — everything the renderer reads, so the JSX stays branch-free. */
interface KickoffStep {
  key: KickoffStepKey;
  /** Whose step it is: earns the "You" pill and is named in other viewers' waiting copy. */
  owner: 'client' | 'admin';
  label: string;
  icon: LucideIcon;
  done: boolean;
  /** Every earlier step is done, so this one can be acted on now. */
  ready: boolean;
  sub: string;
}

/** The admin's action on a step. */
interface AdminStepAction {
  label: 'Mark sent' | 'Confirm payment' | 'Approve';
  /** `approve` advances the request to `kickoff_approved` — it kicks the project off. */
  handler: 'markInvoiceSent' | 'approve';
}

/** Notice shown on the client billing row for a member who can't complete it (never absence-framed). */
export const KICKOFF_MEMBER_BLOCKED_SUB =
  'A company owner or admin needs to add these billing details before kickoff.';

/** Everything the step copy needs, resolved once per render. */
interface StepCopyContext {
  lens: KickoffLens;
  company: string;
  /**
   * The upfront amount, exact to the cent (it is what goes on the invoice), or `null`
   * when withheld from this viewer.
   */
  amount: string | null;
  memberBlocked: boolean;
}

/** "the A$5,220 upfront invoice" — or "the upfront invoice" when the amount is withheld. */
function theInvoice(amount: string | null): string {
  return amount === null ? 'the upfront invoice' : `the ${amount} upfront invoice`;
}

function billingSub(done: boolean, c: StepCopyContext): string {
  if (c.lens === 'client' && c.memberBlocked) return KICKOFF_MEMBER_BLOCKED_SUB;
  if (done) return 'Billing details added';
  if (c.lens === 'client') return 'Add your billing details';
  return `Waiting on ${c.company} to add billing details`;
}

function invoiceSub(done: boolean, ready: boolean, c: StepCopyContext): string {
  if (done) return c.amount === null ? 'Upfront invoice sent' : `Invoice for ${c.amount} sent`;
  if (c.lens !== 'admin') return `Waiting on Balo to send ${theInvoice(c.amount)}`;
  if (!ready) return 'Available once billing details are in';
  return `Invoice ${c.company} for ${c.amount ?? 'the upfront amount'}, then mark it sent`;
}

function paymentSub(done: boolean, ready: boolean, c: StepCopyContext): string {
  if (done) return 'Upfront invoice paid';
  if (c.lens === 'client') {
    return ready
      ? `Pay ${theInvoice(c.amount)} Balo sent — kickoff follows as soon as it lands`
      : `Due once Balo sends ${theInvoice(c.amount)}`;
  }
  if (c.lens === 'admin') {
    return ready
      ? `Confirm once ${c.company}'s payment lands — this kicks off the project`
      : 'Available once the invoice is sent';
  }
  return `Waiting on ${c.company} to pay the upfront invoice`;
}

function approvalSub(done: boolean, ready: boolean, c: StepCopyContext): string {
  if (done) return 'Kickoff approved';
  if (c.lens !== 'admin') return 'Nothing is due upfront — waiting on Balo to approve kickoff';
  return ready
    ? 'Nothing is due upfront on this deal — approve to kick off'
    : 'Available once billing details are in';
}

/**
 * Resolve the checklist for this request. A deal with money due upfront gets three
 * steps (billing → invoice → payment); one with nothing due gets two (billing →
 * approval). Each step is `ready` once every earlier step is done.
 */
function resolveSteps(
  state: { billingDone: boolean; invoiceRaised: boolean; approved: boolean; hasUpfront: boolean },
  c: StepCopyContext
): KickoffStep[] {
  const { billingDone, invoiceRaised, approved, hasUpfront } = state;
  const billing: KickoffStep = {
    key: 'billing',
    owner: 'client',
    label: 'Add billing details',
    icon: User,
    done: billingDone,
    ready: true,
    sub: billingSub(billingDone, c),
  };

  if (!hasUpfront) {
    return [
      billing,
      {
        key: 'approval',
        owner: 'admin',
        label: 'Approve kickoff',
        icon: BadgeCheck,
        done: approved,
        ready: billingDone,
        sub: approvalSub(approved, billingDone, c),
      },
    ];
  }

  // A kickoff approved before the invoice step existed has no raise timestamp — it was
  // necessarily invoiced, so approval implies the invoice step is done.
  const invoiceDone = invoiceRaised || approved;
  const paymentReady = billingDone && invoiceDone;
  return [
    billing,
    {
      key: 'invoice',
      owner: 'admin',
      label: 'Raise the upfront invoice',
      icon: Receipt,
      done: invoiceDone,
      ready: billingDone,
      sub: invoiceSub(invoiceDone, billingDone, c),
    },
    {
      key: 'payment',
      owner: 'client',
      label: 'Pay the upfront invoice',
      icon: Banknote,
      done: approved,
      ready: paymentReady,
      sub: paymentSub(approved, paymentReady, c),
    },
  ];
}

/** The admin's action on a step, or `null` when the step carries none for the admin. */
function adminActionFor(key: KickoffStepKey): AdminStepAction | null {
  if (key === 'invoice') return { label: 'Mark sent', handler: 'markInvoiceSent' };
  if (key === 'payment') return { label: 'Confirm payment', handler: 'approve' };
  if (key === 'approval') return { label: 'Approve', handler: 'approve' };
  return null;
}

export function KickoffBoard({
  requestId,
  acceptedRelationshipId,
  lens,
  clientBillingConfirmed,
  upfrontInvoiceRaised,
  approved,
  expertName,
  clientCompanyName,
  upfront,
  billing = null,
  mobile = false,
}: Readonly<KickoffBoardProps>): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // A client-lens MEMBER (not owner/admin) is blocked from the outstanding billing
  // step — its row gets a "what happens next" notice. The blocked-VIEW analytics is
  // fired once from a single page-level tracker (see request-detail-shell), NOT here:
  // the board mounts twice per client (desktop + mobile sheet), so firing from the
  // component would over-count.
  const memberBlocked =
    lens === 'client' && !clientBillingConfirmed && billing !== null && !billing.canManage;

  const steps = resolveSteps(
    {
      billingDone: clientBillingConfirmed,
      invoiceRaised: upfrontInvoiceRaised,
      approved,
      hasUpfront: upfront !== null,
    },
    {
      lens,
      company: clientCompanyName,
      amount:
        upfront?.amountCents == null
          ? null
          : formatProposalAmount(upfront.amountCents, upfront.currency),
      memberBlocked,
    }
  );
  const doneCount = steps.filter((step) => step.done).length;

  const handleMarkInvoiceSent = useCallback((): void => {
    if (pending) return;
    startTransition(() => {
      void (async (): Promise<void> => {
        const result = await markUpfrontInvoiceRaisedAction({
          requestId,
          relationshipId: acceptedRelationshipId,
        });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        if (result.changed) {
          track(PROJECT_EVENTS.PROJECT_UPFRONT_INVOICE_RAISED, {
            request_id: requestId,
            relationship_id: acceptedRelationshipId,
            actor: 'admin',
          });
        }
        toast.success('Invoice marked as sent');
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
              doneCount === steps.length ? 'text-success' : 'text-muted-foreground'
            )}
          >
            {doneCount}/{steps.length} ready
          </span>
        </div>
        <p className="text-muted-foreground mb-4 text-[12.5px] leading-relaxed">
          Everyone sees the same checklist — so no one&apos;s left wondering who they&apos;re
          waiting on.
        </p>

        <ul className="flex flex-col gap-2.5">
          {steps.map((step) => (
            <KickoffRowItem
              key={step.key}
              step={step}
              lens={lens}
              expertName={expertName}
              pending={pending}
              billing={billing}
              requestId={requestId}
              relationshipId={acceptedRelationshipId}
              onMarkInvoiceSent={handleMarkInvoiceSent}
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
  step: KickoffStep;
  lens: KickoffLens;
  expertName: string;
  pending: boolean;
  billing: KickoffBillingCapture | null;
  requestId: string;
  relationshipId: string;
  onMarkInvoiceSent: () => void;
  onApprove: () => void;
}

/**
 * One checklist row. Renders the status badge, the step icon, the label + "You"
 * pill, the sub-copy, and the trailing affordance. The client's own billing row
 * swaps the generic affordance for the BAL-323 capture flow (form / member notice /
 * view-edit).
 */
function KickoffRowItem({
  step,
  lens,
  expertName,
  pending,
  billing,
  requestId,
  relationshipId,
  onMarkInvoiceSent,
  onApprove,
}: Readonly<KickoffRowItemProps>): React.JSX.Element {
  const RowIcon = step.icon;
  const mine = step.owner === lens;
  const adminAction = lens === 'admin' ? adminActionFor(step.key) : null;
  // The row the viewer can act on right now gets the emphasis.
  const highlight = !step.done && step.ready && (mine || adminAction !== null);
  // The client's billing row (client lens only) owns the capture flow.
  const isClientBillingRow = lens === 'client' && step.key === 'billing' && billing !== null;

  return (
    <li
      // `aria-current="step"` ties the visual emphasis of the viewer's actionable
      // row (ring) to the assistive-tech tree.
      aria-current={highlight ? 'step' : undefined}
      className={cn(
        'flex items-center gap-3 rounded-xl border p-3.5',
        highlight
          ? 'border-primary/40 bg-primary/5 ring-primary/10 ring-2'
          : 'border-border bg-card'
      )}
    >
      <StatusBadge done={step.done} />

      <span
        className="bg-muted/60 border-border flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border"
        aria-hidden="true"
      >
        <RowIcon className="text-muted-foreground h-3.5 w-3.5" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-foreground text-sm font-medium">{step.label}</p>
          {mine && (
            <span className="text-primary bg-primary/10 border-primary/20 inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase">
              You
            </span>
          )}
        </div>
        <p className="text-muted-foreground mt-0.5 text-[12.5px] leading-relaxed">{step.sub}</p>
      </div>

      {isClientBillingRow && billing !== null ? (
        <ClientBillingAffordance
          done={step.done}
          canManage={billing.canManage}
          requestId={requestId}
          relationshipId={relationshipId}
          details={billing.details}
        />
      ) : (
        <RowAffordance
          step={step}
          mine={mine}
          adminAction={adminAction}
          expertName={expertName}
          pending={pending}
          onAction={adminAction?.handler === 'markInvoiceSent' ? onMarkInvoiceSent : onApprove}
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
  step: KickoffStep;
  mine: boolean;
  adminAction: AdminStepAction | null;
  expertName: string;
  pending: boolean;
  onAction: () => void;
}

/**
 * The trailing affordance for a row, selected via early returns: done → "Done"; the
 * admin's step action → a button (disabled until the step is ready); the client's own
 * ready payment → "To pay" (paid via the invoice, confirmed by Balo); else "Waiting".
 */
function RowAffordance({
  step,
  mine,
  adminAction,
  expertName,
  pending,
  onAction,
}: Readonly<RowAffordanceProps>): React.JSX.Element {
  if (step.done) {
    return <span className="text-success shrink-0 text-xs font-semibold">Done</span>;
  }

  if (adminAction !== null) {
    const hint =
      step.ready && adminAction.handler === 'approve'
        ? `Kick off the project with ${expertName}`
        : step.sub;
    return (
      <KickoffActionButton
        label={adminAction.label}
        onClick={onAction}
        disabled={pending || !step.ready}
        spinning={pending}
        title={hint}
        ariaLabel={`${adminAction.label} — ${hint}`}
      />
    );
  }

  if (mine && step.ready) {
    return <span className="text-warning shrink-0 text-xs font-semibold">To pay</span>;
  }

  return <span className="text-warning shrink-0 text-xs font-semibold">Waiting</span>;
}

interface KickoffActionButtonProps {
  label: string;
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
