'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { track, EXPERT_EVENTS } from '@/lib/analytics';
import { saveDraftAction } from '../_actions/save-draft';
import { submitApplicationAction } from '../_actions/submit-application';
import {
  STEP_CONFIG,
  type StepKey,
  type AgencyStepData,
  type ProfileStepData,
  type ProductsStepData,
  type AssessmentStepData,
  type CertificationsStepData,
  type WorkHistoryStepData,
  type TermsStepData,
} from '../_actions/schemas';
import type { ReferenceData } from '../_actions/load-draft';
import type { ApplicationWithRelations } from '@balo/db';
import {
  readAnonymousDraft,
  writeAnonymousDraft,
  clearAnonymousDraft,
  type AnonymousApplicationDraftV1,
} from '@/lib/expert-apply/anonymous-draft';
import { flushAnonymousDraft } from '@/lib/expert-apply/flush-anonymous-draft';
import { reloadWithToast, consumePendingToast } from '@/lib/expert-apply/reload-with-toast';

// ── Types ────────────────────────────────────────────────────────

type StepStatus = 'pending' | 'completed' | 'skipped';
type AutoSaveState = 'idle' | 'saving' | 'saved' | 'error';
type Direction = 'forward' | 'backward';
export type SubmitState = 'idle' | 'submitting' | 'success';

interface WizardState {
  expertProfileId: string | null;
  currentStep: number;
  maxReachedStep: number;
  stepStatuses: StepStatus[];
  direction: Direction;
  autoSaveState: AutoSaveState;
  submitState: SubmitState;
  agencyData: Partial<AgencyStepData>;
  profileData: Partial<ProfileStepData>;
  productsData: Partial<ProductsStepData>;
  assessmentData: Partial<AssessmentStepData>;
  certificationsData: Partial<CertificationsStepData>;
  workHistoryData: Partial<WorkHistoryStepData>;
  termsData: Partial<TermsStepData>;
  referenceData: ReferenceData;
  /**
   * `null` for an anonymous visitor (BAL-502 §22); `{ id }` when signed in. FIX round
   * (smaller item) — `email` was dropped: nothing under `_components/` ever reads
   * `.id` or `.email` off this value (only its nullness matters, for `isAnonymous`
   * and the post-auth-flush effect's dependency array), so shipping the visitor's
   * own email into the client payload was dead weight. `id` is kept as a stable,
   * harmless identifier for any future consumer (logging, etc.).
   */
  user: { id: string } | null;
  /** `true` when `user === null` — the sole anonymous signal (BAL-502 §22). */
  isAnonymous: boolean;
}

interface WizardActions {
  goToStep: (stepIndex: number) => void;
  goNext: () => Promise<void>;
  goPrevious: () => void;
  skipStep: () => Promise<void>;
  updateStepData: (step: StepKey, data: unknown) => void;
  registerValidation: (fn: () => Promise<boolean>) => void;
  setSubmitState: (state: SubmitState) => void;
  registerSubmit: (fn: () => void | Promise<void>) => void;
  submit: () => void;
  triggerSave: () => Promise<void>;
  submitApplication: () => Promise<{
    success: boolean;
    error?: string;
    failingStep?: string;
  }>;
  abandon: () => Promise<void>;
  /** BAL-502 §22.4 — writes the anonymous envelope SYNCHRONOUSLY, stamping
   * `authGateAt` (WARNING 6). Called by the Terms step immediately before opening
   * the auth modal, so an OAuth full-page redirect can never race the debounced
   * background save. Returns whether the write actually landed (WARNING 7) — the
   * caller must surface a `false` result rather than silently proceed as if the
   * visitor's work is safe. */
  saveAnonymousDraftNow: () => boolean;
}

type WizardContextType = WizardState & WizardActions;

const WizardContext = createContext<WizardContextType | null>(null);

// ── Hook ─────────────────────────────────────────────────────────

export function useWizard(): WizardContextType {
  const ctx = useContext(WizardContext);
  if (!ctx) {
    throw new Error('useWizard must be used within ExpertApplicationProvider');
  }
  return ctx;
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Resolve a step's live numeric index by KEY. Every gate below routes through this so
 * inserting/reordering STEP_CONFIG (e.g. the BAL-356 agency step at index 1) never
 * requires touching a hardcoded literal here.
 */
function stepIndex(key: StepKey): number {
  return STEP_CONFIG.findIndex((s) => s.key === key);
}

function findFirstIncompleteStep(draft: ApplicationWithRelations): number {
  // Required steps, in order. Each gate returns the FIRST incomplete step's live index.
  if (!isProfileComplete(draft)) return stepIndex('profile');
  if (!isAgencyComplete(draft)) return stepIndex('agency'); // BAL-356 — agencyId not set yet
  if (!isProductsComplete(draft)) return stepIndex('products');
  if (!isAssessmentComplete(draft)) return stepIndex('assessment');

  // Optional steps (certifications, work-history) — infer progress from later-step
  // data. Work history present ⇒ certifications were passed too ⇒ land on terms.
  if (draft.workHistory.length > 0) return stepIndex('terms');
  if (draft.certifications.length > 0) return stepIndex('work-history');
  return stepIndex('certifications');
}

function resolveInitialStep(
  searchParams: URLSearchParams,
  draft: ApplicationWithRelations | null
): number {
  const maxStep = draft ? findFirstIncompleteStep(draft) : 0;

  const stepParam = searchParams.get('step');
  if (stepParam) {
    const index = STEP_CONFIG.findIndex((s) => s.key === stepParam);
    if (index !== -1) return Math.min(index, maxStep);
  }
  return maxStep;
}

function isProfileComplete(draft: ApplicationWithRelations): boolean {
  return (
    draft.profile.yearStartedSalesforce !== null &&
    draft.languages.length > 0 &&
    draft.industries.length > 0
  );
}

/**
 * BAL-356 — the agency step is complete once the draft is linked to its payout agency
 * (`agencyId` set). `Boolean(...)` treats both null (real row default) and undefined
 * (partial fixtures) as incomplete.
 */
function isAgencyComplete(draft: ApplicationWithRelations): boolean {
  return Boolean(draft.profile.agencyId);
}

function isProductsComplete(draft: ApplicationWithRelations): boolean {
  return draft.competencies.length > 0;
}

function isAssessmentComplete(draft: ApplicationWithRelations): boolean {
  if (draft.competencies.length === 0) return false;
  const productProficiencies = new Map<string, number[]>();
  for (const c of draft.competencies) {
    const arr = productProficiencies.get(c.productId) ?? [];
    arr.push(c.proficiency);
    productProficiencies.set(c.productId, arr);
  }
  for (const [, profs] of productProficiencies) {
    if (!profs.some((p) => p > 0)) return false;
  }
  return true;
}

function hydrateStepStatuses(draft: ApplicationWithRelations | null): StepStatus[] {
  const statuses: StepStatus[] = new Array(STEP_CONFIG.length).fill('pending') as StepStatus[];
  if (!draft) return statuses;

  // Set a step's status by KEY (index-shift safe — BAL-356 agency insertion).
  const set = (key: StepKey, status: StepStatus): void => {
    const i = stepIndex(key);
    if (i !== -1) statuses[i] = status;
  };

  const profileDone = isProfileComplete(draft);
  const agencyDone = isAgencyComplete(draft);
  const productsDone = isProductsComplete(draft);
  const assessmentDone = isAssessmentComplete(draft);

  if (profileDone) set('profile', 'completed');
  if (agencyDone) set('agency', 'completed');
  if (productsDone) set('products', 'completed');
  if (assessmentDone) set('assessment', 'completed');

  // The optional steps (certifications, work-history) resolve to completed-or-skipped
  // only once EVERY required step before them — profile, agency, products, assessment
  // — is complete. Terms stays 'pending' (required, not inferable from data).
  if (profileDone && agencyDone && productsDone && assessmentDone) {
    set('certifications', draft.certifications.length > 0 ? 'completed' : 'skipped');
    set('work-history', draft.workHistory.length > 0 ? 'completed' : 'skipped');
  }

  return statuses;
}

function hydrateAgencyData(draft: ApplicationWithRelations | null): Partial<AgencyStepData> {
  // The agency step is self-advancing and carries no form fields. We keep `agencyId`
  // as the sole snapshot value so any incidental autosave has a stable, serialisable
  // payload; the resolve/write itself reads the session email server-side.
  return { agencyId: draft?.profile.agencyId ?? null } as Partial<AgencyStepData>;
}

function hydrateProfileData(draft: ApplicationWithRelations | null): Partial<ProfileStepData> {
  if (!draft) {
    return {
      isSalesforceMvp: false,
      isSalesforceCta: false,
      isCertifiedTrainer: false,
      languages: [],
      industryIds: [],
    };
  }

  const linkedinUrl = draft.profile.linkedinUrl;
  const linkedinSlug = linkedinUrl ? linkedinUrl.replace('https://linkedin.com/in/', '') : '';

  return {
    yearStartedSalesforce: draft.profile.yearStartedSalesforce ?? undefined,
    projectCountMin: draft.profile.projectCountMin ?? undefined,
    projectLeadCountMin: draft.profile.projectLeadCountMin ?? undefined,
    linkedinSlug,
    isSalesforceMvp: draft.profile.isSalesforceMvp,
    isSalesforceCta: draft.profile.isSalesforceCta,
    isCertifiedTrainer: draft.profile.isCertifiedTrainer,
    languages: draft.languages.map((l) => ({
      languageId: l.languageId,
      proficiency: l.proficiency,
    })),
    industryIds: draft.industries.map((i) => i.industryId),
  };
}

function hydrateProductsData(draft: ApplicationWithRelations | null): Partial<ProductsStepData> {
  if (!draft) return { productIds: [] };
  const uniqueProductIds = [...new Set(draft.competencies.map((c) => c.productId))];
  return { productIds: uniqueProductIds };
}

function hydrateAssessmentData(
  draft: ApplicationWithRelations | null
): Partial<AssessmentStepData> {
  if (!draft) return { ratings: [] };
  return {
    ratings: draft.competencies.map((c) => ({
      productId: c.productId,
      supportTypeId: c.supportTypeId,
      proficiency: c.proficiency,
    })),
  };
}

function hydrateCertificationsData(
  draft: ApplicationWithRelations | null
): Partial<CertificationsStepData> {
  if (!draft) return { certifications: [], trailheadSlug: '' };
  const trailheadUrl = draft.profile.trailheadUrl;
  const trailheadSlug = trailheadUrl ? trailheadUrl.replace('https://trailblazer.me/id/', '') : '';
  return {
    trailheadSlug,
    certifications: draft.certifications.map((c) => ({
      certificationId: c.certificationId,
      earnedAt: c.earnedAt ?? '',
      expiresAt: c.expiresAt ?? '',
      credentialUrl: c.credentialUrl ?? '',
    })),
  };
}

function hydrateWorkHistoryData(
  draft: ApplicationWithRelations | null
): Partial<WorkHistoryStepData> {
  if (!draft) return { entries: [] };
  return {
    entries: draft.workHistory.map((w) => ({
      id: w.id,
      role: w.role,
      company: w.company,
      startedAt: w.startedAt.toISOString().slice(0, 10),
      endedAt: w.endedAt ? w.endedAt.toISOString().slice(0, 10) : '',
      isCurrent: w.isCurrent,
      responsibilities: w.responsibilities ?? '',
    })),
  };
}

// ── Provider ─────────────────────────────────────────────────────

interface ExpertApplicationProviderProps {
  children: ReactNode;
  draft: ApplicationWithRelations | null;
  referenceData: ReferenceData;
  /** `null` for an anonymous visitor (BAL-502 §22). See `WizardState.user` above for
   * why this is `{ id }`, not `{ id, email }`. */
  user: { id: string } | null;
}

// Toast copy for the post-auth flush (§22.9, §22.11) — warm, non-blaming,
// gender-neutral, per CLAUDE.md's copy rules.
//
// "Two quick things and you're done" is accurate BECAUSE `reloadWithToast` below
// forces a real document reload: a fresh mount re-hydrates every step's status from
// the just-written server draft, so `agency` (never written by the anonymous flush
// — §22.5) is the only step landing back as incomplete, and `terms` (never
// auto-completed) is the other. Everything else the flush posted — products,
// assessment, certifications, work-history — comes back `completed`/`skipped`. A
// SOFT `router.refresh()` cannot do this (CRITICAL 1 / HIGH 2): the provider's
// state comes from `useState(() => hydrate*(draft))` lazy initializers that only
// run once at mount, so a soft refresh would leave every step stuck as it was
// mid-session and this copy would be a lie.
const FLUSH_SUCCESS_TOAST = "Your progress is saved. Two quick things and you're done.";
// FIX round (copy) — names the DISCARD explicitly. The bare "we've loaded the
// application" line read as if nothing happened to what was just typed; a visitor
// who filled in real details anonymously deserves to be told, plainly, that those
// specific entries were not carried onto their account (server wins, §22.11) —
// never silent data loss.
const FLUSH_SUPERSEDED_TOAST =
  "Welcome back — we've loaded the application you already had in progress. " +
  "What you just entered here wasn't added to your account, so nothing gets overwritten.";
const FLUSH_FAILED_TOAST = "We couldn't restore your saved progress. Please try again.";

/**
 * BAL-502 FIX round (WARNING 6) — an anonymous envelope carries no identity of its
 * own; any session that shows up in this tab can claim it. `authGateAt` (stamped
 * once, only at the submit gate) bounds how long a draft stays claimable: a window
 * this generous covers the slowest realistic path (fill the wizard, hit Submit,
 * complete a WorkOS OAuth round-trip including a provider login) with margin, while
 * still meaningfully narrowing the shared/kiosk-browser hazard where a draft could
 * otherwise sit claimable indefinitely. A stricter per-visitor confirmation
 * ("We found an application in progress — is this yours?") was considered and
 * deferred: it adds a full UI surface + copy for a hazard that requires the SAME
 * tab to still be open AND a second person signing in within the window — narrow
 * enough that the time bound alone is a reasonable first line of defense.
 */
const AUTH_GATE_FLUSH_WINDOW_MS = 30 * 60 * 1000;

export function ExpertApplicationProvider({
  children,
  draft,
  referenceData,
  user,
}: Readonly<ExpertApplicationProviderProps>): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isAnonymous = user === null;

  const initialStep = useMemo(
    () => resolveInitialStep(searchParams, draft),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const [expertProfileId, setExpertProfileId] = useState<string | null>(draft?.profile.id ?? null);
  const [currentStep, setCurrentStep] = useState(initialStep);
  // Furthest step the user has reached. On resume this is `initialStep`, so every
  // step up to it is immediately navigable (reachable-step navigation, defect 3).
  const [maxReachedStep, setMaxReachedStep] = useState(initialStep);
  const [stepStatuses, setStepStatuses] = useState<StepStatus[]>(() => hydrateStepStatuses(draft));
  const [direction, setDirection] = useState<Direction>('forward');
  const [autoSaveState, setAutoSaveState] = useState<AutoSaveState>('idle');
  // Reactive submit UI state. Lives here (the common ancestor) so the relocated
  // Submit button in WizardActionBar can render idle → submitting → success while
  // the Terms step still owns the submit handler that drives these transitions.
  const [submitState, setSubmitState] = useState<SubmitState>('idle');

  // Per-step form data
  const [agencyData, setAgencyData] = useState<Partial<AgencyStepData>>(() =>
    hydrateAgencyData(draft)
  );
  const [profileData, setProfileData] = useState<Partial<ProfileStepData>>(() =>
    hydrateProfileData(draft)
  );
  const [productsData, setProductsData] = useState<Partial<ProductsStepData>>(() =>
    hydrateProductsData(draft)
  );
  const [assessmentData, setAssessmentData] = useState<Partial<AssessmentStepData>>(() =>
    hydrateAssessmentData(draft)
  );
  const [certificationsData, setCertificationsData] = useState<Partial<CertificationsStepData>>(
    () => hydrateCertificationsData(draft)
  );
  const [workHistoryData, setWorkHistoryData] = useState<Partial<WorkHistoryStepData>>(() =>
    hydrateWorkHistoryData(draft)
  );
  const [termsData, setTermsData] = useState<Partial<TermsStepData>>({
    termsAccepted: false,
  });

  // Validation ref
  const validationRef = useRef<(() => Promise<boolean>) | null>(null);

  // Submit handler ref — the Terms step registers its handler here (mirrors
  // validationRef). The bar invokes it via submit(); state lives in submitState.
  const submitRef = useRef<(() => void | Promise<void>) | null>(null);

  // Idle auto-save
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-step saved snapshots (BAL-342). A single shared baseline held only the
  // last-saved step's data, so every hop after the first looked dirty and re-saved.
  const lastSavedByStepRef = useRef<Partial<Record<StepKey, string>>>({});
  // Beacon flushes are ATTEMPTS, not saves: `sendBeacon` returning true means the UA
  // queued the bytes, never that the server stored them (the request can be dropped, or
  // answered 401/500 — none of which the page ever observes). Tracked separately from
  // `lastSavedByStepRef` so a repeat background doesn't re-send an identical payload,
  // while a tab that proves it is still alive goes straight back to being re-savable.
  // Only a confirmed `saveDraftAction` success may ever write `lastSavedByStepRef`.
  const beaconAttemptByStepRef = useRef<Partial<Record<StepKey, string>>>({});

  // Fire analytics on mount. `APPLICATION_STARTED` is SUPPRESSED for an anonymous
  // visitor — firing it would silently change the historical meaning of
  // `expert_application_started` ("a signed-in user began an application") and
  // break every funnel built on it (BAL-502 §22.10). The two are mutually exclusive
  // by construction: exactly one of them fires per mount.
  const hasTrackedRef = useRef(false);
  useEffect(() => {
    if (hasTrackedRef.current) return;
    hasTrackedRef.current = true;
    if (isAnonymous) {
      track(EXPERT_EVENTS.APPLICATION_ANONYMOUS_STARTED, {});
    } else if (draft) {
      track(EXPERT_EVENTS.APPLICATION_RESUMED, {
        resumed_at_step: STEP_CONFIG[initialStep]?.key ?? 'profile',
      });
    } else {
      track(EXPERT_EVENTS.APPLICATION_STARTED, {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clear stale idle-save timer on step change to prevent old closures
  // from re-saving a previous step's data (which can wipe assessment ratings)
  useEffect(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, [currentStep]);

  // Track the furthest step reached so the user can freely jump back and forth.
  // Covers goNext, skipStep, and forward goToStep jumps in one place.
  useEffect(() => {
    setMaxReachedStep((prev) => Math.max(prev, currentStep));
  }, [currentStep]);

  // Update URL on step change
  useEffect(() => {
    const stepKey = STEP_CONFIG[currentStep]?.key ?? 'profile';
    router.replace(`/expert/apply?step=${stepKey}`, { scroll: false });
  }, [currentStep, router]);

  const getCurrentStepKey = useCallback((): StepKey => {
    return STEP_CONFIG[currentStep]?.key ?? 'profile';
  }, [currentStep]);

  const getStepData = useCallback(
    (step: StepKey): unknown => {
      const dataMap: Record<StepKey, unknown> = {
        agency: agencyData,
        profile: profileData,
        products: productsData,
        assessment: assessmentData,
        certifications: certificationsData,
        'work-history': workHistoryData,
        terms: termsData,
      };
      return dataMap[step];
    },
    [
      agencyData,
      profileData,
      productsData,
      assessmentData,
      certificationsData,
      workHistoryData,
      termsData,
    ]
  );

  // Latest step key + data + id for the once-attached unload flush listener, so it
  // never reads a stale closure. Kept fresh by a dep-less effect below.
  const flushStateRef = useRef<{
    stepKey: StepKey;
    data: unknown;
    expertProfileId: string | null;
    isAnonymous: boolean;
  }>({
    stepKey: getCurrentStepKey(),
    data: getStepData(getCurrentStepKey()),
    expertProfileId,
    isAnonymous,
  });

  // Seed EVERY step's baseline so a pristine load isn't seen as dirty. At mount all step
  // data is hydrated straight from the persisted draft, so nothing needs re-saving until
  // the user actually edits it — seeding only the initial step left every other step's
  // first departure firing a save of data already in the DB (BAL-342). Eager on purpose:
  // a lazy "seed on entry if unset" would stamp EDITED data as the baseline after a
  // failed save, silently discarding the pending write.
  useEffect(() => {
    for (const step of STEP_CONFIG) {
      lastSavedByStepRef.current[step.key] = JSON.stringify(getStepData(step.key));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // BAL-502 §22.3 — the full-envelope snapshot written to sessionStorage. Every key
  // is populated unconditionally from live state (cheap, local, idempotent) so a
  // single call always captures the whole wizard, not just the step being left.
  const buildAnonymousEnvelope = useCallback((): AnonymousApplicationDraftV1 => {
    const steps: Partial<Record<StepKey, unknown>> = {};
    for (const step of STEP_CONFIG) {
      steps[step.key] = getStepData(step.key);
    }
    return {
      v: 1,
      savedAt: new Date().toISOString(),
      currentStep,
      maxReachedStep,
      steps,
    };
  }, [getStepData, currentStep, maxReachedStep]);

  const saveAnonymousDraftNow = useCallback((): boolean => {
    // WARNING 6 — `authGateAt` is stamped ONLY here (the submit-gate call site),
    // never by the 800ms background debounce (`scheduleAnonymousSave` below) —
    // that timestamp means "the visitor deliberately hit Submit", not "some field
    // changed". WARNING 7 — the write's success is returned (not discarded) so the
    // caller (step-terms) can tell the visitor before they commit to signing up.
    return writeAnonymousDraft({
      ...buildAnonymousEnvelope(),
      authGateAt: new Date().toISOString(),
    });
  }, [buildAnonymousEnvelope]);

  const performSave = useCallback(async (): Promise<boolean> => {
    const stepKey = getCurrentStepKey();
    const data = getStepData(stepKey);

    if (isAnonymous) {
      // No anonymous writes, anywhere — `saveDraftAction` is `withAuth`-wrapped and
      // would just 401. sessionStorage is the persistence layer for this path; a
      // synchronous write here keeps goNext/skipStep/goPrevious safe to call
      // unconditionally without branching at every call site.
      writeAnonymousDraft(buildAnonymousEnvelope());
      lastSavedByStepRef.current[stepKey] = JSON.stringify(data);
      return true;
    }

    setAutoSaveState('saving');
    try {
      const result = await saveDraftAction({
        step: stepKey,
        data,
        expertProfileId: expertProfileId ?? undefined,
      });

      if (result.success) {
        if (!expertProfileId && result.expertProfileId) {
          setExpertProfileId(result.expertProfileId);
        }
        setAutoSaveState('saved');
        lastSavedByStepRef.current[stepKey] = JSON.stringify(data);
        // Reset saved indicator after 2s
        setTimeout(() => setAutoSaveState('idle'), 2000);
        return true;
      } else {
        setAutoSaveState('error');
        toast.error(result.error ?? 'Failed to save. Please try again.');
        return false;
      }
    } catch {
      setAutoSaveState('error');
      toast.error("Couldn't save your progress. Retrying...");
      return false;
    }
  }, [getCurrentStepKey, getStepData, expertProfileId, isAnonymous, buildAnonymousEnvelope]);

  const scheduleIdleSave = useCallback((): void => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(async () => {
      const stepKey = getCurrentStepKey();
      const currentData = JSON.stringify(getStepData(stepKey));
      if (currentData !== lastSavedByStepRef.current[stepKey]) {
        await performSave();
      }
    }, 30_000);
  }, [getCurrentStepKey, getStepData, performSave]);

  // BAL-502 §22.3 — the anonymous mirror of `scheduleIdleSave`, debounced to
  // sessionStorage instead of the server. A short debounce is fine (unlike the
  // 30s server debounce) because a local write has no network cost.
  const anonSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleAnonymousSave = useCallback((): void => {
    if (anonSaveTimerRef.current) clearTimeout(anonSaveTimerRef.current);
    anonSaveTimerRef.current = setTimeout(() => {
      writeAnonymousDraft(buildAnonymousEnvelope());
    }, 800);
  }, [buildAnonymousEnvelope]);

  // Save-on-exit: reads the CURRENT step's key + data synchronously, so when called
  // before `setCurrentStep(...)` it captures the step being LEFT (no stale closure).
  // Skips the network call when nothing changed since the last successful save.
  // Synchronous (returns void) and owns its own promise, so callers navigate
  // immediately without a `void` operator or a floating promise.
  const saveIfDirty = useCallback((): void => {
    const stepKey = getCurrentStepKey();
    const currentData = JSON.stringify(getStepData(stepKey));
    if (currentData === lastSavedByStepRef.current[stepKey]) return; // no unsaved changes
    performSave().catch(() => {
      // performSave resolves false and shows its own error toast; guard only so
      // the promise is handled.
    });
  }, [getCurrentStepKey, getStepData, performSave]);

  // Keep the flush ref current after every render (cheap object assign, always fresh).
  useEffect(() => {
    flushStateRef.current = {
      stepKey: getCurrentStepKey(),
      data: getStepData(getCurrentStepKey()),
      expertProfileId,
      isAnonymous,
    };
  });

  // Best-effort flush on tab close / hard navigation / backgrounding. Attached once;
  // reads `flushStateRef` so it never sees stale state.
  useEffect(() => {
    const flush = (): void => {
      const {
        stepKey,
        data,
        expertProfileId: profileId,
        isAnonymous: anonymous,
      } = flushStateRef.current;
      // No anonymous writes, anywhere — this path POSTs to an auth-gated route.
      // sessionStorage (via `performSave`/`scheduleAnonymousSave`) is the anonymous
      // persistence layer; there is nothing for this unload beacon to do.
      if (anonymous) return;
      // Only flush when there are unsaved changes relative to THAT step's last save...
      const serialized = JSON.stringify(data);
      if (serialized === lastSavedByStepRef.current[stepKey]) return;
      // ...and don't re-send bytes already queued for this step while still hidden.
      if (serialized === beaconAttemptByStepRef.current[stepKey]) return;

      const payload: Record<string, unknown> = { step: stepKey, data };
      if (profileId) payload.expertProfileId = profileId; // omit when null
      const body = JSON.stringify(payload);

      if (typeof globalThis.navigator?.sendBeacon === 'function') {
        const queued = globalThis.navigator.sendBeacon(
          '/api/expert/apply/flush-draft',
          new Blob([body], { type: 'application/json' })
        );
        // Record the ATTEMPT (not a save) so re-backgrounding a still-hidden tab doesn't
        // re-flush identical bytes. Cleared the moment the tab is shown again, because a
        // queued beacon that was never confirmed must stay re-savable.
        if (queued) beaconAttemptByStepRef.current[stepKey] = serialized;
      } else {
        // Fallback when sendBeacon is unavailable: a keepalive fetch reusing the
        // SAME fresh body built above from flushStateRef, so it stays stale-safe
        // (the effect's first-render `performSave` closure would save stale data).
        // Deliberately pessimistic — it records no attempt and advances no baseline.
        // `res.ok` would NOT justify one either: the route answers 200 with
        // `{ success: false }` on an ownership/validation failure, so even a resolved
        // response is not proof of a write. A repeat flush here is an idempotent
        // over-save, which is the safe direction; on a real unload the promise may
        // never settle at all.
        globalThis
          .fetch('/api/expert/apply/flush-draft', {
            method: 'POST',
            body,
            keepalive: true,
            headers: { 'content-type': 'application/json' },
          })
          .catch(() => {
            // Best-effort unload flush; nothing to do if it fails.
          });
      }
    };

    // The tab is back, so it never unloaded and no queued beacon can be trusted to have
    // landed. Drop the attempt record; the step's real baseline was never touched, so a
    // later navigation or idle tick re-saves it.
    const clearBeaconAttempts = (): void => {
      beaconAttemptByStepRef.current = {};
    };

    const onVisibilityChange = (): void => {
      if (globalThis.document.visibilityState === 'hidden') flush();
      else clearBeaconAttempts();
    };

    globalThis.addEventListener('pagehide', flush);
    globalThis.addEventListener('pageshow', clearBeaconAttempts); // bfcache restore
    globalThis.document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      globalThis.removeEventListener('pagehide', flush);
      globalThis.removeEventListener('pageshow', clearBeaconAttempts);
      globalThis.document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  // ── Actions ──────────────────────────────────────────────────

  const registerValidation = useCallback((fn: () => Promise<boolean>): void => {
    validationRef.current = fn;
  }, []);

  const registerSubmit = useCallback((fn: () => void | Promise<void>): void => {
    submitRef.current = fn;
  }, []);

  const submit = useCallback((): void => {
    const result = submitRef.current?.();
    if (result instanceof Promise) {
      result.catch(() => undefined);
    }
  }, []);

  const updateStepData = useCallback(
    (step: StepKey, data: unknown): void => {
      const setters: Record<StepKey, (d: unknown) => void> = {
        agency: (d) => setAgencyData(d as Partial<AgencyStepData>),
        profile: (d) => setProfileData(d as Partial<ProfileStepData>),
        products: (d) => setProductsData(d as Partial<ProductsStepData>),
        assessment: (d) => setAssessmentData(d as Partial<AssessmentStepData>),
        certifications: (d) => setCertificationsData(d as Partial<CertificationsStepData>),
        'work-history': (d) => setWorkHistoryData(d as Partial<WorkHistoryStepData>),
        terms: (d) => setTermsData(d as Partial<TermsStepData>),
      };
      setters[step](data);
      if (isAnonymous) {
        scheduleAnonymousSave();
      } else {
        scheduleIdleSave();
      }
    },
    [scheduleIdleSave, scheduleAnonymousSave, isAnonymous]
  );

  const goToStep = useCallback(
    (stepIndex: number): void => {
      if (stepIndex < 0 || stepIndex >= STEP_CONFIG.length) return;
      if (stepIndex === currentStep) return;
      // Reachable-step navigation: any step the user has already visited.
      if (stepIndex > maxReachedStep) return;
      saveIfDirty(); // persist the step being LEFT before we switch
      setDirection(stepIndex > currentStep ? 'forward' : 'backward');
      setCurrentStep(stepIndex);
    },
    [currentStep, maxReachedStep, saveIfDirty]
  );

  const goNext = useCallback(async (): Promise<void> => {
    const stepConfig = STEP_CONFIG[currentStep];
    const selfAdvancing =
      stepConfig !== undefined &&
      'selfAdvancing' in stepConfig &&
      stepConfig.selfAdvancing === true;

    // Self-advancing steps (e.g. the agency step, BAL-356) own their forward path: the
    // in-card action performs the write and gating, so the wizard core must NOT run the
    // shared (possibly stale) validationRef or a no-op save for them — doing so can strand
    // the step (busy stuck, no advance).
    if (!selfAdvancing) {
      // 1. Trigger step validation
      if (validationRef.current) {
        const isValid = await validationRef.current();
        if (!isValid) return;
      }

      // 2. Save draft
      const saved = await performSave();
      if (!saved) return;
    }

    // 3. Mark current step as completed
    setStepStatuses((prev) => {
      const next = [...prev];
      next[currentStep] = 'completed';
      return next;
    });

    // 4. Track analytics
    track(EXPERT_EVENTS.APPLICATION_STEP_COMPLETED, {
      step: stepConfig?.key ?? 'profile',
      step_number: currentStep + 1,
    });

    // 5. Advance step
    if (currentStep < STEP_CONFIG.length - 1) {
      setDirection('forward');
      setCurrentStep((prev) => prev + 1);
    }
  }, [currentStep, performSave]);

  const goPrevious = useCallback((): void => {
    if (currentStep > 0) {
      saveIfDirty(); // persist the step being LEFT before we step back
      setDirection('backward');
      setCurrentStep((prev) => prev - 1);
    }
  }, [currentStep, saveIfDirty]);

  const skipStep = useCallback(async (): Promise<void> => {
    // Save whatever is there (optional steps)
    await performSave();

    // Mark as skipped
    setStepStatuses((prev) => {
      const next = [...prev];
      next[currentStep] = 'skipped';
      return next;
    });

    // Track analytics
    const skipStepConfig = STEP_CONFIG[currentStep];
    track(EXPERT_EVENTS.APPLICATION_STEP_SKIPPED, {
      step: skipStepConfig?.key ?? 'profile',
      step_number: currentStep + 1,
    });

    // Advance
    if (currentStep < STEP_CONFIG.length - 1) {
      setDirection('forward');
      setCurrentStep((prev) => prev + 1);
    }
  }, [currentStep, performSave]);

  const triggerSave = useCallback(async (): Promise<void> => {
    await performSave();
  }, [performSave]);

  const submitApplicationFn = useCallback(async (): Promise<{
    success: boolean;
    error?: string;
    failingStep?: string;
  }> => {
    if (!expertProfileId) {
      return { success: false, error: 'No application to submit' };
    }
    return submitApplicationAction(expertProfileId);
  }, [expertProfileId]);

  const abandon = useCallback(async (): Promise<void> => {
    // WARNING 5 — defense in depth. `WizardActionBar` hides `SaveExitButton` for an
    // anonymous visitor (there's nothing distinct for it to do — anonymous progress
    // already persists continuously via `scheduleAnonymousSave`), but if this were
    // ever invoked anonymously anyway, `router.push('/dashboard')` below would
    // dead-end at `/login` (middleware) — directly contradicting "come back
    // anytime". No-op instead of lying.
    if (isAnonymous) return;

    // Save current state before leaving; bail if it fails so the user keeps
    // their data and doesn't get a false "saved" confirmation.
    const saved = await performSave();
    if (!saved) {
      // performSave already set error state + showed its own error toast; add a
      // clear "stay on the page" message so the button re-enables (see FIX 2).
      toast.error("Couldn't save your progress — please try again before leaving.");
      return;
    }

    // Track analytics
    const abandonStepConfig = STEP_CONFIG[currentStep];
    track(EXPERT_EVENTS.APPLICATION_ABANDONED, {
      last_step: abandonStepConfig?.key ?? 'profile',
      step_number: currentStep + 1,
    });

    toast.success('Your progress has been saved. Come back anytime!');
    router.push('/dashboard');
  }, [currentStep, performSave, router, isAnonymous]);

  // Cleanup idle timer on unmount
  useEffect(() => {
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (anonSaveTimerRef.current) clearTimeout(anonSaveTimerRef.current);
    };
  }, []);

  // BAL-502 §22.9/§22.11 — the post-auth flush. Triggers on the wizard mounting (or
  // re-rendering after a same-tab auth transition) WITH a session AND a pending
  // anonymous envelope — deliberately NOT the auth modal's `onSuccess`, because the
  // WorkOS OAuth path is a full-page redirect that may land anywhere, so an
  // `onSuccess`-triggered flush would never fire for OAuth signups. Depending on
  // `user` (rather than `[]`) covers both: a fresh mount that already has a session
  // (OAuth round-trip back to this page) and a props update from null → non-null on
  // the SAME mount (the email-modal path, via `router.refresh()`).
  const hasAttemptedFlushRef = useRef(false);
  useEffect(() => {
    if (!user) return;
    if (hasAttemptedFlushRef.current) return;
    hasAttemptedFlushRef.current = true;

    const envelope = readAnonymousDraft();
    if (!envelope) return; // No pending envelope — nothing to flush, no toast.

    // WARNING 6 — refuse to attribute a STALE envelope to whoever happens to be
    // signing in right now (shared/kiosk browser: a draft that has sat untouched
    // for hours belongs to whoever left the tab open, not necessarily to the
    // person currently authenticating in it). `authGateAt` is stamped only at the
    // deliberate submit-gate moment (`saveAnonymousDraftNow`); its absence or age
    // beyond the window means this session never proved the draft is its own.
    // A NEGATIVE age (future-dated `authGateAt`) is rejected too, not just an
    // over-window one: clock skew aside, a future stamp would otherwise keep an
    // envelope "fresh" indefinitely and re-open the exact window this guard
    // bounds. Only a stamp in the past can have been made by a real submit gate.
    const gateAgeMs = envelope.authGateAt
      ? Date.now() - Date.parse(envelope.authGateAt)
      : Number.NaN;
    if (!Number.isFinite(gateAgeMs) || gateAgeMs < 0 || gateAgeMs > AUTH_GATE_FLUSH_WINDOW_MS) {
      clearAnonymousDraft(); // Untrustworthy — don't leave it around to be re-tried.
      return; // No toast — this identity never proved the draft belongs to it.
    }

    let cancelled = false;

    flushAnonymousDraft({ draft: envelope, hasServerDraft: draft !== null })
      .then((result) => {
        if (cancelled) return;

        track(EXPERT_EVENTS.APPLICATION_DRAFT_FLUSHED, {
          outcome: result.outcome,
          steps_flushed: result.stepsFlushed,
        });

        if (result.outcome === 'flushed') {
          clearAnonymousDraft();
          // CRITICAL 1 / HIGH 2 — `router.refresh()` cannot rehydrate this
          // provider (see the comment on `FLUSH_SUCCESS_TOAST` above): its state
          // comes from `useState(() => hydrate*(draft))` lazy initializers that
          // only run once, and nothing puts a `key` on the provider to force a
          // remount. A soft refresh would leave the wizard showing whatever the
          // anonymous session had in memory while `expertProfileId` stays stuck
          // at null (`submitApplication` then permanently returns "No
          // application to submit"). A REAL reload is the only fix — it forces a
          // fresh mount that re-derives every field, including step-completion
          // status, from the server draft the flush just wrote.
          reloadWithToast(FLUSH_SUCCESS_TOAST);
        } else if (result.outcome === 'superseded') {
          // Server wins (§22.11) — an existing server-side draft for this account
          // always supersedes the anonymous envelope. Discard, don't merge: the
          // two sides aren't comparable, and merging would destroy real data.
          // Same reload requirement as 'flushed' — otherwise the visitor keeps
          // looking at their now-discarded anonymous entries while the "server
          // wins" toast claims otherwise, AND `expertProfileId` never picks up
          // the pre-existing server draft's real id (CRITICAL 1).
          clearAnonymousDraft();
          reloadWithToast(FLUSH_SUPERSEDED_TOAST);
        } else if (result.outcome === 'failed') {
          // Keep the envelope — every per-step write is idempotent, so a retry
          // (e.g. a later visit in the same tab) is possible. No identity change
          // happened, so no reload is needed here.
          toast.error(FLUSH_FAILED_TOAST);
        }
        // 'nothing_to_flush' — the envelope carried no profile step data; nothing to
        // do, no toast.
      })
      .catch(() => {
        if (!cancelled) toast.error(FLUSH_FAILED_TOAST);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // BAL-502 FIX round (CRITICAL 1 / HIGH 2) — replays the toast stashed by
  // `reloadWithToast` immediately before it forced the document reload above. Runs
  // unconditionally on mount (both anonymous and authenticated) since by the time
  // this fresh mount exists, the reload has already happened.
  useEffect(() => {
    const pending = consumePendingToast();
    if (pending) toast.success(pending);
  }, []);

  const value = useMemo<WizardContextType>(
    () => ({
      expertProfileId,
      currentStep,
      maxReachedStep,
      stepStatuses,
      direction,
      autoSaveState,
      submitState,
      agencyData,
      profileData,
      productsData,
      assessmentData,
      certificationsData,
      workHistoryData,
      termsData,
      referenceData,
      user,
      isAnonymous,
      goToStep,
      goNext,
      goPrevious,
      skipStep,
      updateStepData,
      registerValidation,
      setSubmitState,
      registerSubmit,
      submit,
      triggerSave,
      submitApplication: submitApplicationFn,
      abandon,
      saveAnonymousDraftNow,
    }),
    [
      expertProfileId,
      currentStep,
      maxReachedStep,
      stepStatuses,
      direction,
      autoSaveState,
      submitState,
      agencyData,
      profileData,
      productsData,
      assessmentData,
      certificationsData,
      workHistoryData,
      termsData,
      referenceData,
      user,
      isAnonymous,
      goToStep,
      goNext,
      goPrevious,
      skipStep,
      updateStepData,
      registerValidation,
      setSubmitState,
      registerSubmit,
      submit,
      triggerSave,
      submitApplicationFn,
      abandon,
      saveAnonymousDraftNow,
    ]
  );

  return <WizardContext.Provider value={value}>{children}</WizardContext.Provider>;
}
