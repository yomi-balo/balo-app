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
  type ProfileStepData,
  type ProductsStepData,
  type AssessmentStepData,
  type CertificationsStepData,
  type WorkHistoryStepData,
  type TermsStepData,
} from '../_actions/schemas';
import type { ReferenceData } from '../_actions/load-draft';
import type { ApplicationWithRelations } from '@balo/db';

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
  profileData: Partial<ProfileStepData>;
  productsData: Partial<ProductsStepData>;
  assessmentData: Partial<AssessmentStepData>;
  certificationsData: Partial<CertificationsStepData>;
  workHistoryData: Partial<WorkHistoryStepData>;
  termsData: Partial<TermsStepData>;
  referenceData: ReferenceData;
  user: { id: string; email: string };
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

function findFirstIncompleteStep(draft: ApplicationWithRelations): number {
  // Step 1: Check profile fields populated + languages + industries
  const hasProfile = draft.profile.yearStartedSalesforce !== null;
  const hasLanguages = draft.languages.length > 0;
  const hasIndustries = draft.industries.length > 0;
  if (!hasProfile || !hasLanguages || !hasIndustries) return 0;

  // Step 2: Check competencies exist
  if (draft.competencies.length === 0) return 1;

  // Step 3: Check all competencies have at least 1 non-zero rating
  const productProficiencies = new Map<string, number[]>();
  for (const c of draft.competencies) {
    const arr = productProficiencies.get(c.productId) ?? [];
    arr.push(c.proficiency);
    productProficiencies.set(c.productId, arr);
  }
  for (const [, profs] of productProficiencies) {
    if (!profs.some((p) => p > 0)) return 2;
  }

  // Steps 4-5 are optional — infer progress from later-step data.
  // If work history exists, user must have passed certifications too.
  const hasCertData = draft.certifications.length > 0;
  const hasWorkHistoryData = draft.workHistory.length > 0;

  const termsIndex = STEP_CONFIG.length - 1; // terms is always the last step
  if (hasWorkHistoryData) return termsIndex; // past both optional steps → terms
  if (hasCertData) return 4; // past certs → work-history
  return 3; // → certifications
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
  if (!draft) return new Array(STEP_CONFIG.length).fill('pending') as StepStatus[];

  const statuses: StepStatus[] = new Array(STEP_CONFIG.length).fill('pending') as StepStatus[];

  if (isProfileComplete(draft)) statuses[0] = 'completed';
  if (isProductsComplete(draft)) statuses[1] = 'completed';
  if (isAssessmentComplete(draft)) statuses[2] = 'completed';

  // Steps 4-5 are optional - mark as skipped if first 3 are done and they have no data.
  // Terms (now index 5) is required, so it correctly stays 'pending'.
  if (statuses[0] === 'completed' && statuses[1] === 'completed' && statuses[2] === 'completed') {
    statuses[3] = draft.certifications.length > 0 ? 'completed' : 'skipped';
    statuses[4] = draft.workHistory.length > 0 ? 'completed' : 'skipped';
  }

  return statuses;
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
  user: { id: string; email: string };
}

export function ExpertApplicationProvider({
  children,
  draft,
  referenceData,
  user,
}: Readonly<ExpertApplicationProviderProps>): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();

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
  const lastSavedDataRef = useRef<string>('');

  // Fire analytics on mount
  const hasTrackedRef = useRef(false);
  useEffect(() => {
    if (hasTrackedRef.current) return;
    hasTrackedRef.current = true;
    if (draft) {
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
        profile: profileData,
        products: productsData,
        assessment: assessmentData,
        certifications: certificationsData,
        'work-history': workHistoryData,
        terms: termsData,
      };
      return dataMap[step];
    },
    [profileData, productsData, assessmentData, certificationsData, workHistoryData, termsData]
  );

  // Latest step key + data + id for the once-attached unload flush listener, so it
  // never reads a stale closure. Kept fresh by a dep-less effect below.
  const flushStateRef = useRef<{
    stepKey: StepKey;
    data: unknown;
    expertProfileId: string | null;
  }>({
    stepKey: getCurrentStepKey(),
    data: getStepData(getCurrentStepKey()),
    expertProfileId,
  });

  // Seed the saved-snapshot baseline so a pristine first load isn't seen as dirty.
  useEffect(() => {
    lastSavedDataRef.current = JSON.stringify(getStepData(getCurrentStepKey()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const performSave = useCallback(async (): Promise<boolean> => {
    const stepKey = getCurrentStepKey();
    const data = getStepData(stepKey);

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
        lastSavedDataRef.current = JSON.stringify(data);
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
  }, [getCurrentStepKey, getStepData, expertProfileId]);

  const scheduleIdleSave = useCallback((): void => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(async () => {
      const currentData = JSON.stringify(getStepData(getCurrentStepKey()));
      if (currentData !== lastSavedDataRef.current) {
        await performSave();
      }
    }, 30_000);
  }, [getCurrentStepKey, getStepData, performSave]);

  // Save-on-exit: reads the CURRENT step's key + data synchronously, so when called
  // before `setCurrentStep(...)` it captures the step being LEFT (no stale closure).
  // Skips the network call when nothing changed since the last successful save.
  // Synchronous (returns void) and owns its own promise, so callers navigate
  // immediately without a `void` operator or a floating promise.
  const saveIfDirty = useCallback((): void => {
    const currentData = JSON.stringify(getStepData(getCurrentStepKey()));
    if (currentData === lastSavedDataRef.current) return; // no unsaved changes
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
    };
  });

  // Best-effort flush on tab close / hard navigation / backgrounding. Attached once;
  // reads `flushStateRef` so it never sees stale state.
  useEffect(() => {
    const flush = (): void => {
      const { stepKey, data, expertProfileId: profileId } = flushStateRef.current;
      // Only flush when there are unsaved changes relative to the last successful save.
      if (JSON.stringify(data) === lastSavedDataRef.current) return;

      const payload: Record<string, unknown> = { step: stepKey, data };
      if (profileId) payload.expertProfileId = profileId; // omit when null
      const body = JSON.stringify(payload);

      if (typeof globalThis.navigator?.sendBeacon === 'function') {
        globalThis.navigator.sendBeacon(
          '/api/expert/apply/flush-draft',
          new Blob([body], { type: 'application/json' })
        );
      } else {
        // Fallback when sendBeacon is unavailable: a keepalive fetch reusing the
        // SAME fresh body built above from flushStateRef, so it stays stale-safe
        // (the effect's first-render `performSave` closure would save stale data).
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

    const onVisibilityChange = (): void => {
      if (globalThis.document.visibilityState === 'hidden') flush();
    };

    globalThis.addEventListener('pagehide', flush);
    globalThis.document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      globalThis.removeEventListener('pagehide', flush);
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
    void submitRef.current?.();
  }, []);

  const updateStepData = useCallback(
    (step: StepKey, data: unknown): void => {
      const setters: Record<StepKey, (d: unknown) => void> = {
        profile: (d) => setProfileData(d as Partial<ProfileStepData>),
        products: (d) => setProductsData(d as Partial<ProductsStepData>),
        assessment: (d) => setAssessmentData(d as Partial<AssessmentStepData>),
        certifications: (d) => setCertificationsData(d as Partial<CertificationsStepData>),
        'work-history': (d) => setWorkHistoryData(d as Partial<WorkHistoryStepData>),
        terms: (d) => setTermsData(d as Partial<TermsStepData>),
      };
      setters[step](data);
      scheduleIdleSave();
    },
    [scheduleIdleSave]
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
    // 1. Trigger step validation
    if (validationRef.current) {
      const isValid = await validationRef.current();
      if (!isValid) return;
    }

    // 2. Save draft
    const saved = await performSave();
    if (!saved) return;

    // 3. Mark current step as completed
    setStepStatuses((prev) => {
      const next = [...prev];
      next[currentStep] = 'completed';
      return next;
    });

    // 4. Track analytics
    const stepConfig = STEP_CONFIG[currentStep];
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
  }, [currentStep, performSave, router]);

  // Cleanup idle timer on unmount
  useEffect(() => {
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
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
      profileData,
      productsData,
      assessmentData,
      certificationsData,
      workHistoryData,
      termsData,
      referenceData,
      user,
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
    }),
    [
      expertProfileId,
      currentStep,
      maxReachedStep,
      stepStatuses,
      direction,
      autoSaveState,
      submitState,
      profileData,
      productsData,
      assessmentData,
      certificationsData,
      workHistoryData,
      termsData,
      referenceData,
      user,
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
    ]
  );

  return <WizardContext.Provider value={value}>{children}</WizardContext.Provider>;
}
