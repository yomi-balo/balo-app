import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EXPERT_SERVER_EVENTS } from '@balo/analytics/events';

// ── Constants ────────────────────────────────────────────────────

const UUID1 = 'a0000000-0000-4000-8000-000000000001';
const UUID2 = 'a0000000-0000-4000-8000-000000000002';
const USER_ID = 'user-1';
const PROFILE_ID = 'b0000000-0000-4000-8000-000000000001';
const VERTICAL_ID = 'vertical-1';
const SUPPORT_TYPE_ID_1 = 'a0000000-0000-4000-8000-000000000010';
const SUPPORT_TYPE_ID_2 = 'a0000000-0000-4000-8000-000000000011';

// ── Mocks ────────────────────────────────────────────────────────

vi.mock('server-only', () => ({}));

const mockFindApplicationWithRelations = vi.fn();
const mockSaveProfileStep = vi.fn();
const mockSaveCertificationsStep = vi.fn();
const mockSyncProducts = vi.fn();
const mockUpdateCompetencyProficiency = vi.fn();
const mockSyncWorkHistory = vi.fn();
const mockIsUniqueViolation = vi.fn();

const mockGetSalesforceVertical = vi.fn();
const mockGetSupportTypes = vi.fn();

vi.mock('@balo/db', () => ({
  expertsRepository: {
    findApplicationWithRelations: (...args: unknown[]) => mockFindApplicationWithRelations(...args),
    saveProfileStep: (...args: unknown[]) => mockSaveProfileStep(...args),
    saveCertificationsStep: (...args: unknown[]) => mockSaveCertificationsStep(...args),
    syncProducts: (...args: unknown[]) => mockSyncProducts(...args),
    updateCompetencyProficiency: (...args: unknown[]) => mockUpdateCompetencyProficiency(...args),
    syncWorkHistory: (...args: unknown[]) => mockSyncWorkHistory(...args),
  },
  referenceDataRepository: {
    getSalesforceVertical: (...args: unknown[]) => mockGetSalesforceVertical(...args),
    getSupportTypes: (...args: unknown[]) => mockGetSupportTypes(...args),
  },
  isUniqueViolation: (...args: unknown[]) => mockIsUniqueViolation(...args),
}));

const mockTrackServerAndFlush = vi.fn();

vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...args: unknown[]) => mockTrackServerAndFlush(...args),
  EXPERT_SERVER_EVENTS: {
    DRAFT_SAVED: 'expert_application_draft_saved',
    DRAFT_SAVE_FAILED: 'expert_application_draft_save_failed',
  },
}));

const mockSave = vi.fn();
let mockSessionObj: Record<string, unknown>;

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { saveDraftAction } from './save-draft';

// ── Helpers ──────────────────────────────────────────────────────

function validProfileData() {
  return {
    yearStartedSalesforce: 2015,
    projectCountMin: 10,
    projectLeadCountMin: 1,
    linkedinSlug: 'john-doe',
    isSalesforceMvp: false,
    isSalesforceCta: false,
    isCertifiedTrainer: false,
    languages: [{ languageId: UUID1, proficiency: 'native' as const }],
    industryIds: [UUID1],
  };
}

function setupOwnershipCheck(userId = USER_ID): void {
  mockFindApplicationWithRelations.mockResolvedValue({
    profile: { id: PROFILE_ID, userId },
  });
}

function setupDraftCreation(): void {
  mockGetSalesforceVertical.mockResolvedValue({ id: VERTICAL_ID });
  mockSaveProfileStep.mockResolvedValue({ id: PROFILE_ID });
}

// ── Tests ────────────────────────────────────────────────────────

describe('saveDraftAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = {
      user: {
        id: USER_ID,
        onboardingCompleted: true,
        email: 'test@example.com',
        firstName: 'John',
        lastName: 'Doe',
      },
      save: mockSave,
    };
    mockSaveProfileStep.mockResolvedValue({ id: PROFILE_ID });
    mockSaveCertificationsStep.mockResolvedValue(undefined);
    mockSyncProducts.mockResolvedValue(undefined);
    mockUpdateCompetencyProficiency.mockResolvedValue(undefined);
    mockSyncWorkHistory.mockResolvedValue(undefined);
    mockIsUniqueViolation.mockReturnValue(false);
  });

  describe('authentication', () => {
    it('throws when session has no user', async () => {
      mockSessionObj = { save: mockSave };
      await expect(saveDraftAction({ step: 'profile', data: validProfileData() })).rejects.toThrow(
        'Unauthorized'
      );
    });

    it('throws when session user has no id', async () => {
      mockSessionObj = { user: {}, save: mockSave };
      await expect(saveDraftAction({ step: 'profile', data: validProfileData() })).rejects.toThrow(
        'Unauthorized'
      );
    });
  });

  describe('input validation', () => {
    it('returns error for invalid step key', async () => {
      const result = await saveDraftAction({
        step: 'invalid-step' as 'profile',
        data: {},
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to save. Please try again.');
    });

    it('returns error for invalid expertProfileId format', async () => {
      const result = await saveDraftAction({
        step: 'profile',
        data: validProfileData(),
        expertProfileId: 'not-a-uuid',
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to save. Please try again.');
    });

    it('returns error when step data fails schema validation', async () => {
      setupDraftCreation();
      const result = await saveDraftAction({
        step: 'profile',
        data: { yearStartedSalesforce: 'not-a-number' }, // wrong type
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to save. Please try again.');
    });

    it('does NOT write to the repository when validation fails (validate-before-write)', async () => {
      setupDraftCreation();
      await saveDraftAction({
        step: 'profile',
        data: { yearStartedSalesforce: 'not-a-number' },
      });
      expect(mockSaveProfileStep).not.toHaveBeenCalled();
      expect(mockGetSalesforceVertical).not.toHaveBeenCalled();
    });

    it('fires DRAFT_SAVE_FAILED with error_code "validation" on a schema failure', async () => {
      setupDraftCreation();
      await saveDraftAction({
        step: 'profile',
        data: { yearStartedSalesforce: 'not-a-number' },
      });
      expect(mockTrackServerAndFlush).toHaveBeenCalledWith(
        EXPERT_SERVER_EVENTS.DRAFT_SAVE_FAILED,
        expect.objectContaining({
          step: 'profile',
          error_code: 'validation',
          distinct_id: USER_ID,
        })
      );
    });
  });

  describe('ownership verification', () => {
    it('returns Unauthorized when profile not found', async () => {
      mockFindApplicationWithRelations.mockResolvedValue(null);
      const result = await saveDraftAction({
        step: 'profile',
        data: validProfileData(),
        expertProfileId: PROFILE_ID,
      });
      expect(result).toEqual({ success: false, expertProfileId: '', error: 'Unauthorized' });
      expect(mockSaveProfileStep).not.toHaveBeenCalled();
    });

    it('returns Unauthorized when user does not own the profile', async () => {
      setupOwnershipCheck('other-user');
      const result = await saveDraftAction({
        step: 'profile',
        data: validProfileData(),
        expertProfileId: PROFILE_ID,
      });
      expect(result).toEqual({ success: false, expertProfileId: '', error: 'Unauthorized' });
      expect(mockSaveProfileStep).not.toHaveBeenCalled();
    });
  });

  describe('draft creation', () => {
    it('creates a new draft via saveProfileStep when no expertProfileId provided', async () => {
      setupDraftCreation();
      const result = await saveDraftAction({
        step: 'profile',
        data: validProfileData(),
      });
      expect(mockGetSalesforceVertical).toHaveBeenCalled();
      expect(mockSaveProfileStep).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({
          userId: USER_ID,
          verticalId: VERTICAL_ID,
          type: 'freelancer',
          firstName: 'John',
          lastName: 'Doe',
        }),
        expect.any(Object)
      );
      expect(result.success).toBe(true);
      expect(result.expertProfileId).toBe(PROFILE_ID);
    });

    it('passes the existing id (no create) when expertProfileId is provided', async () => {
      setupOwnershipCheck();
      const result = await saveDraftAction({
        step: 'profile',
        data: validProfileData(),
        expertProfileId: PROFILE_ID,
      });
      expect(mockGetSalesforceVertical).not.toHaveBeenCalled();
      expect(mockSaveProfileStep).toHaveBeenCalledWith(PROFILE_ID, undefined, expect.any(Object));
      expect(result.success).toBe(true);
    });

    it('accepts a lenient draft with empty languages and industries', async () => {
      setupDraftCreation();
      const result = await saveDraftAction({
        step: 'profile',
        data: { ...validProfileData(), languages: [], industryIds: [] },
      });
      expect(result.success).toBe(true);
      expect(mockSaveProfileStep).toHaveBeenCalledWith(
        undefined,
        expect.any(Object),
        expect.objectContaining({ languages: [], industryIds: [] })
      );
    });
  });

  describe('profile step', () => {
    beforeEach(() => {
      setupOwnershipCheck();
    });

    it('maps profile fields into the saveProfileStep write', async () => {
      await saveDraftAction({
        step: 'profile',
        data: validProfileData(),
        expertProfileId: PROFILE_ID,
      });
      expect(mockSaveProfileStep).toHaveBeenCalledWith(
        PROFILE_ID,
        undefined,
        expect.objectContaining({
          yearStartedSalesforce: 2015,
          projectCountMin: 10,
          projectLeadCountMin: 1,
          linkedinUrl: 'https://linkedin.com/in/john-doe',
          isSalesforceMvp: false,
          isSalesforceCta: false,
          isCertifiedTrainer: false,
          languages: [{ languageId: UUID1, proficiency: 'native' }],
          industryIds: [UUID1],
        })
      );
    });

    it('writes null linkedinUrl when slug is empty', async () => {
      await saveDraftAction({
        step: 'profile',
        data: { ...validProfileData(), linkedinSlug: '' },
        expertProfileId: PROFILE_ID,
      });
      expect(mockSaveProfileStep).toHaveBeenCalledWith(
        PROFILE_ID,
        undefined,
        expect.objectContaining({ linkedinUrl: null })
      );
    });

    it('fires DRAFT_SAVED on success with the resolved id', async () => {
      await saveDraftAction({
        step: 'profile',
        data: validProfileData(),
        expertProfileId: PROFILE_ID,
      });
      expect(mockTrackServerAndFlush).toHaveBeenCalledWith(EXPERT_SERVER_EVENTS.DRAFT_SAVED, {
        step: 'profile',
        expert_profile_id: PROFILE_ID,
        distinct_id: USER_ID,
      });
    });
  });

  describe('products step', () => {
    beforeEach(() => {
      setupOwnershipCheck();
      mockGetSalesforceVertical.mockResolvedValue({ id: VERTICAL_ID });
      mockGetSupportTypes.mockResolvedValue([{ id: SUPPORT_TYPE_ID_1 }, { id: SUPPORT_TYPE_ID_2 }]);
    });

    it('syncs products with support type IDs', async () => {
      await saveDraftAction({
        step: 'products',
        data: { productIds: [UUID1, UUID2] },
        expertProfileId: PROFILE_ID,
      });
      expect(mockSyncProducts).toHaveBeenCalledWith(
        PROFILE_ID,
        [UUID1, UUID2],
        [SUPPORT_TYPE_ID_1, SUPPORT_TYPE_ID_2]
      );
    });

    it('fetches support types from reference data', async () => {
      await saveDraftAction({
        step: 'products',
        data: { productIds: [UUID1] },
        expertProfileId: PROFILE_ID,
      });
      expect(mockGetSupportTypes).toHaveBeenCalled();
    });

    it('returns a failure (unknown) when no draft exists yet', async () => {
      const result = await saveDraftAction({
        step: 'products',
        data: { productIds: [UUID1] },
      });
      expect(result.success).toBe(false);
      expect(mockSyncProducts).not.toHaveBeenCalled();
      expect(mockTrackServerAndFlush).toHaveBeenCalledWith(
        EXPERT_SERVER_EVENTS.DRAFT_SAVE_FAILED,
        expect.objectContaining({ step: 'products', error_code: 'unknown' })
      );
    });
  });

  describe('assessment step', () => {
    beforeEach(() => {
      setupOwnershipCheck();
    });

    it('updates competency proficiencies', async () => {
      const ratings = [{ productId: UUID1, supportTypeId: UUID2, proficiency: 7 }];
      await saveDraftAction({
        step: 'assessment',
        data: { ratings },
        expertProfileId: PROFILE_ID,
      });
      expect(mockUpdateCompetencyProficiency).toHaveBeenCalledWith(PROFILE_ID, ratings);
    });

    it('accepts an all-zero assessment draft (refine dropped)', async () => {
      const ratings = [{ productId: UUID1, supportTypeId: UUID2, proficiency: 0 }];
      const result = await saveDraftAction({
        step: 'assessment',
        data: { ratings },
        expertProfileId: PROFILE_ID,
      });
      expect(result.success).toBe(true);
      expect(mockUpdateCompetencyProficiency).toHaveBeenCalledWith(PROFILE_ID, ratings);
    });
  });

  describe('certifications step', () => {
    beforeEach(() => {
      setupOwnershipCheck();
    });

    it('saves trailhead URL and certifications atomically', async () => {
      const certifications = [
        { certificationId: UUID1, earnedAt: '2024-01-01', expiresAt: '', credentialUrl: '' },
      ];
      await saveDraftAction({
        step: 'certifications',
        data: { trailheadSlug: 'john-doe', certifications },
        expertProfileId: PROFILE_ID,
      });
      expect(mockSaveCertificationsStep).toHaveBeenCalledWith(
        PROFILE_ID,
        'https://trailblazer.me/id/john-doe',
        certifications
      );
    });

    it('clears the Trailhead URL when the slug is empty', async () => {
      await saveDraftAction({
        step: 'certifications',
        data: { trailheadSlug: '', certifications: [] },
        expertProfileId: PROFILE_ID,
      });
      expect(mockSaveCertificationsStep).toHaveBeenCalledWith(PROFILE_ID, null, []);
    });
  });

  describe('work-history step', () => {
    beforeEach(() => {
      setupOwnershipCheck();
    });

    it('syncs work history entries', async () => {
      const entries = [
        {
          role: 'Senior Consultant',
          company: 'Acme Corp',
          startedAt: '2020-01-01',
          endedAt: '2023-06-01',
          isCurrent: false,
          responsibilities: 'Led projects.',
        },
      ];
      await saveDraftAction({
        step: 'work-history',
        data: { entries },
        expertProfileId: PROFILE_ID,
      });
      expect(mockSyncWorkHistory).toHaveBeenCalledWith(PROFILE_ID, entries);
    });
  });

  describe('removed invite step (BAL-325)', () => {
    beforeEach(() => {
      setupOwnershipCheck();
    });

    it('rejects the retired step: "invite" as invalid input', async () => {
      const result = await saveDraftAction({
        // The invite step was removed — the enum no longer accepts it, so the
        // envelope parse throws a ZodError and the action returns a save failure.
        step: 'invite' as unknown as 'terms',
        data: { emails: ['test@example.com'] },
        expertProfileId: PROFILE_ID,
      });
      expect(result.success).toBe(false);
      expect(mockSaveProfileStep).not.toHaveBeenCalled();
      expect(mockSyncWorkHistory).not.toHaveBeenCalled();
    });
  });

  describe('terms step', () => {
    beforeEach(() => {
      setupOwnershipCheck();
    });

    it('returns success and accepts an unchecked terms draft', async () => {
      const result = await saveDraftAction({
        step: 'terms',
        data: { termsAccepted: false },
        expertProfileId: PROFILE_ID,
      });
      expect(result.success).toBe(true);
      expect(mockSaveProfileStep).not.toHaveBeenCalled();
    });
  });

  describe('agency step (BAL-356 — self-advancing no-op)', () => {
    beforeEach(() => {
      setupOwnershipCheck();
    });

    it('accepts the permissive agency draft and writes nothing (the write is its own action)', async () => {
      const result = await saveDraftAction({
        step: 'agency',
        data: { agencyId: null },
        expertProfileId: PROFILE_ID,
      });
      expect(result.success).toBe(true);
      expect(result.expertProfileId).toBe(PROFILE_ID);
      // No repository write path runs for the agency step.
      expect(mockSaveProfileStep).not.toHaveBeenCalled();
      expect(mockSyncProducts).not.toHaveBeenCalled();
      expect(mockUpdateCompetencyProficiency).not.toHaveBeenCalled();
      expect(mockSyncWorkHistory).not.toHaveBeenCalled();
      expect(mockSaveCertificationsStep).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('returns the known id (not empty) when the repository throws during save', async () => {
      setupOwnershipCheck();
      mockSaveProfileStep.mockRejectedValue(new Error('DB error'));
      const result = await saveDraftAction({
        step: 'profile',
        data: validProfileData(),
        expertProfileId: PROFILE_ID,
      });
      expect(result).toEqual({
        success: false,
        expertProfileId: PROFILE_ID,
        error: 'Failed to save. Please try again.',
      });
    });

    it('classifies a duplicate-key violation as error_code "duplicate_key"', async () => {
      setupOwnershipCheck();
      const uniqueViolation = Object.assign(new Error('duplicate key value'), {
        code: '23505',
        constraint_name: 'expert_user_vertical_idx',
      });
      mockSaveProfileStep.mockRejectedValue(uniqueViolation);
      mockIsUniqueViolation.mockReturnValue(true);

      const result = await saveDraftAction({
        step: 'profile',
        data: validProfileData(),
        expertProfileId: PROFILE_ID,
      });

      expect(result.success).toBe(false);
      expect(result.expertProfileId).toBe(PROFILE_ID);
      expect(mockTrackServerAndFlush).toHaveBeenCalledWith(
        EXPERT_SERVER_EVENTS.DRAFT_SAVE_FAILED,
        expect.objectContaining({
          step: 'profile',
          error_code: 'duplicate_key',
          expert_profile_id: PROFILE_ID,
        })
      );
    });

    it('classifies a generic DB error as error_code "unknown"', async () => {
      setupOwnershipCheck();
      mockSaveProfileStep.mockRejectedValue(new Error('connection reset'));
      mockIsUniqueViolation.mockReturnValue(false);

      await saveDraftAction({
        step: 'profile',
        data: validProfileData(),
        expertProfileId: PROFILE_ID,
      });

      expect(mockTrackServerAndFlush).toHaveBeenCalledWith(
        EXPERT_SERVER_EVENTS.DRAFT_SAVE_FAILED,
        expect.objectContaining({ step: 'profile', error_code: 'unknown' })
      );
    });

    it('returns error when draft creation fails (vertical lookup throws)', async () => {
      mockGetSalesforceVertical.mockRejectedValue(new Error('No vertical'));
      const result = await saveDraftAction({
        step: 'profile',
        data: validProfileData(),
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to save. Please try again.');
    });
  });
});
