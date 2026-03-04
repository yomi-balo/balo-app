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
  type InviteStepData,
  type TermsStepData,
} from '../_actions/schemas';
import type { ReferenceData } from '../_actions/load-draft';
import type { ApplicationWithRelations } from '@balo/db';

// ── Types ────────────────────────────────────────────────────────

type StepStatus = 'pending' | 'completed' | 'skipped';
type AutoSaveState = 'idle' | 'saving' | 'saved' | 'error';
type Direction = 'forward' | 'backward';

interface WizardState {
  expertProfileId: string | null;
  currentStep: number;
  stepStatuses: StepStatus[];
  direction: Direction;
  autoSaveState: AutoSaveState;
  profileData: Partial<ProfileStepData>;
  productsData: Partial<ProductsStepData>;
  assessmentData: Partial<AssessmentStepData>;
  certificationsData: Partial<CertificationsStepData>;
  workHistoryData: Partial<WorkHistoryStepData>;
  inviteData: Partial<InviteStepData>;
  termsData: Partial<TermsStepData>;
  referenceData: ReferenceData;
  user: { id: string; email: string; phone: string | null };
}

interface WizardActions {
  goToStep: (stepIndex: number) => void;
  goNext: () => Promise<void>;
  goPrevious: () => void;
  skipStep: () => Promise<void>;
  updateStepData: (step: StepKey, data: unknown) => void;
  registerValidation: (fn: () => Promise<boolean>) => void;
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

  // Step 2: Check skills exist
  if (draft.skills.length === 0) return 1;

  // Step 3: Check all skills have at least 1 non-zero rating
  const skillProficiencies = new Map<string, number[]>();
  for (const s of draft.skills) {
    const arr = skillProficiencies.get(s.skillId) ?? [];
    arr.push(s.proficiency);
    skillProficiencies.set(s.skillId, arr);
  }
  for (const [, profs] of skillProficiencies) {
    if (!profs.some((p) => p > 0)) return 2;
  }

  // Steps 4-6 are optional, skip to 6 (terms)
  return 6;
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

function hydrateStepStatuses(draft: ApplicationWithRelations | null): StepStatus[] {
  if (!draft) return Array(7).fill('pending') as StepStatus[];

  const statuses: StepStatus[] = Array(7).fill('pending') as StepStatus[];

  // Step 1: profile
  const hasProfile = draft.profile.yearStartedSalesforce !== null;
  const hasLanguages = draft.languages.length > 0;
  const hasIndustries = draft.industries.length > 0;
  if (hasProfile && hasLanguages && hasIndustries) statuses[0] = 'completed';

  // Step 2: products
  if (draft.skills.length > 0) statuses[1] = 'completed';

  // Step 3: assessment
  if (draft.skills.length > 0) {
    const skillProficiencies = new Map<string, number[]>();
    for (const s of draft.skills) {
      const arr = skillProficiencies.get(s.skillId) ?? [];
      arr.push(s.proficiency);
      skillProficiencies.set(s.skillId, arr);
    }
    let allRated = true;
    for (const [, profs] of skillProficiencies) {
      if (!profs.some((p) => p > 0)) {
        allRated = false;
        break;
      }
    }
    if (allRated) statuses[2] = 'completed';
  }

  // Steps 4-6 are optional - mark as skipped if first 3 are done and they have no data
  if (statuses[0] === 'completed' && statuses[1] === 'completed' && statuses[2] === 'completed') {
    statuses[3] = draft.certifications.length > 0 ? 'completed' : 'skipped';
    statuses[4] = draft.workHistory.length > 0 ? 'completed' : 'skipped';
    statuses[5] = 'skipped'; // Invites are not persisted server-side
  }

  return statuses;
}

function hydrateProfileData(
  draft: ApplicationWithRelations | null,
  userPhone: string | null
): Partial<ProfileStepData> {
  if (!draft) {
    return {
      countryCode: '+61',
      phone: userPhone?.replace(/^\+\d+/, '') ?? '',
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
    countryCode: '+61',
    phone: userPhone?.replace(/^\+\d+/, '') ?? '',
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
  if (!draft) return { skillIds: [] };
  const uniqueSkillIds = [...new Set(draft.skills.map((s) => s.skillId))];
  return { skillIds: uniqueSkillIds };
}

function hydrateAssessmentData(
  draft: ApplicationWithRelations | null
): Partial<AssessmentStepData> {
  if (!draft) return { ratings: [] };
  return {
    ratings: draft.skills.map((s) => ({
      skillId: s.skillId,
      supportTypeId: s.supportTypeId,
      proficiency: s.proficiency,
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
  user: { id: string; email: string; phone: string | null };
}

export function ExpertApplicationProvider({
  children,
  draft,
  referenceData,
  user,
}: ExpertApplicationProviderProps): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();

  const initialStep = useMemo(
    () => resolveInitialStep(searchParams, draft),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const [expertProfileId, setExpertProfileId] = useState<string | null>(draft?.profile.id ?? null);
  const [currentStep, setCurrentStep] = useState(initialStep);
  const [stepStatuses, setStepStatuses] = useState<StepStatus[]>(() => hydrateStepStatuses(draft));
  const [direction, setDirection] = useState<Direction>('forward');
  const [autoSaveState, setAutoSaveState] = useState<AutoSaveState>('idle');

  // Per-step form data
  const [profileData, setProfileData] = useState<Partial<ProfileStepData>>(() =>
    hydrateProfileData(draft, user.phone)
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
  const [inviteData, setInviteData] = useState<Partial<InviteStepData>>({
    emails: [],
  });
  const [termsData, setTermsData] = useState<Partial<TermsStepData>>({});

  // Validation ref
  const validationRef = useRef<(() => Promise<boolean>) | null>(null);

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
        resumed_at_step: STEP_CONFIG[initialStep]!.key,
      });
    } else {
      track(EXPERT_EVENTS.APPLICATION_STARTED, {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update URL on step change
  useEffect(() => {
    const stepKey = STEP_CONFIG[currentStep]!.key;
    router.replace(`/expert/apply?step=${stepKey}`, { scroll: false });
  }, [currentStep, router]);

  const getCurrentStepKey = useCallback((): StepKey => {
    return STEP_CONFIG[currentStep]!.key;
  }, [currentStep]);

  const getStepData = useCallback(
    (step: StepKey): unknown => {
      const dataMap: Record<StepKey, unknown> = {
        profile: profileData,
        products: productsData,
        assessment: assessmentData,
        certifications: certificationsData,
        'work-history': workHistoryData,
        invite: inviteData,
        terms: termsData,
      };
      return dataMap[step];
    },
    [
      profileData,
      productsData,
      assessmentData,
      certificationsData,
      workHistoryData,
      inviteData,
      termsData,
    ]
  );

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

  // ── Actions ──────────────────────────────────────────────────

  const registerValidation = useCallback((fn: () => Promise<boolean>): void => {
    validationRef.current = fn;
  }, []);

  const updateStepData = useCallback(
    (step: StepKey, data: unknown): void => {
      const setters: Record<StepKey, (d: unknown) => void> = {
        profile: (d) => setProfileData(d as Partial<ProfileStepData>),
        products: (d) => setProductsData(d as Partial<ProductsStepData>),
        assessment: (d) => setAssessmentData(d as Partial<AssessmentStepData>),
        certifications: (d) => setCertificationsData(d as Partial<CertificationsStepData>),
        'work-history': (d) => setWorkHistoryData(d as Partial<WorkHistoryStepData>),
        invite: (d) => setInviteData(d as Partial<InviteStepData>),
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
      // Only allow navigating to completed steps or the current step
      if (stepStatuses[stepIndex] === 'pending' && stepIndex > currentStep) return;
      setDirection(stepIndex > currentStep ? 'forward' : 'backward');
      setCurrentStep(stepIndex);
    },
    [stepStatuses, currentStep]
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
    const stepConfig = STEP_CONFIG[currentStep]!;
    track(EXPERT_EVENTS.APPLICATION_STEP_COMPLETED, {
      step: stepConfig.key,
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
      setDirection('backward');
      setCurrentStep((prev) => prev - 1);
    }
  }, [currentStep]);

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
    const skipStepConfig = STEP_CONFIG[currentStep]!;
    track(EXPERT_EVENTS.APPLICATION_STEP_SKIPPED, {
      step: skipStepConfig.key,
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
    // Save current state before leaving
    await performSave();

    // Track analytics
    const abandonStepConfig = STEP_CONFIG[currentStep]!;
    track(EXPERT_EVENTS.APPLICATION_ABANDONED, {
      last_step: abandonStepConfig.key,
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
      stepStatuses,
      direction,
      autoSaveState,
      profileData,
      productsData,
      assessmentData,
      certificationsData,
      workHistoryData,
      inviteData,
      termsData,
      referenceData,
      user,
      goToStep,
      goNext,
      goPrevious,
      skipStep,
      updateStepData,
      registerValidation,
      triggerSave,
      submitApplication: submitApplicationFn,
      abandon,
    }),
    [
      expertProfileId,
      currentStep,
      stepStatuses,
      direction,
      autoSaveState,
      profileData,
      productsData,
      assessmentData,
      certificationsData,
      workHistoryData,
      inviteData,
      termsData,
      referenceData,
      user,
      goToStep,
      goNext,
      goPrevious,
      skipStep,
      updateStepData,
      registerValidation,
      triggerSave,
      submitApplicationFn,
      abandon,
    ]
  );

  return <WizardContext.Provider value={value}>{children}</WizardContext.Provider>;
}
