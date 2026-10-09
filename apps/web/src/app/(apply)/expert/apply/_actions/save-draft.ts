'use server';
import 'server-only';
import { withAuth } from '@/lib/auth/with-auth';
import {
  expertsRepository,
  referenceDataRepository,
  isUniqueViolation,
  type ApplicantDraftStepWrite,
} from '@balo/db';
import { log } from '@/lib/logging';
import { sanitizeResponsibilitiesHtml } from '@/lib/sanitize/work-history-html';
import { trackServerAndFlush, EXPERT_SERVER_EVENTS } from '@/lib/analytics/server';
import { z } from 'zod';
import {
  DECLINED_APPLICATION_ERROR,
  SUBMITTED_APPLICATION_ERROR,
} from './declined-application-copy';
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
    'agency',
    'products',
    'assessment',
    'certifications',
    'work-history',
    'terms',
  ]),
  data: z.unknown(),
  expertProfileId: z.uuid().optional(),
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

/**
 * BAL-593 H1 — THE WIZARD'S ONE WRITE PATH NOW GOES THROUGH `saveApplicantDraftStep`. Every
 * step that carries an id (and the profile step's first save, which may adopt an existing row)
 * is locked `FOR UPDATE` and checked against the LOCKED status before its writer runs on the same
 * transaction — the same lock `editApplicationAsStaff` and `decideApplication` take, so a staff
 * write and an applicant write serialise.
 *
 * `draft`, and a `submitted` row inside the post-submit grace (`APPLICANT_POST_SUBMIT_GRACE_MS`,
 * 60 s — covers the debounced autosave and the unload beacon), are writable. `rejected` is
 * `declined` (`DECLINED_APPLICATION_ERROR`) — STAYS `declined`, even after BAL-557. The only
 * route from `rejected` back to a writable row is `expertsRepository.reopenApplication`
 * (`startNewApplicationAction`), an explicit action the applicant must take; a stale wizard tab
 * left open on a still-`rejected` row keeps refusing every write. Everything else — a later
 * `submitted`, `under_review`, `approved` — is `closed` (`SUBMITTED_APPLICATION_ERROR`): the
 * applicant can no longer write a non-draft application, full stop.
 *
 * `terms` and `agency` (BAL-356, self-advancing) pass `write: { step: 'none' }` when an id
 * exists (lock and check, no write — the agency step performs its own determined write via
 * `linkExpertAgencyAction`); with no id yet there is nothing to lock, so they no-op below.
 */
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

      // 3. Lock, check and write in one call — only when there is a row to lock (an id) or
      //    the profile step, which may create one. All other DB-writing steps require an
      //    existing draft (profile is always saved first and its id threaded forward); the
      //    old lazy "create on any step" path was an orphan vector and stays removed.
      if (profileId !== undefined || input.step === 'profile') {
        const write = await buildStepWrite(input.step, parsed);
        const draftInput = profileId
          ? undefined
          : await buildDraftInput(session.user.id, session.user.firstName, session.user.lastName);

        const result = await expertsRepository.saveApplicantDraftStep({
          applicantUserId: session.user.id,
          expertProfileId: profileId,
          draftInput,
          now: new Date(),
          write,
        });

        if (result.outcome === 'not_owner') {
          return { success: false, expertProfileId: '', error: 'Unauthorized' };
        }
        if (result.outcome === 'declined') {
          return {
            success: false,
            expertProfileId: result.expertProfileId,
            error: DECLINED_APPLICATION_ERROR,
          };
        }
        if (result.outcome === 'closed') {
          log.warn('Expert application draft write refused: application no longer a draft', {
            userId: session.user.id,
            expertProfileId: result.expertProfileId,
            step: input.step,
            currentStatus: result.currentStatus,
          });
          return {
            success: false,
            expertProfileId: result.expertProfileId,
            error: SUBMITTED_APPLICATION_ERROR,
          };
        }

        profileId = result.expertProfileId;
      } else if (isNonProfileDraftStep(input.step)) {
        throw new Error(`Cannot save ${input.step} step before the profile step`);
      }
      // `terms` / `agency` with no draft yet: nothing to lock or write.

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
 * Build the step's write for `saveApplicantDraftStep` from the lenient draft-schema output.
 * `terms` and `agency` (BAL-356, self-advancing) carry no write of their own — `'none'` locks
 * and checks the row without touching it.
 */
async function buildStepWrite(step: StepName, parsed: unknown): Promise<ApplicantDraftStepWrite> {
  switch (step) {
    case 'profile': {
      const data = parsed as ProfileStepDraftData;
      return {
        step: 'profile',
        data: {
          yearStartedSalesforce: data.yearStartedSalesforce,
          projectCountMin: data.projectCountMin,
          projectLeadCountMin: data.projectLeadCountMin,
          linkedinUrl: data.linkedinSlug ? `https://linkedin.com/in/${data.linkedinSlug}` : null,
          isSalesforceMvp: data.isSalesforceMvp,
          isSalesforceCta: data.isSalesforceCta,
          isCertifiedTrainer: data.isCertifiedTrainer,
          languages: data.languages,
          industryIds: data.industryIds,
        },
      };
    }
    case 'products': {
      const data = parsed as ProductsStepDraftData;
      const vertical = await referenceDataRepository.getSalesforceVertical();
      const supportTypes = await referenceDataRepository.getSupportTypes(vertical.id);
      return {
        step: 'products',
        productIds: data.productIds,
        supportTypeIds: supportTypes.map((st) => st.id),
      };
    }
    case 'assessment': {
      const data = parsed as AssessmentStepDraftData;
      return { step: 'assessment', ratings: data.ratings };
    }
    case 'certifications': {
      const data = parsed as CertificationsStepData;
      return {
        step: 'certifications',
        trailheadUrl: data.trailheadSlug ? `https://trailblazer.me/id/${data.trailheadSlug}` : null,
        certs: data.certifications ?? [],
      };
    }
    case 'work-history': {
      const data = parsed as WorkHistoryStepData;
      return {
        step: 'work-history',
        entries: (data.entries ?? []).map((entry) => ({
          ...entry,
          responsibilities: sanitizeResponsibilitiesHtml(entry.responsibilities),
        })),
      };
    }
    case 'terms':
    case 'agency':
      return { step: 'none' };
  }
}
