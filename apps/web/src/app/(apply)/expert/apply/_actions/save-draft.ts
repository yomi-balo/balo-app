'use server';
import 'server-only';
import { withAuth } from '@/lib/auth/with-auth';
import { expertsRepository, referenceDataRepository, usersRepository } from '@balo/db';
import { log } from '@/lib/logging';
import { z } from 'zod';
import {
  STEP_SCHEMAS,
  type ProfileStepData,
  type ProductsStepData,
  type AssessmentStepData,
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

interface SaveDraftResult {
  success: boolean;
  expertProfileId: string;
  error?: string;
}

export const saveDraftAction = withAuth(
  async (session, rawInput: SaveDraftInput): Promise<SaveDraftResult> => {
    try {
      // Validate the envelope input
      const input = saveDraftInputSchema.parse(rawInput);
      let profileId = input.expertProfileId;

      // Verify ownership when expertProfileId is provided
      if (profileId) {
        const existing = await expertsRepository.findApplicationWithRelations(profileId);
        if (existing?.profile.userId !== session.user.id) {
          return { success: false, expertProfileId: '', error: 'Unauthorized' };
        }
      }

      // Step 1 first save: create the draft profile
      if (!profileId) {
        const vertical = await referenceDataRepository.getSalesforceVertical();
        const profile = await expertsRepository.createDraft({
          userId: session.user.id,
          verticalId: vertical.id,
          type: 'freelancer',
          firstName: session.user.firstName,
          lastName: session.user.lastName,
        });
        profileId = profile.id;
      }

      // Validate step data against its schema
      const schema = STEP_SCHEMAS[input.step];
      const parsed = schema.parse(input.data);

      // Save based on step type
      switch (input.step) {
        case 'profile': {
          const data = parsed as ProfileStepData;
          await expertsRepository.updateProfile(profileId, {
            yearStartedSalesforce: data.yearStartedSalesforce,
            projectCountMin: data.projectCountMin,
            projectLeadCountMin: data.projectLeadCountMin,
            linkedinUrl: data.linkedinSlug ? `https://linkedin.com/in/${data.linkedinSlug}` : null,
            isSalesforceMvp: data.isSalesforceMvp,
            isSalesforceCta: data.isSalesforceCta,
            isCertifiedTrainer: data.isCertifiedTrainer,
          });
          // Update phone on user record
          const fullPhone = `${data.countryCode}${data.phone}`;
          await usersRepository.update(session.user.id, { phone: fullPhone });
          // Sync junction tables
          await expertsRepository.syncLanguages(profileId, data.languages);
          await expertsRepository.syncIndustries(profileId, data.industryIds);
          break;
        }
        case 'products': {
          const data = parsed as ProductsStepData;
          const supportTypes = await referenceDataRepository.getSupportTypes();
          await expertsRepository.syncSkills(
            profileId,
            data.skillIds,
            supportTypes.map((st) => st.id)
          );
          break;
        }
        case 'assessment': {
          const data = parsed as AssessmentStepData;
          await expertsRepository.updateSkillProficiency(profileId, data.ratings);
          break;
        }
        case 'certifications': {
          const data = parsed as CertificationsStepData;
          await expertsRepository.updateProfile(profileId, {
            trailheadUrl: data.trailheadSlug
              ? `https://trailblazer.me/id/${data.trailheadSlug}`
              : null,
          });
          await expertsRepository.syncCertifications(profileId, data.certifications ?? []);
          break;
        }
        case 'work-history': {
          const data = parsed as WorkHistoryStepData;
          await expertsRepository.syncWorkHistory(profileId, data.entries ?? []);
          break;
        }
        case 'invite': {
          // Invites stored client-side only; sent on submission via notification engine
          break;
        }
        case 'terms': {
          // Terms acceptance validated at submission time
          break;
        }
      }

      return { success: true, expertProfileId: profileId };
    } catch (error) {
      log.error('Failed to save expert application draft', {
        userId: session.user.id,
        step: rawInput.step,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return {
        success: false,
        expertProfileId: rawInput.expertProfileId ?? '',
        error: 'Failed to save. Please try again.',
      };
    }
  }
);
