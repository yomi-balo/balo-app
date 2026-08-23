'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import * as Sentry from '@sentry/nextjs';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { track, BOOKING_EVENTS } from '@/lib/analytics';
import { isDescriptionEmpty } from '@/components/balo/rich-text/plain-text';
import { EMPTY_TAXONOMY } from '@/lib/search/taxonomy';
import { bookConsultationAction } from '@/lib/booking/actions/book-consultation';
import { refetchOpenCasesAction } from '@/lib/booking/actions/refetch-open-cases';
import { refetchBookingContextAction } from '@/lib/booking/actions/refetch-booking-context';
import type { AvailabilitySlotSelection } from '@/components/availability';
import type { BookConsultationResult, BookingFailureCode } from '@/lib/booking/actions/types';
import type { EligibleCompany } from '@balo/shared/credit';
import { BookingHeader, type BookingStep } from './booking-header';
import { StepPickTime } from './step-pick-time';
import { StepConfirm, type CaseSelection, type ConfirmSlot } from './step-confirm';
import { StepBooked } from './step-booked';
import { OnboardingRoutingState } from './onboarding-routing-state';
import { HardFailurePanel, PartialFailurePanel } from './booking-error-panels';
import type { GuestDraft } from './guest-invite-composer';
import type { BookingFlowDialogProps, FixedCaseSummary, OpenCaseForExpert } from './types';

type Phase = 'onboarding' | 'pick_time' | 'confirm' | 'booked' | 'error_hard' | 'error_partial';

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

type SubmitFailureOutcome =
  | { kind: 'stale_slot' }
  | { kind: 'partial'; engagementId: string; caseTitle: string }
  | { kind: 'company_fail_closed'; code: BookingFailureCode }
  | { kind: 'hard' };

/**
 * `handleSubmit`'s failure-branch classification, pulled out to a pure function so the
 * component body only has to switch on an already-resolved discriminant. Order matters and is
 * preserved exactly from the original inline chain: `slot_unavailable` first (never treated as
 * a case-level partial failure, even though it also carries `engagementId`/`caseTitle`), then
 * any `stage:'meeting'` failure that names a case (the partial-recovery arm, D4b), then a
 * `stage:'company'` failure (M4's fail-closed arm), then the generic hard failure.
 */
function resolveSubmitFailureOutcome(
  result: Extract<BookConsultationResult, { ok: false }>
): SubmitFailureOutcome {
  if (result.code === 'slot_unavailable') {
    return { kind: 'stale_slot' };
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
  } = props;
  const isMobile = useIsMobile(768);

  const [phase, setPhase] = useState<Phase>('pick_time');
  const [viewerTimezone, setViewerTimezone] = useState('UTC');
  const [slot, setSlot] = useState<ConfirmSlot | null>(null);
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

  const openFiredRef = useRef(false);
  /** Frozen true the moment ANY submit creates a real case row (D4b) — see `handleSubmit`. */
  const caseAlreadyCreatedRef = useRef(false);

  const fixedCase = entry.mode === 'fixed_case' ? entry.fixedCase : null;

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

    if (entry.mode === 'fixed_case') {
      setPhase('confirm');
      setSlot(entry.presetSlot);
      setCaseSelection({ kind: 'existing', engagementId: entry.fixedCase.engagementId });
      setCompanies(null);
      setCompanyId(null);
      setCompanyReadFailed(false);
      setOpenCases(null);
      setResolvedCaseCount(0);
    } else {
      const { context } = entry;
      setSlot(null);
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
    }

    track(BOOKING_EVENTS.FLOW_OPENED, { expert_id: expert.expertProfileId, source });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset fires once per open, by design
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
    if (openCases === null || openCases.length === 0 || caseChoiceShownFiredRef.current) return;
    caseChoiceShownFiredRef.current = true;
    track(BOOKING_EVENTS.CASE_CHOICE_SHOWN, { open_case_count: openCases.length });
  }, [openCases]);

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

      if (!caseAlreadyCreatedRef.current) {
        setNonce(randomNonce());
      } else if (recovered !== null && !sameAsPreviousSlot) {
        setNonce(randomNonce());
      }

      setStaleSlot(false);
      setPhase('confirm');
    },
    [slot, recovered]
  );

  const handleChangeTime = useCallback(() => {
    setStaleSlot(false);
    setPhase('pick_time');
  }, []);

  const handleBack = useCallback(() => {
    if (entry.mode === 'fixed_case') {
      onClose();
      return;
    }
    setPhase('pick_time');
  }, [entry.mode, onClose]);

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

  const handleAbandon = useCallback(() => {
    if (bookedResult !== null) {
      onClose();
      return;
    }
    track(BOOKING_EVENTS.ABANDONED, {
      expert_id: expert.expertProfileId,
      step: resolveAbandonStep(phase),
    });
    onClose();
  }, [bookedResult, phase, expert.expertProfileId, onClose]);

  const handleSubmit = useCallback(async () => {
    setShowValidation(true);
    if (slot === null) return;

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
    if (hasBlockingValidationError(effectiveCaseChoice, companies, companyId)) return;

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
        setPhase('error_hard');
        return;
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
      setPhase('booked');
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
  ]);

  const handleRetryAfterPartial = useCallback(() => {
    setPhase('confirm');
    handleSubmit().catch(() => {});
  }, [handleSubmit]);

  const handleChooseDifferentTimeAfterPartial = useCallback(() => {
    setPhase('pick_time');
  }, []);

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
  const caseContextSummary: FixedCaseSummary | null =
    recovered ?? fixedCase ?? resolveChooserCaseContext();

  const showCaseEscapeHatch = entry.mode === 'chooser' && recovered === null;
  // The chooser is hidden once EITHER a partial-failure recovery pinned the case (avoids a
  // confusing "nothing selected" radio state — the new case isn't in `openCases` yet) OR
  // entry point 3 already fixed it (D4a #3 — no chooser in the tree at all).
  let effectiveOpenCases: readonly OpenCaseForExpert[] | null = null;
  if (recovered === null && entry.mode === 'chooser') {
    effectiveOpenCases = openCases;
  }

  const showResolvedCaseNote =
    entry.mode === 'chooser' &&
    caseSelection.kind === 'new' &&
    resolvedCaseCount > 0 &&
    (openCases?.length ?? 0) === 0;

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

  const body = (
    <div className="flex h-full flex-col">
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
              />
            </motion.div>
          )}
          {phase === 'confirm' && slot !== null && (
            <motion.div key="confirm" {...pageTransition}>
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
                caseChoiceLoading={caseChoiceLoading}
                caseSelection={
                  recovered === null
                    ? caseSelection
                    : { kind: 'existing', engagementId: recovered.engagementId }
                }
                onCaseSelectionChange={setCaseSelection}
                caseContextSummary={caseContextSummary}
                showCaseEscapeHatch={showCaseEscapeHatch}
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
          {phase === 'error_hard' && (
            <motion.div key="error_hard" {...pageTransition}>
              <HardFailurePanel
                onRetry={() => {
                  setPhase('confirm');
                  handleSubmit().catch(() => {});
                }}
              />
            </motion.div>
          )}
          {phase === 'error_partial' && recovered !== null && (
            <motion.div key="error_partial" {...pageTransition}>
              <PartialFailurePanel
                caseTitle={recovered.title}
                onRetry={handleRetryAfterPartial}
                onChooseDifferentTime={handleChooseDifferentTimeAfterPartial}
                onFinishLater={onClose}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={(next) => !next && handleAbandon()}>
        <SheetContent side="bottom" className="max-h-[94dvh] overflow-hidden rounded-t-2xl p-0">
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
    <Dialog open={open} onOpenChange={(next) => !next && handleAbandon()}>
      <DialogContent className="max-h-[85vh] overflow-hidden rounded-xl p-0 sm:max-w-[640px]">
        <DialogTitle className="sr-only">Book a consultation with {expert.name}</DialogTitle>
        <DialogDescription className="sr-only">
          Pick a time, review the details, and confirm your consultation.
        </DialogDescription>
        {body}
      </DialogContent>
    </Dialog>
  );
}
