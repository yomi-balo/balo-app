'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import * as Sentry from '@sentry/nextjs';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { useAuthModal } from '@/hooks/use-auth-modal';
import { SESSION_EXPIRED_MESSAGE } from '@/lib/auth/auth-error-copy';
import { track, BOOKING_EVENTS } from '@/lib/analytics';
import { isDescriptionEmpty } from '@/components/balo/rich-text/plain-text';
import { EMPTY_TAXONOMY } from '@/lib/search/taxonomy';
import { bookConsultationAction } from '@/lib/booking/actions/book-consultation';
import { refetchOpenCasesAction } from '@/lib/booking/actions/refetch-open-cases';
import { refetchBookingContextAction } from '@/lib/booking/actions/refetch-booking-context';
import { saveBookingForLaterAction } from '@/lib/booking/actions/save-booking-for-later';
import type {
  BookingFundingRequest,
  BookingFundingView,
  FundedVia,
} from '@/lib/booking/actions/booking-funding-types';
import { switchWorkspaceAction } from '@/lib/auth/actions/switch-workspace';
import type { AvailabilitySlotSelection } from '@/components/availability';
import type {
  BookConsultationResult,
  BookingBalanceFailure,
  BookingFailureCode,
  BookingSetupFailure,
} from '@/lib/booking/actions/types';
import { TOP_UP_LIMITS_MINOR, type EligibleCompany } from '@balo/shared/credit';
import { companyWorkspaceKey } from '@balo/shared/workspaces';
import { BookingHeader, type BookingStep } from './booking-header';
import { StepPickTime, pickerRestoreFor, type PickerRestore } from './step-pick-time';
import { LengthNote } from './billing-line';
import { StepConfirm, type CaseSelection, type ConfirmSlot } from './step-confirm';
import { hasCaseChoice } from './case-choice-section';
import { StepBooked } from './step-booked';
import { StepSavedForLater } from './step-saved-for-later';
import { OnboardingRoutingState } from './onboarding-routing-state';
import {
  BookingBalancePanel,
  FundingSetupPanel,
  HardFailurePanel,
  PartialFailurePanel,
  ExpertUnavailablePanel,
  SessionExpiredPanel,
  bookingSwitchFailedCopy,
  type BookingBalancePanelProps,
  type CaseSavedNote,
  type HardFailurePanelCopy,
} from './booking-error-panels';
import type { GuestDraft } from './guest-invite-composer';
import {
  clearBookingDrafts,
  readBookingDraft,
  writeBookingDraft,
  type BookingDraft,
  type BookingDraftScope,
} from './booking-draft';
import { findFirstInvalidField } from './focus-first-invalid';
import { BookingFundingBlock } from './funding/booking-funding-block';
import { resolveFundingDisposition, type RefusedFundingView } from './funding/funding-disposition';
import {
  BALANCE_NOW_COVERS_COPY,
  DRAFT_CLEARED_COPY,
  fundedHardFailureBody,
  fundedPartialFollowUp,
  fundedSessionFollowUp,
  staleSlotFundedFollowUp,
} from './funding/funding-copy';
import { useBookingFunding } from './funding/use-booking-funding';
import { guardStripeOutsideInteraction } from './funding/stripe-outside-guard';
import type {
  BookingContext,
  BookingEntry,
  BookingFlowDialogProps,
  FixedCaseSummary,
  OpenCaseForExpert,
} from './types';

type Phase =
  | 'onboarding'
  | 'pick_time'
  | 'confirm'
  | 'booked'
  | 'saved_for_later'
  | 'error_hard'
  | 'error_partial'
  | 'error_session'
  | 'error_funding'
  | 'error_balance'
  | 'error_unavailable';

interface BookedSnapshot {
  engagementId: string;
  meetingId: string;
  joinPath: string;
  provisioned: boolean;
  isNewCase: boolean;
  caseTitle: string;
  /**
   * ⚠ THE SERVER'S WINDOW, not `slot` (S2). `slot` is what was asked for; this is what the
   * meeting is. They diverge on the idempotent-replay path, and Step 3 / the toast are
   * statements of record.
   */
  scheduledStartIso: string;
  durationMinutes: number;
  guestsInvited: number;
  guestInviteFailed: boolean;
}

function randomNonce(): string {
  return crypto.randomUUID();
}

const pageTransition = {
  initial: { opacity: 0, x: 16 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -16 },
  transition: { duration: 0.2, ease: 'easeInOut' as const },
};

function toBookingStep(phase: Phase): BookingStep {
  if (phase === 'booked') return 'booked';
  if (phase === 'pick_time') return 'pick_time';
  return 'confirm';
}

/** `handleAbandon`'s analytics dimension — one flat lookup, not a nested ternary. */
function resolveAbandonStep(phase: Phase): 'pick_time' | 'confirm' | 'error' {
  if (phase === 'pick_time') return 'pick_time';
  if (phase === 'confirm') return 'confirm';
  return 'error';
}

type EffectiveCaseChoice =
  | { kind: 'existing'; engagementId: string }
  | {
      kind: 'new';
      title: string;
      descriptionHtml: string;
      productIds: readonly string[];
      companyId?: string;
    };

/**
 * `handleSubmit`'s "which case does this submit target" resolution, pulled out to a pure
 * function: an `if`/early-return chain reads as three flat cases (round 1's recovery pin wins,
 * then an explicit chooser pick, then a fresh new-case draft) rather than a nested ternary.
 */
function resolveEffectiveCaseChoice(params: {
  recovered: FixedCaseSummary | null;
  caseSelection: CaseSelection;
  title: string;
  descriptionHtml: string;
  productIds: readonly string[];
  companyId: string | null;
}): EffectiveCaseChoice {
  const { recovered, caseSelection, title, descriptionHtml, productIds, companyId } = params;
  if (recovered !== null) {
    return { kind: 'existing', engagementId: recovered.engagementId };
  }
  if (caseSelection.kind === 'existing') {
    return { kind: 'existing', engagementId: caseSelection.engagementId };
  }
  return {
    kind: 'new',
    title: title.trim(),
    descriptionHtml,
    productIds,
    ...(companyId === null ? {} : { companyId }),
  };
}

/**
 * `handleSubmit`'s client-side "real text content" gate (M2) plus the company-picker
 * requirement, collapsed to ONE boolean so the component body has one guard instead of three
 * separate `&&`-chained `if`s. `false` for the attach shape unconditionally — none of these
 * rules apply once a case is already chosen.
 */
function hasBlockingValidationError(
  choice: EffectiveCaseChoice,
  companies: readonly EligibleCompany[] | null,
  companyId: string | null
): boolean {
  if (choice.kind !== 'new') return false;
  if (choice.title.length === 0) return true;
  if (isDescriptionEmpty(choice.descriptionHtml)) return true;
  return companies !== null && companies.length > 1 && companyId === null;
}

/**
 * The `booking_attached_to_case` analytics dimension: how many consultations the case already
 * had, from whichever source applies. `null` ⇒ this booking was NOT an attach (skip the event
 * entirely), collapsing the two-arm `if`/`else if` at the call site to one `if`.
 */
function computeAttachedConsultationCount(
  recovered: FixedCaseSummary | null,
  caseSelection: CaseSelection,
  openCases: readonly OpenCaseForExpert[] | null
): number | null {
  if (recovered !== null) return recovered.consultationCount;
  if (caseSelection.kind !== 'existing') return null;
  const attachedTo = openCases?.find((c) => c.engagementId === caseSelection.engagementId);
  return attachedTo?.consultationCount ?? 0;
}

/**
 * The full `case_booked` analytics bundle for a successful submit: the primary event plus the
 * two conditional follow-ons (guests invited, attached-to-an-existing-case). Pulled out of
 * `handleSubmit` so its two `if`s (each independently low-complexity) don't count against the
 * orchestrator's own budget — this function fires `track()` itself rather than returning
 * something for the caller to act on, since there is nothing left to decide afterward.
 */
function fireBookingSuccessAnalytics(params: {
  result: Extract<BookConsultationResult, { ok: true }>;
  effectiveCaseChoice: EffectiveCaseChoice;
  guests: readonly GuestDraft[];
  viewerEmailDomain: string | null;
  recovered: FixedCaseSummary | null;
  caseSelection: CaseSelection;
  openCases: readonly OpenCaseForExpert[] | null;
  expertProfileId: string;
}): void {
  const {
    result,
    effectiveCaseChoice,
    guests,
    viewerEmailDomain,
    recovered,
    caseSelection,
    openCases,
    expertProfileId,
  } = params;

  track(BOOKING_EVENTS.CASE_BOOKED, {
    expert_id: expertProfileId,
    duration_minutes: result.durationMinutes,
    products_count: effectiveCaseChoice.kind === 'new' ? effectiveCaseChoice.productIds.length : 0,
    has_description:
      effectiveCaseChoice.kind === 'new' && effectiveCaseChoice.descriptionHtml.trim().length > 0,
    guest_count: guests.length,
    is_new_case: result.isNewCase,
    provisioned: result.provisioned,
  });

  if (guests.length > 0) {
    const sameDomainCount = guests.filter(
      (g) => viewerEmailDomain !== null && g.email.split('@')[1] === viewerEmailDomain
    ).length;
    track(BOOKING_EVENTS.GUESTS_INVITED, {
      count: guests.length,
      same_domain_count: sameDomainCount,
    });
  }

  const attachedConsultationCount = computeAttachedConsultationCount(
    recovered,
    caseSelection,
    openCases
  );
  if (attachedConsultationCount !== null) {
    track(BOOKING_EVENTS.ATTACHED_TO_CASE, {
      existing_consultation_count: attachedConsultationCount,
    });
  }
}

/**
 * The `error_hard` copy for a staff member who tried to book while impersonating a customer.
 *
 * ⚠ NO RETRY, AND NO "SIGN IN". Retrying fails identically, and the sign-in the session-expired
 * panel offers would end the impersonation — see `impersonation_refused` in `types.ts`. The
 * body names the one thing the reader can actually do.
 */
const IMPERSONATION_REFUSAL_PANEL: HardFailurePanelCopy = {
  title: "Bookings can't be made while impersonating",
  body: 'Booking commits this account to a consultation its own balance settles, so it has to be their action. Ask them to book, or end the impersonation and book from your own account.',
  hideRetry: true,
};

/**
 * BAL-474 — a hold (D6.1) or reservation (D6.5) refusal, ready for {@link BookingBalancePanel}.
 * The `reserved` arm is only constructible WITH a figure and a count: a reservation refuses only
 * when a top-up would make room, so a figure-less one is a malformed result and never reaches
 * this shape (it falls to the generic hard panel instead).
 */
type BalanceRefusal = {
  readonly canManageBilling: boolean;
  readonly company: BookingBalanceFailure['company'];
  /** Set only when the refusal came from the MEETING hop, after the case row was written. */
  readonly caseTitle: string | null;
} & (
  | { readonly variant: 'hold'; readonly topUpNeededMinor: number | null }
  | {
      readonly variant: 'reserved';
      readonly topUpNeededMinor: number;
      readonly reservedBookingCount: number;
    }
);

type BalanceOutcome = { kind: 'balance' } & BalanceRefusal;

type FundingOutcome = {
  kind: 'funding';
  canManageBilling: boolean;
  caseTitle: string | null;
  /** The company the gate checked; `null` when the result carried no setup detail. */
  company: BookingSetupFailure['company'] | null;
};

type FundingRefusalOutcome = FundingOutcome | BalanceOutcome;

type SubmitFailureOutcome =
  | { kind: 'stale_slot' }
  | { kind: 'impersonation_refused' }
  | { kind: 'expert_unavailable' }
  | { kind: 'session_expired'; caseTitle: string | null }
  | { kind: 'partial'; engagementId: string; caseTitle: string }
  | { kind: 'company_fail_closed'; code: BookingFailureCode }
  | FundingRefusalOutcome
  | { kind: 'hard' };

/**
 * The actor's capability, carried by the CODE (`*_top_up_required` ⇒ MANAGE_BILLING, so they can
 * top up themselves; `*_admins_notified` ⇒ they cannot, and the gate's fan-out told the billing
 * admins). A code that is not here is not a balance refusal.
 */
const BALANCE_CODE_CAN_MANAGE_BILLING: Readonly<Partial<Record<BookingFailureCode, boolean>>> = {
  hold_top_up_required: true,
  hold_admins_notified: false,
  reserved_top_up_required: true,
  reserved_admins_notified: false,
};

/**
 * The funding pre-conditions, keyed on the CODE and never the stage (D8.2): a refusal that came
 * back from the MEETING hop (the API's pre-write guard) now carries `stage: 'meeting'` with the
 * case's `engagementId`/`caseTitle`, so the partial-failure arm would otherwise swallow it and
 * offer a "Try again" that cannot help. `caseTitle` — set only on that path — lets the panel say
 * the case is saved.
 *
 * `null` ⇒ not a funding refusal; the caller keeps classifying.
 */
function resolveFundingOutcome(
  result: Extract<BookConsultationResult, { ok: false }>
): SubmitFailureOutcome | null {
  const caseTitle = result.stage === 'meeting' ? (result.caseTitle ?? null) : null;

  // BAL-478 — the unfunded pre-condition. `funding_setup_required` ⇒ the actor holds
  // MANAGE_BILLING and can self-serve; `funding_admins_notified` ⇒ they don't, and the
  // billing-admin fan-out (published by the gate itself) is the only affordance.
  if (result.code === 'funding_setup_required' || result.code === 'funding_admins_notified') {
    return {
      kind: 'funding',
      canManageBilling: result.code === 'funding_setup_required',
      caseTitle,
      company: result.setup?.company ?? null,
    };
  }

  const canManageBilling = BALANCE_CODE_CAN_MANAGE_BILLING[result.code];
  if (canManageBilling === undefined) {
    return null;
  }
  const { balance } = result;
  if (balance === undefined) {
    return { kind: 'hard' };
  }
  if (balance.variant === 'hold') {
    return {
      kind: 'balance',
      variant: 'hold',
      canManageBilling,
      topUpNeededMinor: balance.topUpNeededMinor,
      company: balance.company,
      caseTitle,
    };
  }
  if (balance.topUpNeededMinor === null || balance.reservedBookingCount === null) {
    return { kind: 'hard' };
  }
  return {
    kind: 'balance',
    variant: 'reserved',
    canManageBilling,
    topUpNeededMinor: balance.topUpNeededMinor,
    reservedBookingCount: balance.reservedBookingCount,
    company: balance.company,
    caseTitle,
  };
}

/**
 * `handleSubmit`'s failure-branch classification, pulled out to a pure function so the
 * component body only has to switch on an already-resolved discriminant. Order matters and is
 * preserved: `slot_unavailable` first (never treated as a case-level partial failure, even
 * though it also carries `engagementId`/`caseTitle`), then `session_expired` (which carries the
 * same fields and would otherwise be swallowed by the arm below it), then the funding
 * pre-conditions by CODE (same reason), then any `stage:'meeting'` failure that names a case
 * (the partial-recovery arm, D4b), then a `stage:'company'` failure (M4's fail-closed arm), then
 * the generic hard failure.
 */
function resolveSubmitFailureOutcome(
  result: Extract<BookConsultationResult, { ok: false }>
): SubmitFailureOutcome {
  if (result.code === 'slot_unavailable') {
    return { kind: 'stale_slot' };
  }
  // ⚠ BEFORE the partial arm. A meeting-hop `session_expired` also carries
  // `engagementId`/`caseTitle`, so the partial arm below would otherwise swallow it and offer a
  // Try again that re-sends the same dead token forever. `caseTitle` is threaded through rather
  // than dropped: on that path the case row IS real, and the panel says so.
  // ⚠ BEFORE `session_expired`, which an impersonated session would otherwise be reported as —
  // see that code's note in `types.ts`.
  if (result.code === 'impersonation_refused') {
    return { kind: 'impersonation_refused' };
  }
  // ⚠ BEFORE the partial arm: a meeting-hop refusal also carries the case, but no retry helps.
  if (result.code === 'expert_unavailable') {
    return { kind: 'expert_unavailable' };
  }
  if (result.code === 'session_expired') {
    return { kind: 'session_expired', caseTitle: result.caseTitle ?? null };
  }
  // ⚠ BEFORE the partial arm, keyed on the CODE — see `resolveFundingOutcome`.
  const funding = resolveFundingOutcome(result);
  if (funding !== null) {
    return funding;
  }
  if (
    result.stage === 'meeting' &&
    result.engagementId !== undefined &&
    result.caseTitle !== undefined
  ) {
    return { kind: 'partial', engagementId: result.engagementId, caseTitle: result.caseTitle };
  }
  if (result.stage === 'company') {
    return { kind: 'company_fail_closed', code: result.code };
  }
  return { kind: 'hard' };
}

/**
 * Whether a submit-time funding refusal keeps today's full panel instead of the inline block: a
 * billing manager who cannot top up from here, because the refusing company is not the active
 * workspace or the amount is more than one top-up. Members always get the inline block (they save
 * the booking rather than top up), and so does any refusal that carries no company to check.
 */
function isFullPanelOutcome(outcome: FundingRefusalOutcome): boolean {
  if (!outcome.canManageBilling) return false;
  if (outcome.kind === 'funding') {
    return outcome.company !== null && !outcome.company.isActive;
  }
  const exceedsOneTopUp =
    outcome.topUpNeededMinor !== null && outcome.topUpNeededMinor > TOP_UP_LIMITS_MINOR.max;
  return !outcome.company.isActive || exceedsOneTopUp;
}

/**
 * The pre-flight's subject: the booking in front of the client on Review & confirm. `null` until
 * there is one (not on that step, no time chosen, or a company still to be picked).
 */
function buildFundingRequest(params: {
  phase: Phase;
  slot: ConfirmSlot | null;
  expertProfileId: string;
  recovered: FixedCaseSummary | null;
  caseSelection: CaseSelection;
  companyId: string | null;
  companies: readonly EligibleCompany[] | null;
}): BookingFundingRequest | null {
  const { phase, slot, expertProfileId, recovered, caseSelection, companyId, companies } = params;
  if (phase !== 'confirm' || slot === null) return null;
  if (recovered !== null) {
    return {
      expertProfileId,
      slot,
      caseChoice: { kind: 'existing', engagementId: recovered.engagementId },
    };
  }
  if (caseSelection.kind === 'existing') {
    return {
      expertProfileId,
      slot,
      caseChoice: { kind: 'existing', engagementId: caseSelection.engagementId },
    };
  }
  if (companies !== null && companies.length > 1 && companyId === null) return null;
  return {
    expertProfileId,
    slot,
    caseChoice: companyId === null ? { kind: 'new' } : { kind: 'new', companyId },
  };
}

/** The signed-in booker's id, for chooser entries that carry one. Entry point 3 learns it from
 *  its background context read instead (`loadedDraftOwner`). */
function resolveDraftOwner(entry: BookingEntry): string | null {
  if (entry.mode !== 'chooser') return null;
  const { context } = entry;
  if (context.arm === 'single_company' || context.arm === 'choose_company') {
    return context.viewerUserId;
  }
  return null;
}

const SAVE_FOR_LATER_FAILED_COPY =
  "We couldn't let your billing admins know just now. What you typed is still saved on this device.";

/**
 * Tell the billing admins and keep the draft. A thrown action is captured and read as a failure;
 * `bookable_now` means the gate no longer refuses, so there is nobody to tell.
 */
async function saveForLater(
  request: BookingFundingRequest
): Promise<'saved' | 'bookable_now' | 'failed'> {
  try {
    const result = await saveBookingForLaterAction(request);
    if (result.ok) return 'saved';
    return result.reason === 'not_refused' ? 'bookable_now' : 'failed';
  } catch (error) {
    Sentry.captureException(error, { tags: { feature: 'booking', step: 'save_for_later' } });
    return 'failed';
  }
}

/** The on-device draft's key scope, or `null` where no draft is kept. */
function buildDraftScope(owner: string | null, expertProfileId: string): BookingDraftScope | null {
  return owner === null ? null : { ownerUserId: owner, expertProfileId };
}

/**
 * The case choice a restored draft puts back: an existing case only while it is still among this
 * client's open cases (single-company chooser), otherwise a new case.
 */
function restoredCaseSelection(draft: BookingDraft, context: BookingContext): CaseSelection {
  const { caseSelection } = draft;
  if (caseSelection.kind !== 'existing' || context.arm !== 'single_company') {
    return { kind: 'new' };
  }
  const stillOpen = context.openCases.some((c) => c.engagementId === caseSelection.engagementId);
  return stillOpen ? caseSelection : { kind: 'new' };
}

/** The refusal the inline block renders, or `null` when the answer is not one it shows. */
function inlineRefusal(view: BookingFundingView | null): RefusedFundingView | null {
  if (view?.kind !== 'refused') return null;
  return resolveFundingDisposition(view) === 'inline' ? view : null;
}

/** The line under the stale-slot banner once funding has landed, else `null`. */
function staleSlotFollowUp(staleSlot: boolean, funded: FundedVia | null): string | null {
  if (!staleSlot || funded === null) return null;
  return staleSlotFundedFollowUp(funded);
}

/** A line about the funding that landed, built by `build`, or `null` when none did. */
function fundedLine(funded: FundedVia | null, build: (funded: FundedVia) => string): string | null {
  return funded === null ? null : build(funded);
}

/**
 * The hard-failure panel's copy: the one set for this failure when there is one, else the
 * landed-funding body (which never says nothing was charged), else the panel's own defaults.
 */
function hardFailureCopy(
  failure: HardFailurePanelCopy | null,
  funded: FundedVia | null
): HardFailurePanelCopy | null {
  if (failure !== null) return failure;
  const body = fundedLine(funded, fundedHardFailureBody);
  return body === null ? null : { body };
}

function caseSavedNote(caseTitle: string | null, expertLabel: string): CaseSavedNote | null {
  return caseTitle === null ? null : { caseTitle, expertLabel };
}

/** The companies a restored draft may belong to. */
function eligibleCompanyIds(context: BookingContext): readonly string[] {
  if (context.arm === 'single_company') return [context.company.id];
  if (context.arm === 'choose_company') return context.companies.map((c) => c.id);
  return [];
}

/**
 * The balance panel's props, built once so the two `BalanceRefusal` arms map onto the panel's
 * discriminated props without a ternary in the JSX.
 *
 * `amountExceedsSingleTopUp` is derived from the SAME constant the top-up page enforces
 * (`TOP_UP_LIMITS_MINOR.max`): a figure above it cannot be covered by one top-up, so the copy
 * says "top-ups totalling". `caseSaved` is set only when the refusal came from the meeting hop;
 * `expertLabel` is the PARTY label (agency, or the independent expert's own name).
 */
function buildBalancePanelProps(
  refusal: BalanceRefusal,
  shared: {
    readonly expertLabel: string;
    readonly isSwitching: boolean;
    readonly onTopUp: () => void;
    readonly onClose: () => void;
  }
): BookingBalancePanelProps {
  const caseSaved = caseSavedNote(refusal.caseTitle, shared.expertLabel);
  const common = {
    canManageBilling: refusal.canManageBilling,
    companyName: refusal.company.name,
    companyIsActive: refusal.company.isActive,
    amountExceedsSingleTopUp:
      refusal.topUpNeededMinor !== null && refusal.topUpNeededMinor > TOP_UP_LIMITS_MINOR.max,
    caseSaved,
    isSwitching: shared.isSwitching,
    onTopUp: shared.onTopUp,
    onClose: shared.onClose,
  };
  if (refusal.variant === 'hold') {
    return { ...common, variant: 'hold', topUpNeededMinor: refusal.topUpNeededMinor };
  }
  return {
    ...common,
    variant: 'reserved',
    topUpNeededMinor: refusal.topUpNeededMinor,
    reservedBookingCount: refusal.reservedBookingCount,
  };
}

/** The case an entry is pinned to (entry point 3 only), and whether it may start a new one. */
function entryCasePolicy(entry: BookingFlowDialogProps['entry']): {
  fixedCase: FixedCaseSummary | null;
  newCaseAllowed: boolean;
} {
  return {
    fixedCase: entry.mode === 'fixed_case' ? entry.fixedCase : null,
    newCaseAllowed: entry.mode === 'chooser' || entry.newCaseAllowed,
  };
}

/** True when the selected existing case is the entry's fixed case. */
function isFixedCaseSelected(
  fixedCase: FixedCaseSummary | null,
  caseSelection: CaseSelection
): boolean {
  return (
    fixedCase !== null &&
    caseSelection.kind === 'existing' &&
    caseSelection.engagementId === fixedCase.engagementId
  );
}

/** The chooser's "your last case … is resolved" note: a new case, and only resolved cases with this expert. */
function isResolvedCaseNoteShown(
  entryMode: BookingFlowDialogProps['entry']['mode'],
  caseSelection: CaseSelection,
  resolvedCaseCount: number,
  openCases: readonly OpenCaseForExpert[] | null
): boolean {
  return (
    entryMode === 'chooser' &&
    caseSelection.kind === 'new' &&
    resolvedCaseCount > 0 &&
    (openCases?.length ?? 0) === 0
  );
}

/**
 * BAL-400 — the booking flow's top-level orchestrator. Owns ALL form state (the sub-components
 * are presentational) plus the step machine, the idempotency nonce, and the two-hop submit.
 * Desktop `Dialog` / mobile `Sheet`, structurally following `auth-modal.tsx` (D4's house
 * pattern), NOT the prototype's right-edge `Drawer`.
 */
export function BookingFlowDialog(
  props: Readonly<BookingFlowDialogProps>
): React.JSX.Element | null {
  const {
    open,
    onClose,
    expert,
    source,
    entry,
    viewerEmailDomain,
    onMessage,
    productsTaxonomy = EMPTY_TAXONOMY,
    scope,
  } = props;
  const isMobile = useIsMobile(768);
  const authModal = useAuthModal();
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>('pick_time');
  const [viewerTimezone, setViewerTimezone] = useState('UTC');
  const [slot, setSlot] = useState<ConfirmSlot | null>(null);
  /** What the picker reopens with after Change / Back, so the client's length and day survive. */
  const [pickerRestore, setPickerRestore] = useState<PickerRestore | null>(null);
  const [nonce, setNonce] = useState(randomNonce);

  const [caseSelection, setCaseSelection] = useState<CaseSelection>({ kind: 'new' });
  const [title, setTitle] = useState('');
  const [descriptionHtml, setDescriptionHtml] = useState('');
  const [productIds, setProductIds] = useState<readonly string[]>([]);
  const [guests, setGuests] = useState<readonly GuestDraft[]>([]);
  const [showValidation, setShowValidation] = useState(false);

  const [companies, setCompanies] = useState<readonly EligibleCompany[] | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [companyReadFailed, setCompanyReadFailed] = useState(false);
  const [openCases, setOpenCases] = useState<readonly OpenCaseForExpert[] | null>(null);
  const [resolvedCaseCount, setResolvedCaseCount] = useState(0);
  /** UX-3 — true only while a company (re)selection's open-cases read is in flight. */
  const [caseChoiceLoading, setCaseChoiceLoading] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [staleSlot, setStaleSlot] = useState(false);
  const [bookedResult, setBookedResult] = useState<BookedSnapshot | null>(null);
  /** Set once a partial failure creates a real case — every subsequent submit attaches to it. */
  const [recovered, setRecovered] = useState<FixedCaseSummary | null>(null);
  /**
   * The case title to name on the session-expired panel, or `null` when the credential was
   * refused BEFORE any write (the pre-flight gate) and there is therefore no case to name.
   */
  const [sessionExpiredCaseTitle, setSessionExpiredCaseTitle] = useState<string | null>(null);
  /** Copy overrides for `error_hard`. `null` ⇒ the panel's own defaults. */
  const [hardFailure, setHardFailure] = useState<HardFailurePanelCopy | null>(null);
  /** BAL-478 — which `error_funding` copy arm to render. Reset every open→close→open cycle. */
  const [fundingCanManageBilling, setFundingCanManageBilling] = useState(false);
  /** BAL-474 — the case title the `error_funding` panel names, when hop 2 refused after the write. */
  const [fundingCaseTitle, setFundingCaseTitle] = useState<string | null>(null);
  /** BAL-474 — the hold / reservation refusal the `error_balance` panel renders. */
  const [balanceRefusal, setBalanceRefusal] = useState<BalanceOutcome | null>(null);
  /** BAL-474 — true while the workspace switch behind the balance panel's Top-up is in flight. */
  const [isSwitching, setIsSwitching] = useState(false);
  /** BAL-608 — the case-saved line the inline funding block names, when hop 2 refused after the write. */
  const [fundingCaseSaved, setFundingCaseSaved] = useState<CaseSavedNote | null>(null);
  /** BAL-608 — the company a full-panel setup refusal checked, for the panel's switch-and-top-up. */
  const [fundingCompany, setFundingCompany] = useState<BookingSetupFailure['company'] | null>(null);
  /** BAL-608 — how the last funding landed, for the stale-slot follow-up. */
  const [funded, setFunded] = useState<FundedVia | null>(null);
  /** BAL-608 — true while the fields on screen were restored from this device. */
  const [draftRestored, setDraftRestored] = useState(false);
  /** BAL-608 — true while a top-up, or the booking after it, locks the time, company and case. */
  const [fundingBusy, setFundingBusy] = useState(false);
  /** BAL-608 — true while a top-up's payment, credit wait or booking runs; the dialog stays open. */
  const [fundingInFlight, setFundingInFlight] = useState(false);
  /** BAL-608 — the company name the saved-for-later result names. */
  const [savedCompanyName, setSavedCompanyName] = useState<string | null>(null);
  /** Entry point 3 — the booker, once the background context read names them; keys the draft. */
  const [loadedDraftOwner, setLoadedDraftOwner] = useState<string | null>(null);

  const openFiredRef = useRef(false);
  /**
   * BAL-474 (D11.3 N3) — mirrors the `open` prop so an in-flight workspace switch can tell that the dialog
   * was closed while it was awaiting, and NOT navigate away from the page the person chose to stay on.
   */
  const openRef = useRef(open);
  openRef.current = open;
  /** Set when a submit's funding refusal has already re-read the pre-flight — see `handleFunded`. */
  const refusalReadFundingRef = useRef(false);
  /** Frozen true the moment ANY submit creates a real case row (D4b) — see `handleSubmit`. */
  const caseAlreadyCreatedRef = useRef(false);

  const { fixedCase, newCaseAllowed } = entryCasePolicy(entry);

  // Entry point 3 keeps a draft only while a NEW case is selected: a follow-up into an existing
  // case is not what "Save and finish later" saves, and must never overwrite or clear a new-case
  // draft the client left on the profile.
  const draftOwner =
    resolveDraftOwner(entry) ?? (caseSelection.kind === 'new' ? loadedDraftOwner : null);
  const draftScope = useMemo(
    () => buildDraftScope(draftOwner, expert.expertProfileId),
    [draftOwner, expert.expertProfileId]
  );

  // The read-only funding pre-flight for the booking on Review & confirm. It re-runs on any change
  // of expert, time, company or case, and shows nothing until it has an answer.
  const fundingRequest = useMemo(
    () =>
      buildFundingRequest({
        phase,
        slot,
        expertProfileId: expert.expertProfileId,
        recovered,
        caseSelection,
        companyId,
        companies,
      }),
    [phase, slot, expert.expertProfileId, recovered, caseSelection, companyId, companies]
  );
  const {
    status: fundingStatus,
    view: fundingView,
    refresh: refreshFunding,
  } = useBookingFunding(fundingRequest);
  // Only rendered inside the confirm step, so no phase check is needed here.
  const inlineFundingView = inlineRefusal(fundingView);

  const handleCompanyIdChange = useCallback(
    (id: string) => {
      setCompanyId(id);
      setOpenCases(null);
      // UX-3 — the read this fetch starts is what the case-choice skeleton renders for; cleared
      // in `finally` so it comes down on both the success and the silent-degrade paths below.
      setCaseChoiceLoading(true);
      refetchOpenCasesAction({ expertProfileId: expert.expertProfileId, companyId: id })
        .then((result) => {
          if (!result.ok) return;
          setOpenCases(result.openCases);
          setResolvedCaseCount(result.resolvedCaseCount);
        })
        .catch((error: unknown) => {
          // Silent degrade — the design's "never block on a non-critical read" principle. Still
          // captured — a swallowed rejection here previously left no trace at all.
          Sentry.captureException(error, {
            level: 'warning',
            tags: { feature: 'booking', step: 'open_cases_refetch' },
            extra: { expertProfileId: expert.expertProfileId, companyId: id },
          });
        })
        .finally(() => setCaseChoiceLoading(false));
    },
    [expert.expertProfileId]
  );

  /**
   * Put this device's draft back on screen, if there is one for a company the client can still
   * book with. The phase is left alone: the client still picks a time, because a draft never
   * carries one. A multi-company draft re-reads that company's open cases.
   */
  const restoreDraft = useCallback(
    (context: BookingContext): boolean => {
      if (draftScope === null) return false;
      const draft = readBookingDraft(draftScope, eligibleCompanyIds(context));
      if (draft === null) return false;
      setTitle(draft.title);
      setDescriptionHtml(draft.descriptionHtml);
      setProductIds(draft.productIds);
      setGuests(draft.guests);
      setCaseSelection(restoredCaseSelection(draft, context));
      if (context.arm === 'choose_company' && draft.companyId !== null) {
        handleCompanyIdChange(draft.companyId);
      }
      return true;
    },
    [draftScope, handleCompanyIdChange]
  );

  /**
   * Entry point 3 opens on its own case, so a saved new-case draft — typed here or on the
   * profile — comes back when the client switches the dropdown to "Start a new case", never by
   * flipping the case they opened from. Only into empty fields: nothing typed is overwritten.
   */
  const handleCaseSelectionChange = useCallback(
    (selection: CaseSelection): void => {
      setCaseSelection(selection);
      if (entry.mode !== 'fixed_case' || selection.kind !== 'new' || companyId === null) return;
      const nothingTyped =
        title === '' &&
        isDescriptionEmpty(descriptionHtml) &&
        productIds.length === 0 &&
        guests.length === 0;
      const scope = buildDraftScope(loadedDraftOwner, expert.expertProfileId);
      if (!nothingTyped || scope === null) return;
      const draft = readBookingDraft(scope, [companyId]);
      if (draft === null) return;
      setTitle(draft.title);
      setDescriptionHtml(draft.descriptionHtml);
      setProductIds(draft.productIds);
      setGuests(draft.guests);
      setDraftRestored(true);
    },
    [
      entry.mode,
      companyId,
      title,
      descriptionHtml,
      productIds,
      guests,
      loadedDraftOwner,
      expert.expertProfileId,
    ]
  );

  // ── reset all transient state once per open→close→open cycle (ProjectRequestPanel precedent) ──
  useEffect(() => {
    if (!open) {
      openFiredRef.current = false;
      return;
    }
    if (openFiredRef.current) return;
    openFiredRef.current = true;

    setViewerTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    setNonce(randomNonce());
    caseAlreadyCreatedRef.current = false;
    setTitle('');
    setDescriptionHtml('');
    setProductIds([]);
    setGuests([]);
    setShowValidation(false);
    setStaleSlot(false);
    setBookedResult(null);
    setRecovered(null);
    setSubmitting(false);
    setCaseChoiceLoading(false);
    setSessionExpiredCaseTitle(null);
    setFundingCanManageBilling(false);
    setFundingCaseTitle(null);
    setBalanceRefusal(null);
    setIsSwitching(false);
    setFundingCaseSaved(null);
    setFundingCompany(null);
    setFunded(null);
    setDraftRestored(false);
    setFundingBusy(false);
    setSavedCompanyName(null);
    setLoadedDraftOwner(null);

    if (entry.mode === 'fixed_case') {
      setPhase(entry.presetSlot === null ? 'pick_time' : 'confirm');
      setSlot(entry.presetSlot);
      setPickerRestore(null);
      setCaseSelection({ kind: 'existing', engagementId: entry.fixedCase.engagementId });
      setCompanies(null);
      setCompanyId(null);
      setCompanyReadFailed(false);
      setOpenCases(null);
      setResolvedCaseCount(0);
    } else {
      const { context } = entry;
      setSlot(null);
      setPickerRestore(null);
      setCaseSelection({ kind: 'new' });
      setPhase(context.arm === 'onboarding_required' ? 'onboarding' : 'pick_time');
      setCompanyReadFailed(context.arm === 'company_read_failed');
      if (context.arm === 'single_company') {
        setCompanies([context.company]);
        setCompanyId(context.company.id);
        setOpenCases(context.openCases);
        setResolvedCaseCount(context.resolvedCaseCount);
      } else if (context.arm === 'choose_company') {
        setCompanies(context.companies);
        setCompanyId(null);
        setOpenCases(null);
        setResolvedCaseCount(0);
      } else {
        setCompanies(null);
        setCompanyId(null);
        setOpenCases(null);
        setResolvedCaseCount(0);
      }
      setDraftRestored(restoreDraft(context));
    }

    track(BOOKING_EVENTS.FLOW_OPENED, { expert_id: expert.expertProfileId, source });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset fires once per open, by design
  }, [open]);

  // The case page opens on its own case — from "Book again" and from a quick-pick time alike —
  // and the client's other open cases with this expert load behind it, so the same dropdown can
  // switch case or (unless the expert has paused new work) start a new one. Only a
  // single-company context that still lists this case offers the dropdown — otherwise the case
  // stays fixed. The same read names the booker, so a new case typed here keeps its draft.
  useEffect(() => {
    if (!open || entry.mode !== 'fixed_case') return;
    const { engagementId } = entry.fixedCase;
    let cancelled = false;
    refetchBookingContextAction({ expertProfileId: expert.expertProfileId })
      .then((result) => {
        if (cancelled || !result.ok) return;
        const { context } = result;
        if (context.arm !== 'single_company') return;
        if (!context.openCases.some((c) => c.engagementId === engagementId)) return;
        setCompanies([context.company]);
        setCompanyId(context.company.id);
        setOpenCases(context.openCases);
        setResolvedCaseCount(context.resolvedCaseCount);
        setLoadedDraftOwner(context.viewerUserId);
      })
      .catch((error: unknown) => {
        // Silent degrade: the dialog still books into this case.
        Sentry.captureException(error, {
          level: 'warning',
          tags: { feature: 'booking', step: 'fixed_case_context' },
          extra: { expertProfileId: expert.expertProfileId },
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per open, like the reset above
  }, [open]);

  useEffect(() => {
    if (phase !== 'confirm') return;
    track(BOOKING_EVENTS.CONFIRM_VIEWED, {
      expert_id: expert.expertProfileId,
      entry_mode: entry.mode === 'fixed_case' ? 'fixed_case' : 'chooser',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per phase transition
  }, [phase]);

  const caseChoiceShownFiredRef = useRef(false);
  useEffect(() => {
    if (!hasCaseChoice(openCases, newCaseAllowed) || caseChoiceShownFiredRef.current) return;
    caseChoiceShownFiredRef.current = true;
    track(BOOKING_EVENTS.CASE_CHOICE_SHOWN, { open_case_count: openCases.length });
  }, [openCases, newCaseAllowed]);

  const companyShownFiredRef = useRef(false);
  useEffect(() => {
    if (companies === null || companies.length <= 1 || companyShownFiredRef.current) return;
    companyShownFiredRef.current = true;
    track(BOOKING_EVENTS.COMPANY_SELECTION_SHOWN, { eligible_count: companies.length });
  }, [companies]);

  /**
   * ⚠⚠ THE NONCE FREEZE/UN-FREEZE RULE (round 2 — round 1 changed the contract this depends
   * on). `caseAlreadyCreatedRef` freezing the nonce forever was correct ONLY as long as a
   * same-key resubmit could never be mistaken for a booking at a time the client didn't ask
   * for. Round 1's `lookupBookingReplay` broke that: a key that already names a meeting now
   * 409s `idempotency_key_conflict` on ANY window mismatch, rather than silently replaying the
   * old window — so once `recovered` pins the case by ID (a `stage:'meeting'` failure that may
   * have actually written a meeting row), reusing the frozen key for a GENUINELY DIFFERENT
   * slot would just conflict forever with no way out. Comparing against `slot` (the PREVIOUS
   * value, still in scope — nothing else mutates it between a failure and the next pick) is
   * enough; no extra ref is needed.
   *
   * Three cases, in the order below:
   *  1. No case exists yet for the current nonce — always safe to mint fresh (pre-existing).
   *  2. `recovered !== null` (case pinned by ID, not by key) AND the newly picked slot is
   *     DIFFERENT from the one that was submitted when the failure occurred — mint a NEW
   *     nonce. The case hop is unaffected (it uses `recovered.engagementId` directly); only the
   *     MEETING-hop key changes, so the new slot is booked fresh rather than conflicting with
   *     whatever the old key names.
   *  3. Otherwise — keep the SAME nonce. Either this is `slot_unavailable`'s case-grain retry
   *     (`recovered` is deliberately NOT set there — see `handleSubmit` — so re-entering the
   *     SAME case still needs the frozen key, and no meeting was ever written under it, so
   *     there is nothing to conflict with), or this is a same-slot re-pick after `recovered`,
   *     which must stay a true meeting-hop REPLAY so "Try again" stays idempotent.
   */
  const handleSlotSelect = useCallback(
    (selection: AvailabilitySlotSelection) => {
      const newSlot: ConfirmSlot = {
        startIso: selection.start,
        endIso: selection.end,
        durationMinutes: selection.duration,
      };
      setSlot(newSlot);

      const sameAsPreviousSlot =
        slot !== null && slot.startIso === newSlot.startIso && slot.endIso === newSlot.endIso;

      if (!caseAlreadyCreatedRef.current || (recovered !== null && !sameAsPreviousSlot)) {
        setNonce(randomNonce());
      }

      setStaleSlot(false);
      setFunded(null);
      setPhase('confirm');
    },
    [slot, recovered]
  );

  const handleChangeTime = useCallback(() => {
    setPickerRestore(pickerRestoreFor(slot, staleSlot));
    setStaleSlot(false);
    setFunded(null);
    setPhase('pick_time');
  }, [staleSlot, slot]);

  // A preset slot was the whole reason the dialog opened, so Back leaves rather than offering
  // a calendar the client never asked for.
  const backCloses = entry.mode === 'fixed_case' && entry.presetSlot !== null;
  const handleBack = useCallback(() => {
    if (backCloses) {
      onClose();
      return;
    }
    setPickerRestore(pickerRestoreFor(slot, staleSlot));
    setPhase('pick_time');
  }, [backCloses, onClose, slot, staleSlot]);

  const handleRetryCompanies = useCallback(async () => {
    // M3 — `requireOnboardedUser()` inside the action can still reject (an expired session);
    // the call site wraps this in `.catch(() => {})`, so without a capture here a failed retry
    // was both silent AND invisible (the banner just sits there with no signal anything was
    // attempted). `@/lib/logging` is SERVER-only (pino + `AsyncLocalStorage`, `async_hooks` is
    // not resolvable in a browser bundle) — `Sentry.captureException` is the build-safe
    // client-side equivalent, the same one `global-error.tsx` already uses.
    try {
      const result = await refetchBookingContextAction({
        expertProfileId: expert.expertProfileId,
      });
      if (!result.ok) return;
      const { context } = result;
      setCompanyReadFailed(context.arm === 'company_read_failed');
      if (context.arm === 'single_company') {
        setCompanies([context.company]);
        setCompanyId(context.company.id);
        setOpenCases(context.openCases);
        setResolvedCaseCount(context.resolvedCaseCount);
      } else if (context.arm === 'choose_company') {
        setCompanies(context.companies);
      }
    } catch (error) {
      Sentry.captureException(error, {
        tags: { feature: 'booking', step: 'retry_companies' },
        extra: { expertProfileId: expert.expertProfileId },
      });
    }
  }, [expert.expertProfileId]);

  const handleAbandon = useCallback(() => {
    if (bookedResult !== null || phase === 'saved_for_later') {
      onClose();
      return;
    }
    track(BOOKING_EVENTS.ABANDONED, {
      expert_id: expert.expertProfileId,
      step: resolveAbandonStep(phase),
    });
    onClose();
  }, [bookedResult, phase, expert.expertProfileId, onClose]);

  /** Today's full panel for a funding refusal (`error_funding` / `error_balance`). */
  const showFundingPanel = useCallback((outcome: FundingRefusalOutcome): void => {
    if (outcome.kind === 'funding') {
      setFundingCanManageBilling(outcome.canManageBilling);
      setFundingCaseTitle(outcome.caseTitle);
      setFundingCompany(outcome.company);
      setPhase('error_funding');
      return;
    }
    setBalanceRefusal(outcome);
    setIsSwitching(false);
    setPhase('error_balance');
  }, []);

  /**
   * A submit-time funding refusal. A billing manager who cannot top up from here keeps today's
   * full panel. Anyone else re-runs the pre-flight and is shown what it answers: the inline block
   * (a `hold_*` refusal re-reads as a refusal, so a failed heal reproduces its fallback), the
   * normal CTA when the booking would now pass, or the full panel when the read cannot say.
   */
  const applyFundingRefusal = useCallback(
    async (outcome: FundingRefusalOutcome): Promise<void> => {
      if (!isFullPanelOutcome(outcome)) {
        const holdRefusal = outcome.kind === 'balance' && outcome.variant === 'hold';
        refusalReadFundingRef.current = true;
        const view = await refreshFunding({ onCoveredHold: holdRefusal ? 'refuse' : 'defer' });
        if (view?.kind === 'clear') {
          toast.info(BALANCE_NOW_COVERS_COPY);
          return;
        }
        if (inlineRefusal(view) !== null) {
          setFundingCaseSaved(caseSavedNote(outcome.caseTitle, expert.partyLabel));
          setPhase('confirm');
          return;
        }
      }
      showFundingPanel(outcome);
    },
    [refreshFunding, showFundingPanel, expert.partyLabel]
  );

  /**
   * Every `{ ok: false }` arm of a submit, kept out of `handleSubmit` so that function holds
   * only the happy path. Each arm ends the submit — there is no fallthrough to a booked state.
   */
  const applySubmitFailure = useCallback(
    async (result: Extract<BookConsultationResult, { ok: false }>): Promise<void> => {
      // ⚠ ANY `stage: 'meeting'` failure means the CASE row already exists (Data Flow steps
      // 4-8 run to completion before `postBookMeeting` at step 9) — mark the nonce frozen so a
      // later slot re-pick reuses the SAME `bookingIdempotencyKey` and re-enters against that
      // case rather than minting a second one (D4b).
      if (result.stage === 'meeting') {
        caseAlreadyCreatedRef.current = true;
      }
      const outcome = resolveSubmitFailureOutcome(result);
      if (outcome.kind === 'stale_slot') {
        // ⚠ STALE SLOT STAYS IN "NEW CASE" FORM SHAPE — design's "all other field values
        // preserved" means title/description/products/company stay EDITABLE, not switched to
        // the read-only attach card. `recovered` is deliberately NOT set here; the frozen
        // nonce above is what makes the eventual resubmit idempotent against the same case.
        setStaleSlot(true);
        return;
      }
      if (outcome.kind === 'impersonation_refused') {
        setHardFailure(IMPERSONATION_REFUSAL_PANEL);
        setPhase('error_hard');
        return;
      }
      if (outcome.kind === 'expert_unavailable') {
        setPhase('error_unavailable');
        return;
      }
      if (outcome.kind === 'session_expired') {
        // ⚠ A `caseTitle` MEANS A CASE ROW WAS ALREADY WRITTEN and the meeting hop got the
        // 401 — an open case with no consultation on it, which nothing downstream reports.
        // The generic hard arm below logs to Sentry; this one would otherwise pass silently.
        if (outcome.caseTitle !== null) {
          Sentry.captureMessage('Booking credential expired after the case row was written', {
            level: 'warning',
            tags: { feature: 'booking', code: 'session_expired' },
            extra: { expertProfileId: expert.expertProfileId, caseTitle: outcome.caseTitle },
          });
        }
        track(BOOKING_EVENTS.SESSION_EXPIRED, {
          expert_id: expert.expertProfileId,
          stage: outcome.caseTitle === null ? 'preflight' : 'mid_submit',
        });
        setSessionExpiredCaseTitle(outcome.caseTitle);
        setPhase('error_session');
        return;
      }
      if (outcome.kind === 'partial') {
        setRecovered({
          engagementId: outcome.engagementId,
          title: outcome.caseTitle,
          consultationCount: 0,
          openedAtIso: new Date().toISOString(),
        });
        setPhase('error_partial');
        return;
      }
      if (outcome.kind === 'company_fail_closed') {
        // M4 — a company-hop failure (a stale eligibility read, a race) must FAIL CLOSED, not
        // dead-end on the generic hard panel with an invisible picker (Plan Decision 5: "read
        // failed → Fail closed — inline retry banner where the picker would be; Confirm stays
        // disabled"). Reuse the SAME `company_read_failed` retry banner rather than a second
        // copy — `companyReadFailed` is already wired into `submitDisabled` below.
        // A returned `{ok:false}`, not a thrown error — `captureMessage`, not
        // `captureException` (there is no `Error` object to attach here).
        Sentry.captureMessage('Booking failed at the company hop', {
          level: 'warning',
          tags: { feature: 'booking', code: outcome.code },
          extra: { expertProfileId: expert.expertProfileId },
        });
        setCompanyReadFailed(true);
        setPhase('confirm');
        return;
      }
      if (outcome.kind === 'funding' || outcome.kind === 'balance') {
        // BAL-478 / BAL-474 — an expected business refusal, not an exception: nothing is wrong with
        // the slot, the case or the session. NO Sentry capture and NO client `track()` — the
        // server-side event in `enforceBookingFunding` is the single emit for this refusal.
        await applyFundingRefusal(outcome);
        return;
      }
      setHardFailure(null);
      setPhase('error_hard');
    },
    [expert.expertProfileId, applyFundingRefusal]
  );

  /**
   * Resolves `true` once the consultation is booked. Every other end (a validation stop, a
   * refusal, a thrown error) resolves `false`, which is what lets a funded booking know whether
   * its booking landed.
   */
  const handleSubmit = useCallback(async (): Promise<boolean> => {
    setShowValidation(true);
    if (slot === null) return false;

    const effectiveCaseChoice = resolveEffectiveCaseChoice({
      recovered,
      caseSelection,
      title,
      descriptionHtml,
      productIds,
      companyId,
    });

    // M2 — description is required by the DB CHECK, the design and the AC, but nothing gated
    // it client-side. A REAL-TEXT check (not markup non-emptiness — a bare `<p></p>` must
    // fail) so the ordinary path (title filled, description left blank) never reaches the
    // server, where it previously dead-ended on the generic hard-failure panel.
    if (hasBlockingValidationError(effectiveCaseChoice, companies, companyId)) return false;

    setSubmitting(true);
    setStaleSlot(false);

    // M3 — `bookConsultationAction` CAN reject (an expired session, an unguarded eligibility
    // read, …), and this whole body used to run with no `try`: a rejection propagated past the
    // `setSubmitting(false)` below, which never ran, so "Booking…" spun forever with nothing
    // logged and nothing shown. The `finally` below is what makes `submitting` unconditional.
    try {
      const result = await bookConsultationAction({
        expertProfileId: expert.expertProfileId,
        slot,
        bookingNonce: nonce,
        guests,
        caseChoice: effectiveCaseChoice,
      });

      if (!result.ok) {
        await applySubmitFailure(result);
        return false;
      }

      setBookedResult({
        engagementId: result.engagementId,
        meetingId: result.meetingId,
        joinPath: result.joinPath,
        provisioned: result.provisioned,
        isNewCase: result.isNewCase,
        caseTitle: result.caseTitle,
        scheduledStartIso: result.scheduledStartIso,
        durationMinutes: result.durationMinutes,
        guestsInvited: result.guestsInvited,
        guestInviteFailed: result.guestInviteFailed,
      });
      fireBookingSuccessAnalytics({
        result,
        effectiveCaseChoice,
        guests,
        viewerEmailDomain,
        recovered,
        caseSelection,
        openCases,
        expertProfileId: expert.expertProfileId,
      });
      // ⚠ `result.durationMinutes`, never `slot.durationMinutes` (S2) — the toast reports the
      // meeting the server booked, which on a replay is not the slot just picked.
      toast.success('Booked', {
        description: `${result.durationMinutes}-minute consultation with ${expert.firstName ?? expert.name} confirmed.`,
      });
      if (draftScope !== null) clearBookingDrafts(draftScope);
      setFunded(null);
      setFundingCaseSaved(null);
      setPhase('booked');
      return true;
    } catch (error) {
      // M3 — every OTHER catch site around this action was a bare `.catch(() => {})`. This is
      // now the ONE place a rejection is handled: captured (the client-side equivalent of
      // CLAUDE.md's catch-boundary log rule — see the `handleRetryCompanies` note on why
      // `Sentry.captureException`, not `@/lib/logging`, is correct here) and surfaced to the
      // hard panel, rather than swallowed with the button frozen mid-spin.
      Sentry.captureException(error, {
        tags: { feature: 'booking', step: 'submit' },
        extra: { expertProfileId: expert.expertProfileId },
      });
      setPhase('error_hard');
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [
    slot,
    recovered,
    caseSelection,
    title,
    descriptionHtml,
    productIds,
    companyId,
    companies,
    expert.expertProfileId,
    expert.firstName,
    expert.name,
    nonce,
    guests,
    openCases,
    viewerEmailDomain,
    applySubmitFailure,
    draftScope,
  ]);

  /**
   * Re-authenticate WITHOUT leaving the dialog. `AuthModalProvider` is mounted at the app root,
   * so the modal opens over this one and the flow behind it is never unmounted.
   *
   * ⚠ NAVIGATING TO `/login` WOULD STRAND THE USER, which this panel's copy promises it will
   * not do: `/login` opens the same modal with no `onSuccess`, `password-step` navigates only
   * when the account still needs onboarding, and the page ignores a `'success'` close — so an
   * already-onboarded user lands on its "Preparing sign in…" placeholder with the slot, the
   * draft and the nonce gone.
   *
   * ⚠ THE NONCE IS DELIBERATELY NOT RESET. On the mid-submit arm the case row already exists;
   * re-entering with the SAME `bookingIdempotencyKey` books onto that case instead of minting a
   * second one — the same reasoning as the frozen nonce on the partial-failure arm.
   *
   * ⚠ OAUTH STILL LEAVES THE PAGE. The draft cannot survive a full-document navigation to the
   * identity provider, so only the email/password arm resumes in place.
   */
  const handleReauthenticate = useCallback(() => {
    authModal.open({
      initialError: SESSION_EXPIRED_MESSAGE,
      onSuccess: () => setPhase('confirm'),
    });
  }, [authModal]);

  const handleRetryAfterPartial = useCallback(() => {
    setPhase('confirm');
    handleSubmit().catch(() => {});
  }, [handleSubmit]);

  const handleChooseDifferentTimeAfterPartial = useCallback(() => {
    setPickerRestore(pickerRestoreFor(slot, true));
    setPhase('pick_time');
  }, [slot]);

  /** Keeps the typed fields on this device, for a client who leaves this dialog or is signed out. */
  const writeCurrentDraft = useCallback((): void => {
    if (draftScope === null) return;
    writeBookingDraft(draftScope, {
      title,
      descriptionHtml,
      productIds,
      guests,
      caseSelection,
      companyId,
    });
  }, [draftScope, title, descriptionHtml, productIds, guests, caseSelection, companyId]);

  /**
   * ⚠⚠ THE BALANCE PANEL'S TOP-UP TARGETS THE COMPANY THAT REFUSED. `/billing/top-up` tops up the
   * ACTIVE workspace's company, which may not be the company this booking bills (a user in two
   * companies). So when the held company is the active one the action just navigates; otherwise
   * it switches workspace to the held company first (the BAL-494 action) and only then navigates.
   *
   * A failed switch (a returned failure OR a thrown action) toasts and STAYS on the panel — never
   * a silent navigation to a page that would top up the wrong company. There is no success toast:
   * the navigation is the feedback (the `meeting-frame-impl` precedent). On success the spinner is
   * deliberately left up — the page is navigating away, and re-enabling the button would open a
   * double-switch window.
   */
  const switchAndTopUp = useCallback(
    async (company: BookingSetupFailure['company']): Promise<void> => {
      // The client leaves this dialog for the top-up page, so what they typed waits on the device.
      writeCurrentDraft();
      if (company.isActive) {
        router.push('/billing/top-up');
        return;
      }
      setIsSwitching(true);
      try {
        const result = await switchWorkspaceAction(companyWorkspaceKey(company.id));
        if (result.success) {
          // The dialog may have been closed while the switch was in flight — never navigate then.
          if (openRef.current) {
            router.push('/billing/top-up');
          } else {
            setIsSwitching(false);
          }
          return;
        }
      } catch (error) {
        // `@/lib/logging` is SERVER-only — `Sentry.captureException` is the build-safe client-side
        // equivalent (see `handleRetryCompanies`).
        Sentry.captureException(error, {
          tags: { feature: 'booking', step: 'top_up_workspace_switch' },
          extra: { companyId: company.id },
        });
      }
      toast.error(bookingSwitchFailedCopy(company.name));
      setIsSwitching(false);
    },
    [writeCurrentDraft, router]
  );

  const handleTopUpClick = useCallback(() => {
    if (balanceRefusal === null) return;
    switchAndTopUp(balanceRefusal.company).catch(() => {});
  }, [balanceRefusal, switchAndTopUp]);

  const handleSwitchAndTopUpClick = useCallback(() => {
    if (fundingCompany === null) return;
    switchAndTopUp(fundingCompany).catch(() => {});
  }, [fundingCompany, switchAndTopUp]);

  const submitDisabled =
    submitting ||
    slot === null ||
    // M4 — fail CLOSED (Plan Decision 5). Without this, a client whose eligibility read is
    // failing sees the retry banner AND a live Confirm button; pressing it re-reads
    // eligibility server-side, finds >1 company, and dead-ends on the generic hard panel with
    // no picker ever having rendered.
    companyReadFailed ||
    (caseSelection.kind === 'new' &&
      recovered === null &&
      companies !== null &&
      companies.length > 1 &&
      companyId === null);

  /**
   * The funding block's pre-payment gate, also used by Save: show the form's validation, refuse
   * while it blocks a booking, and otherwise write the draft so a payment that outlives this
   * dialog still has the fields waiting.
   */
  const prepareFunding = useCallback((): boolean => {
    setShowValidation(true);
    const choice = resolveEffectiveCaseChoice({
      recovered,
      caseSelection,
      title,
      descriptionHtml,
      productIds,
      companyId,
    });
    if (hasBlockingValidationError(choice, companies, companyId) || submitDisabled) {
      findFirstInvalidField({
        isNewCase: choice.kind === 'new',
        title: choice.kind === 'new' ? choice.title : '',
        descriptionHtml: choice.kind === 'new' ? choice.descriptionHtml : '',
        companyMissing:
          choice.kind === 'new' && companies !== null && companies.length > 1 && companyId === null,
      })?.focus();
      return false;
    }
    writeCurrentDraft();
    return true;
  }, [
    recovered,
    caseSelection,
    title,
    descriptionHtml,
    productIds,
    companyId,
    companies,
    submitDisabled,
    writeCurrentDraft,
  ]);

  /**
   * The wallet shows the top-up, so book with the SAME nonce as the refused submit. When the
   * booking does not land (the time went, or the gate refused again) the pre-flight is re-read,
   * so a credit that has landed clears the block before any second payment is offered. A funding
   * refusal re-reads it on its own way out, so that read is not repeated here.
   */
  const handleFunded = useCallback(
    async (via: FundedVia): Promise<boolean> => {
      setFunded(via);
      refusalReadFundingRef.current = false;
      const booked = await handleSubmit();
      if (!booked && !refusalReadFundingRef.current) await refreshFunding();
      return booked;
    },
    [handleSubmit, refreshFunding]
  );

  const handleSaveForLater = useCallback(async (): Promise<void> => {
    if (fundingRequest === null || !prepareFunding()) return;
    const outcome = await saveForLater(fundingRequest);
    if (outcome === 'saved') {
      track(BOOKING_EVENTS.SAVED_FOR_LATER, {});
      toast.success('Saved for later');
      setSavedCompanyName(inlineFundingView?.company.name ?? null);
      setPhase('saved_for_later');
      return;
    }
    if (outcome === 'bookable_now') {
      toast.info('Good news — this can be booked now.');
      await refreshFunding();
      return;
    }
    toast.error(SAVE_FOR_LATER_FAILED_COPY);
  }, [fundingRequest, prepareFunding, inlineFundingView, refreshFunding]);

  const handleClearDraft = useCallback(() => {
    if (draftScope !== null) clearBookingDrafts(draftScope);
    setTitle('');
    setDescriptionHtml('');
    setProductIds([]);
    setGuests([]);
    setCaseSelection({ kind: 'new' });
    setShowValidation(false);
    setDraftRestored(false);
    toast.success(DRAFT_CLEARED_COPY);
  }, [draftScope]);

  // The read-only attach card's data, resolved from whichever source applies: a partial-failure
  // recovery, entry point 3's fixed case, or a chooser selection matched against `openCases`.
  function resolveChooserCaseContext(): FixedCaseSummary | null {
    if (caseSelection.kind !== 'existing') return null;
    const match = openCases?.find((c) => c.engagementId === caseSelection.engagementId);
    if (match === undefined) return null;
    return {
      engagementId: match.engagementId,
      title: match.title,
      consultationCount: match.consultationCount,
      openedAtIso: match.createdAt,
    };
  }
  const fixedCaseSelected = isFixedCaseSelected(fixedCase, caseSelection);
  const caseContextSummary: FixedCaseSummary | null =
    recovered ?? (fixedCaseSelected ? fixedCase : resolveChooserCaseContext());

  // The chooser is hidden once a partial-failure recovery pinned the case (avoids a confusing
  // "nothing selected" state — the new case isn't in `openCases` yet). Entry point 3 shows it
  // only once its background context read has listed the client's open cases.
  const effectiveOpenCases: readonly OpenCaseForExpert[] | null =
    recovered === null ? openCases : null;

  const showResolvedCaseNote = isResolvedCaseNoteShown(
    entry.mode,
    caseSelection,
    resolvedCaseCount,
    openCases
  );

  // `companies`/`companyId` are always kept in sync with the resolved arm (including after a
  // retry), so deriving from local state — rather than re-reading `entry.context` — is correct
  // for every arm, including `single_company` (seeded as `companies: [company], companyId:
  // company.id` on open).
  const clientCompanyName = companies?.find((c) => c.id === companyId)?.name ?? null;
  // UX-1 — derived from the real (un-nulled) `companies` state, so the billing-account note
  // stays visible on the attach shape, where the `companies` PROP passed to `StepConfirm`
  // below is deliberately forced to `null` (it also gates the new-case-only `CompanyPicker`).
  const hasMultipleEligibleCompanies = companies !== null && companies.length > 1;

  if (!open) return null;

  const bookingStep = toBookingStep(phase);

  /**
   * ⚠ `min-h-0 flex-1`, never `h-full`, and the container must be `flex flex-col`.
   * `DialogContent` is `display: grid` and capped with `max-h-[85vh]` and no definite height, so
   * a child's `height: 100%` cannot resolve and falls back to `auto` — the column grows to
   * content height, the `overflow-y-auto` below inherits it and has nothing to scroll, and the
   * surplus is clipped. `flex-1` + `min-h-0` resolves against the clamped height.
   */
  const body = (
    <div className="flex min-h-0 flex-1 flex-col">
      <BookingHeader expert={expert} step={bookingStep} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <AnimatePresence mode="wait">
          {phase === 'onboarding' && (
            <motion.div key="onboarding" {...pageTransition}>
              <OnboardingRoutingState expertFirstName={expert.firstName} onClose={onClose} />
            </motion.div>
          )}
          {phase === 'pick_time' && (
            <motion.div key="pick_time" {...pageTransition}>
              <StepPickTime
                expertProfileId={expert.expertProfileId}
                expertFirstName={expert.firstName}
                onSlotSelect={handleSlotSelect}
                onMessage={onMessage}
                scope={scope}
                similarExpertsHref={expert.similarExpertsHref}
                lengthNote={<LengthNote billing="per_minute" />}
                {...pickerRestore}
              />
            </motion.div>
          )}
          {phase === 'confirm' && slot !== null && (
            <motion.div key="confirm" {...pageTransition} className="mx-auto w-full max-w-[640px]">
              {showResolvedCaseNote && (
                <p className="text-muted-foreground px-6 pt-4 text-xs leading-relaxed">
                  Your last case with {expert.firstName ?? 'this expert'} is resolved — this starts
                  a new one.
                </p>
              )}
              <StepConfirm
                slot={slot}
                viewerTimezone={viewerTimezone}
                expertFirstName={expert.firstName}
                onChangeTime={handleChangeTime}
                openCases={effectiveOpenCases}
                offerNewCase={newCaseAllowed}
                caseChoiceLoading={caseChoiceLoading}
                caseSelection={
                  recovered === null
                    ? caseSelection
                    : { kind: 'existing', engagementId: recovered.engagementId }
                }
                onCaseSelectionChange={handleCaseSelectionChange}
                caseContextSummary={caseContextSummary}
                title={title}
                onTitleChange={setTitle}
                descriptionHtml={descriptionHtml}
                onDescriptionChange={setDescriptionHtml}
                productIds={productIds}
                onProductIdsChange={setProductIds}
                productsTaxonomy={productsTaxonomy}
                showValidation={showValidation}
                companies={caseSelection.kind === 'new' && recovered === null ? companies : null}
                companyReadFailed={companyReadFailed}
                onRetryCompanies={() => {
                  handleRetryCompanies().catch(() => {});
                }}
                companyId={companyId}
                onCompanyIdChange={handleCompanyIdChange}
                hasMultipleEligibleCompanies={hasMultipleEligibleCompanies}
                guests={guests}
                onGuestsChange={setGuests}
                viewerEmailDomain={viewerEmailDomain}
                clientCompanyName={clientCompanyName}
                staleSlot={staleSlot}
                staleSlotFollowUp={staleSlotFollowUp(staleSlot, funded)}
                fundingSection={
                  inlineFundingView === null ? null : (
                    <BookingFundingBlock
                      view={inlineFundingView}
                      caseSaved={fundingCaseSaved}
                      ctaDisabled={submitDisabled}
                      onBeforePay={prepareFunding}
                      onFunded={handleFunded}
                      onSaveForLater={handleSaveForLater}
                      onBack={handleBack}
                      draftKept={draftScope !== null}
                      onBusyChange={setFundingBusy}
                      onInFlightChange={setFundingInFlight}
                    />
                  )
                }
                fundingBusy={fundingBusy}
                preflightPending={fundingStatus === 'loading'}
                draftNotice={
                  draftRestored && draftScope !== null ? { onClear: handleClearDraft } : null
                }
                submitting={submitting}
                submitDisabled={submitDisabled}
                onBack={handleBack}
                onSubmit={() => {
                  handleSubmit().catch(() => {});
                }}
              />
            </motion.div>
          )}
          {phase === 'booked' && bookedResult !== null && (
            <motion.div key="booked" {...pageTransition}>
              <StepBooked
                engagementId={bookedResult.engagementId}
                caseTitle={bookedResult.caseTitle}
                isNewCase={bookedResult.isNewCase}
                expertFirstName={expert.firstName}
                /* ⚠ THE SERVER'S WINDOW (S2) — never `slot`, which is only what was asked for. */
                startIso={bookedResult.scheduledStartIso}
                viewerTimezone={viewerTimezone}
                durationMinutes={bookedResult.durationMinutes}
                provisioned={bookedResult.provisioned}
                joinPath={bookedResult.joinPath}
                guestsInvited={bookedResult.guestsInvited}
                guestInviteFailed={bookedResult.guestInviteFailed}
                onDone={onClose}
              />
            </motion.div>
          )}
          {phase === 'saved_for_later' && (
            <motion.div key="saved_for_later" {...pageTransition}>
              <StepSavedForLater
                companyName={savedCompanyName}
                expertFirstName={expert.firstName}
                draftKept={draftScope !== null}
                onDone={onClose}
              />
            </motion.div>
          )}
          {phase === 'error_hard' && (
            <motion.div key="error_hard" {...pageTransition}>
              <HardFailurePanel
                {...hardFailureCopy(hardFailure, funded)}
                onRetry={() => {
                  setHardFailure(null);
                  setPhase('confirm');
                  handleSubmit().catch(() => {});
                }}
              />
            </motion.div>
          )}
          {phase === 'error_unavailable' && (
            <motion.div key="error_unavailable" {...pageTransition}>
              <ExpertUnavailablePanel
                expertFirstName={expert.firstName}
                similarExpertsHref={expert.similarExpertsHref}
                onClose={onClose}
              />
            </motion.div>
          )}
          {phase === 'error_session' && (
            <motion.div key="error_session" {...pageTransition}>
              <SessionExpiredPanel
                caseTitle={sessionExpiredCaseTitle}
                followUp={fundedLine(funded, fundedSessionFollowUp)}
                onSignIn={handleReauthenticate}
                onClose={onClose}
              />
            </motion.div>
          )}
          {phase === 'error_partial' && recovered !== null && (
            <motion.div key="error_partial" {...pageTransition}>
              <PartialFailurePanel
                caseTitle={recovered.title}
                followUp={fundedLine(funded, fundedPartialFollowUp)}
                onRetry={handleRetryAfterPartial}
                onChooseDifferentTime={handleChooseDifferentTimeAfterPartial}
                onFinishLater={onClose}
              />
            </motion.div>
          )}
          {phase === 'error_funding' && (
            <motion.div key="error_funding" {...pageTransition}>
              <FundingSetupPanel
                canManageBilling={fundingCanManageBilling}
                onManageBilling={() => router.push('/settings/billing')}
                company={fundingCompany}
                isSwitching={isSwitching}
                onSwitchAndTopUp={handleSwitchAndTopUpClick}
                onClose={onClose}
                caseSaved={
                  fundingCaseTitle === null
                    ? null
                    : { caseTitle: fundingCaseTitle, expertLabel: expert.partyLabel }
                }
              />
            </motion.div>
          )}
          {phase === 'error_balance' && balanceRefusal !== null && (
            <motion.div key="error_balance" {...pageTransition}>
              <BookingBalancePanel
                {...buildBalancePanelProps(balanceRefusal, {
                  expertLabel: expert.partyLabel,
                  isSwitching,
                  onTopUp: handleTopUpClick,
                  onClose,
                })}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );

  // Stripe's 3DS and Link frames live on `body`, outside this modal; see `stripe-outside-guard`.
  const guardOutside = guardStripeOutsideInteraction(fundingInFlight);

  if (isMobile) {
    return (
      <Sheet
        open={open}
        onOpenChange={(next) => !next && !isSwitching && !fundingInFlight && handleAbandon()}
      >
        <SheetContent
          side="bottom"
          className="max-h-[94dvh] overflow-hidden rounded-t-2xl p-0"
          onInteractOutside={guardOutside}
          onPointerDownOutside={guardOutside}
        >
          <SheetTitle className="sr-only">Book a consultation with {expert.name}</SheetTitle>
          <SheetDescription className="sr-only">
            Pick a time, review the details, and confirm your consultation.
          </SheetDescription>
          {body}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && !isSwitching && !fundingInFlight && handleAbandon()}
    >
      {/* Same width, same reason, as reschedule-dialog.tsx — Step 1 embeds the identical
          calendar and was squeezed the same way at 640px. */}
      <DialogContent
        className="flex max-h-[85vh] flex-col overflow-hidden rounded-xl p-0 sm:max-w-[min(92vw,840px)]"
        onInteractOutside={guardOutside}
        onPointerDownOutside={guardOutside}
      >
        <DialogTitle className="sr-only">Book a consultation with {expert.name}</DialogTitle>
        <DialogDescription className="sr-only">
          Pick a time, review the details, and confirm your consultation.
        </DialogDescription>
        {body}
      </DialogContent>
    </Dialog>
  );
}
