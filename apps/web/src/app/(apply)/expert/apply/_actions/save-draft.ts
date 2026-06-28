'use server';
import 'server-only';
import { withAuth, type AuthenticatedSession } from '@/lib/auth/with-auth';
import { expertsRepository, referenceDataRepository, isUniqueViolation } from '@balo/db';
import { log } from '@/lib/logging';
import { trackServerAndFlush, EXPERT_SERVER_EVENTS } from '@/lib/analytics/server';
import { z } from 'zod';
import {
  STEP_DRAFT_SCHEMAS,
  type ProfileStepDraftData,
  type ProductsStepDraftData,
  type AssessmentStepDraftData,
  type CertificationsStepData,
  type WorkHistoryStepData,
} from './schemas';

const saveDraftInputSchema = z.object({
  step: z.enum([
    'profile',
    'products',
    'assessment',
    'certifications',
    'work-history',
    'invite',
    'terms',
  ]),
  data: z.unknown(),
  expertProfileId: z.string().uuid().optional(),
});

type SaveDraftInput = z.infer<typeof saveDraftInputSchema>;
type StepName = SaveDraftInput['step'];

interface SaveDraftResult {
  success: boolean;
  expertProfileId: string;
  error?: string;
}

type ErrorCode = 'validation' | 'duplicate_key' | 'unknown';

function classifyError(error: unknown): ErrorCode {
  if (error instanceof z.ZodError) return 'validation';
  if (isUniqueViolation(error, 'expert_user_vertical_idx')) return 'duplicate_key';
  return 'unknown';
}

type NonProfileDraftStep = 'products' | 'assessment' | 'certifications' | 'work-history';

/**
 * Steps that require an existing draft (the profile step always creates it first
 * and threads the id forward). The lazy "create a draft on any step's first save"
 * behaviour was an orphan vector and is intentionally removed.
 */
const NON_PROFILE_DRAFT_REQUIRED: ReadonlySet<NonProfileDraftStep> = new Set<NonProfileDraftStep>([
  'products',
  'assessment',
  'certifications',
  'work-history',
]);

function isNonProfileDraftStep(step: StepName): step is NonProfileDraftStep {
  return (NON_PROFILE_DRAFT_REQUIRED as ReadonlySet<StepName>).has(step);
}

export const saveDraftAction = withAuth(
  async (session, rawInput: SaveDraftInput): Promise<SaveDraftResult> => {
    // `profileId` is captured in the outer scope so the catch block can return a
    // known draft id (never an empty id once a draft exists or was created).
    let profileId: string | undefined;

    try {
      // 1. Parse the envelope (throws ZodError → classified as 'validation').
      const input = saveDraftInputSchema.parse(rawInput);
      profileId = input.expertProfileId;

      // 2. Validate the step data BEFORE any DB write (validate-before-write fix).
      const draftSchema = STEP_DRAFT_SCHEMAS[input.step];
      const parsed = draftSchema.parse(input.data);

      // 3. Verify ownership when an id was provided.
      if (profileId && !(await ownsProfile(profileId, session.user.id))) {
        return { success: false, expertProfileId: '', error: 'Unauthorized' };
      }

      // 4. The profile step creates (or reuses) the draft; all other DB-writing
      //    steps require an existing draft (profile is always saved first and its id
      //    threaded forward). The old lazy "create on any step" path was an orphan
      //    vector and is intentionally removed.
      if (input.step === 'profile') {
        profileId = await persistProfileStep(session, profileId, parsed as ProfileStepDraftData);
      } else if (isNonProfileDraftStep(input.step)) {
        if (profileId === undefined) {
          throw new Error(`Cannot save ${input.step} step before the profile step`);
        }
        await dispatchNonProfileStep(input.step, profileId, parsed);
      }
      // `invite` / `terms`: no DB write.

      trackServerAndFlush(EXPERT_SERVER_EVENTS.DRAFT_SAVED, {
        step: input.step,
        expert_profile_id: profileId ?? '',
        distinct_id: session.user.id,
      });

      return { success: true, expertProfileId: profileId ?? '' };
    } catch (error) {
      const errorCode = classifyError(error);
      log.error('Failed to save expert application draft', {
        userId: session.user.id,
        step: rawInput.step,
        errorCode,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      const resolvedId = profileId ?? rawInput.expertProfileId ?? '';
      trackServerAndFlush(EXPERT_SERVER_EVENTS.DRAFT_SAVE_FAILED, {
        step: rawInput.step,
        error_code: errorCode,
        expert_profile_id: resolvedId || null,
        distinct_id: session.user.id,
      });

      return {
        success: false,
        expertProfileId: resolvedId,
        error: 'Failed to save. Please try again.',
      };
    }
  }
);

/** True when `userId` owns the given draft (ownership guard for the autosave). */
async function ownsProfile(profileId: string, userId: string): Promise<boolean> {
  const existing = await expertsRepository.findApplicationWithRelations(profileId);
  return existing?.profile.userId === userId;
}

/**
 * Persist the profile step in one transaction and return the resolved draft id.
 * Creates the draft on a first save (no id) or updates the existing one. Maps the
 * lenient draft data into the repository write shape (derives the LinkedIn URL).
 */
async function persistProfileStep(
  session: AuthenticatedSession,
  profileId: string | undefined,
  data: ProfileStepDraftData
): Promise<string> {
  const draftInput = profileId
    ? undefined
    : await buildDraftInput(session.user.id, session.user.firstName, session.user.lastName);
  const profile = await expertsRepository.saveProfileStep(profileId, draftInput, {
    yearStartedSalesforce: data.yearStartedSalesforce,
    projectCountMin: data.projectCountMin,
    projectLeadCountMin: data.projectLeadCountMin,
    linkedinUrl: data.linkedinSlug ? `https://linkedin.com/in/${data.linkedinSlug}` : null,
    isSalesforceMvp: data.isSalesforceMvp,
    isSalesforceCta: data.isSalesforceCta,
    isCertifiedTrainer: data.isCertifiedTrainer,
    languages: data.languages,
    industryIds: data.industryIds,
  });
  return profile.id;
}

/** Build the create-draft input for a first profile save (resolves the vertical). */
async function buildDraftInput(
  userId: string,
  firstName: string | null,
  lastName: string | null
): Promise<{
  userId: string;
  verticalId: string;
  type: 'freelancer';
  firstName: string | null;
  lastName: string | null;
}> {
  const vertical = await referenceDataRepository.getSalesforceVertical();
  return { userId, verticalId: vertical.id, type: 'freelancer', firstName, lastName };
}

/**
 * Dispatch a non-profile DB-writing step. The draft already exists (`profileId` is
 * required and verified by the caller). `parsed` is the lenient draft-schema output
 * for the step. Each step runs its (now executor-aware, still self-transactional)
 * repository sync AFTER validation.
 */
async function dispatchNonProfileStep(
  step: NonProfileDraftStep,
  profileId: string,
  parsed: unknown
): Promise<void> {
  switch (step) {
    case 'products': {
      const data = parsed as ProductsStepDraftData;
      const vertical = await referenceDataRepository.getSalesforceVertical();
      const supportTypes = await referenceDataRepository.getSupportTypes(vertical.id);
      await expertsRepository.syncProducts(
        profileId,
        data.productIds,
        supportTypes.map((st) => st.id)
      );
      return;
    }
    case 'assessment': {
      const data = parsed as AssessmentStepDraftData;
      await expertsRepository.updateCompetencyProficiency(profileId, data.ratings);
      return;
    }
    case 'certifications': {
      const data = parsed as CertificationsStepData;
      await expertsRepository.saveCertificationsStep(
        profileId,
        data.trailheadSlug ? `https://trailblazer.me/id/${data.trailheadSlug}` : null,
        data.certifications ?? []
      );
      return;
    }
    case 'work-history': {
      const data = parsed as WorkHistoryStepData;
      await expertsRepository.syncWorkHistory(profileId, data.entries ?? []);
      return;
    }
  }
}
