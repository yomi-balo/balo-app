'use client';

import { useCallback, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Clock, Loader2, PartyPopper } from 'lucide-react';
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

/** The viewer lens — selects which step is "yours" and which action it fires. */
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
  /** Whose step it is: labelled "You" for its owner and named for every other viewer. */
  owner: 'client' | 'admin';
  label: string;
  done: boolean;
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
  if (!ready) return 'Available once billing details are in';
  if (c.lens !== 'admin') return `Waiting on Balo to send ${theInvoice(c.amount)}`;
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
  return ready
    ? `Waiting on ${c.company} to pay the upfront invoice`
    : 'Due once Balo sends the upfront invoice';
}

function approvalSub(done: boolean, ready: boolean, c: StepCopyContext): string {
  if (done) return 'Kickoff approved';
  if (!ready) return 'Available once billing details are in';
  if (c.lens !== 'admin') return 'Nothing is due upfront — waiting on Balo to approve kickoff';
  return 'Nothing is due upfront on this deal — approve to kick off';
}

/**
 * Resolve the checklist for this request. A deal with money due upfront gets three
 * steps (billing → invoice → payment); one with nothing due gets two (billing →
 * approval). Future-step copy depends on whether every earlier step is done.
 */
function resolveSteps(
  state: { billingDone: boolean; invoiceRaised: boolean; approved: boolean; hasUpfront: boolean },
  c: StepCopyContext
): KickoffStep[] {
  const { invoiceRaised, approved, hasUpfront } = state;
  // A legacy or migrated kickoff approved without a billing confirmation — approval implies
  // the billing gate was met, as it does for the invoice step below.
  const billingDone = state.billingDone || approved;
  const billing: KickoffStep = {
    key: 'billing',
    owner: 'client',
    label: 'Add billing details',
    done: billingDone,
    sub: billingSub(billingDone, c),
  };

  if (!hasUpfront) {
    return [
      billing,
      {
        key: 'approval',
        owner: 'admin',
        label: 'Approve kickoff',
        done: approved,
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
      done: invoiceDone,
      sub: invoiceSub(invoiceDone, billingDone, c),
    },
    {
      key: 'payment',
      owner: 'client',
      label: 'Pay the upfront invoice',
      done: approved,
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
  const allDone = doneCount === steps.length;
  const currentIndex = steps.findIndex((step) => !step.done);
  const ownerIsViewer = (owner: KickoffStep['owner']): boolean =>
    owner === 'client' ? lens === 'client' : lens === 'admin';
  const ownerLabel = (owner: KickoffStep['owner']): string => {
    if (ownerIsViewer(owner)) return 'You';
    return owner === 'client' ? clientCompanyName : 'Balo';
  };

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

      <RequestCard className={mobile ? 'p-4' : 'p-[22px]'}>
        <div className="mb-4.5 flex items-baseline justify-between gap-3">
          <h3 className="text-foreground text-[15px] font-semibold">Before kickoff</h3>
          <span
            className={cn(
              'shrink-0 text-[12.5px] font-medium tabular-nums',
              allDone ? 'text-success-strong' : 'text-muted-foreground'
            )}
          >
            {allDone ? 'All done' : `${doneCount} of ${steps.length} done`}
          </span>
        </div>

        <ol className="flex flex-col">
          {steps.map((step, index) => {
            let state: StepState = 'future';
            if (step.done) state = 'done';
            else if (index === currentIndex) state = 'current';
            let connector: StepConnector = null;
            if (index < steps.length - 1) connector = step.done ? 'done' : 'pending';
            return (
              <KickoffThreadStep
                key={step.key}
                step={step}
                state={state}
                owner={ownerLabel(step.owner)}
                ownerIsViewer={ownerIsViewer(step.owner)}
                connector={connector}
                lens={lens}
                expertName={expertName}
                pending={pending}
                billing={billing}
                requestId={requestId}
                relationshipId={acceptedRelationshipId}
                onMarkInvoiceSent={handleMarkInvoiceSent}
                onApprove={handleApprove}
              />
            );
          })}
        </ol>
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

type StepState = 'done' | 'current' | 'future';
/** The line joining a step to the next: solid once the step is done, neutral until then. */
type StepConnector = 'done' | 'pending' | null;

interface KickoffThreadStepProps {
  step: KickoffStep;
  state: StepState;
  owner: string;
  /** The owner is the viewer's own side — "You" takes the primary colour on the current step. */
  ownerIsViewer: boolean;
  connector: StepConnector;
  lens: KickoffLens;
  expertName: string;
  pending: boolean;
  billing: KickoffBillingCapture | null;
  requestId: string;
  relationshipId: string;
  onMarkInvoiceSent: () => void;
  onApprove: () => void;
}

/** The step's circular node: a check when done, a clock when current, hollow when future. */
function StepNode({ state }: Readonly<{ state: StepState }>): React.JSX.Element {
  if (state === 'done') {
    return (
      <span
        className="bg-success text-success-foreground flex size-6 shrink-0 items-center justify-center rounded-full"
        aria-hidden="true"
      >
        <Check className="size-[13px]" />
      </span>
    );
  }
  if (state === 'current') {
    return (
      <span
        className="border-primary bg-primary/10 text-primary flex size-6 shrink-0 items-center justify-center rounded-full border-2"
        aria-hidden="true"
      >
        <Clock className="size-3" />
      </span>
    );
  }
  return (
    <span
      className="border-muted-foreground/40 flex size-6 shrink-0 rounded-full border-[1.5px]"
      aria-hidden="true"
    />
  );
}

/**
 * One step of the "Before kickoff" thread: node + connector on the left; label, owner and
 * sub-copy with an optional trailing affordance on the right. The client's own billing step
 * swaps in the BAL-323 capture flow (add / view-edit); the admin's current step carries its
 * action button. Every other step shows no affordance.
 */
function KickoffThreadStep({
  step,
  state,
  owner,
  ownerIsViewer,
  connector,
  lens,
  expertName,
  pending,
  billing,
  requestId,
  relationshipId,
  onMarkInvoiceSent,
  onApprove,
}: Readonly<KickoffThreadStepProps>): React.JSX.Element {
  const future = state === 'future';
  const adminAction = lens === 'admin' && state === 'current' ? adminActionFor(step.key) : null;
  const showBilling =
    lens === 'client' && step.key === 'billing' && billing !== null && state !== 'future';
  let ownerClass = 'text-muted-foreground';
  if (state === 'current' && ownerIsViewer) ownerClass = 'text-primary';

  return (
    <li
      aria-current={state === 'current' ? 'step' : undefined}
      data-step-state={state}
      className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-3"
    >
      <div className="flex flex-col items-center">
        <StepNode state={state} />
        {connector !== null && (
          <span
            aria-hidden="true"
            className={cn(
              'my-1 min-h-3.5 w-0.5 flex-1',
              connector === 'done' ? 'bg-success/35' : 'bg-border'
            )}
          />
        )}
      </div>

      <div className={cn('min-w-0', connector !== null && 'pb-4.5')}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
              <p
                className={cn(
                  'text-sm font-medium',
                  future ? 'text-muted-foreground' : 'text-foreground'
                )}
              >
                {step.label}
              </p>
              <span className={cn('text-xs', ownerClass)}>{owner}</span>
            </div>
            <p className="text-muted-foreground mt-0.5 text-[12.5px] leading-normal">{step.sub}</p>
          </div>

          {showBilling && (
            <ClientBillingAffordance
              done={step.done}
              canManage={billing.canManage}
              requestId={requestId}
              relationshipId={relationshipId}
              details={billing.details}
            />
          )}
          {adminAction !== null && (
            <KickoffActionButton
              label={adminAction.label}
              onClick={adminAction.handler === 'markInvoiceSent' ? onMarkInvoiceSent : onApprove}
              disabled={pending}
              spinning={pending}
              title={adminHint(adminAction, step, expertName)}
              ariaLabel={`${adminAction.label} — ${adminHint(adminAction, step, expertName)}`}
            />
          )}
        </div>
      </div>
    </li>
  );
}

function adminHint(action: AdminStepAction, step: KickoffStep, expertName: string): string {
  return action.handler === 'approve' ? `Kick off the project with ${expertName}` : step.sub;
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
      className="bg-primary text-primary-foreground focus-visible:ring-ring inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3.5 text-[13px] font-semibold transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-9"
    >
      {spinning && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
      {label}
    </button>
  );
}
