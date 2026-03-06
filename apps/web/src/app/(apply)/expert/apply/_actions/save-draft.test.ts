import { describe, it, expect, vi, beforeEach } from 'vitest';

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
const mockCreateDraft = vi.fn();
const mockUpdateProfile = vi.fn();
const mockSyncLanguages = vi.fn();
const mockSyncIndustries = vi.fn();
const mockSyncSkills = vi.fn();
const mockUpdateSkillProficiency = vi.fn();
const mockSyncCertifications = vi.fn();
const mockSyncWorkHistory = vi.fn();

const mockGetSalesforceVertical = vi.fn();
const mockGetSupportTypes = vi.fn();
const mockUserUpdate = vi.fn();

vi.mock('@balo/db', () => ({
  expertsRepository: {
    findApplicationWithRelations: (...args: unknown[]) => mockFindApplicationWithRelations(...args),
    createDraft: (...args: unknown[]) => mockCreateDraft(...args),
    updateProfile: (...args: unknown[]) => mockUpdateProfile(...args),
    syncLanguages: (...args: unknown[]) => mockSyncLanguages(...args),
    syncIndustries: (...args: unknown[]) => mockSyncIndustries(...args),
    syncSkills: (...args: unknown[]) => mockSyncSkills(...args),
    updateSkillProficiency: (...args: unknown[]) => mockUpdateSkillProficiency(...args),
    syncCertifications: (...args: unknown[]) => mockSyncCertifications(...args),
    syncWorkHistory: (...args: unknown[]) => mockSyncWorkHistory(...args),
  },
  referenceDataRepository: {
    getSalesforceVertical: (...args: unknown[]) => mockGetSalesforceVertical(...args),
    getSupportTypes: (...args: unknown[]) => mockGetSupportTypes(...args),
  },
  usersRepository: {
    update: (...args: unknown[]) => mockUserUpdate(...args),
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
    phone: '412345678',
    countryCode: '+61',
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
  mockCreateDraft.mockResolvedValue({ id: PROFILE_ID });
}

// ── Tests ────────────────────────────────────────────────────────

describe('saveDraftAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { user: { id: USER_ID, email: 'test@example.com' }, save: mockSave };
    mockUpdateProfile.mockResolvedValue(undefined);
    mockUserUpdate.mockResolvedValue(undefined);
    mockSyncLanguages.mockResolvedValue(undefined);
    mockSyncIndustries.mockResolvedValue(undefined);
    mockSyncSkills.mockResolvedValue(undefined);
    mockUpdateSkillProficiency.mockResolvedValue(undefined);
    mockSyncCertifications.mockResolvedValue(undefined);
    mockSyncWorkHistory.mockResolvedValue(undefined);
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
        data: { phone: '123' }, // too short, missing required fields
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to save. Please try again.');
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
    });

    it('returns Unauthorized when user does not own the profile', async () => {
      setupOwnershipCheck('other-user');
      const result = await saveDraftAction({
        step: 'profile',
        data: validProfileData(),
        expertProfileId: PROFILE_ID,
      });
      expect(result).toEqual({ success: false, expertProfileId: '', error: 'Unauthorized' });
      expect(mockUpdateProfile).not.toHaveBeenCalled();
    });
  });

  describe('draft creation', () => {
    it('creates new draft when no expertProfileId provided', async () => {
      setupDraftCreation();
      const result = await saveDraftAction({
        step: 'profile',
        data: validProfileData(),
      });
      expect(mockGetSalesforceVertical).toHaveBeenCalled();
      expect(mockCreateDraft).toHaveBeenCalledWith({
        userId: USER_ID,
        verticalId: VERTICAL_ID,
        type: 'freelancer',
      });
      expect(result.success).toBe(true);
      expect(result.expertProfileId).toBe(PROFILE_ID);
    });

    it('skips draft creation when expertProfileId is provided', async () => {
      setupOwnershipCheck();
      const result = await saveDraftAction({
        step: 'profile',
        data: validProfileData(),
        expertProfileId: PROFILE_ID,
      });
      expect(mockCreateDraft).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });

  describe('profile step', () => {
    beforeEach(() => {
      setupOwnershipCheck();
    });

    it('saves profile fields to repository', async () => {
      await saveDraftAction({
        step: 'profile',
        data: validProfileData(),
        expertProfileId: PROFILE_ID,
      });
      expect(mockUpdateProfile).toHaveBeenCalledWith(PROFILE_ID, {
        yearStartedSalesforce: 2015,
        projectCountMin: 10,
        projectLeadCountMin: 1,
        linkedinUrl: 'https://linkedin.com/in/john-doe',
        isSalesforceMvp: false,
        isSalesforceCta: false,
        isCertifiedTrainer: false,
      });
    });

    it('saves null linkedinUrl when slug is empty', async () => {
      await saveDraftAction({
        step: 'profile',
        data: { ...validProfileData(), linkedinSlug: '' },
        expertProfileId: PROFILE_ID,
      });
      expect(mockUpdateProfile).toHaveBeenCalledWith(
        PROFILE_ID,
        expect.objectContaining({ linkedinUrl: null })
      );
    });

    it('updates phone on user record with country code prefix', async () => {
      await saveDraftAction({
        step: 'profile',
        data: validProfileData(),
        expertProfileId: PROFILE_ID,
      });
      expect(mockUserUpdate).toHaveBeenCalledWith(USER_ID, { phone: '+61412345678' });
    });

    it('syncs languages', async () => {
      const languages = [{ languageId: UUID1, proficiency: 'native' as const }];
      await saveDraftAction({
        step: 'profile',
        data: validProfileData(),
        expertProfileId: PROFILE_ID,
      });
      expect(mockSyncLanguages).toHaveBeenCalledWith(PROFILE_ID, languages);
    });

    it('syncs industries', async () => {
      await saveDraftAction({
        step: 'profile',
        data: validProfileData(),
        expertProfileId: PROFILE_ID,
      });
      expect(mockSyncIndustries).toHaveBeenCalledWith(PROFILE_ID, [UUID1]);
    });
  });

  describe('products step', () => {
    beforeEach(() => {
      setupOwnershipCheck();
      mockGetSupportTypes.mockResolvedValue([{ id: SUPPORT_TYPE_ID_1 }, { id: SUPPORT_TYPE_ID_2 }]);
    });

    it('syncs skills with support type IDs', async () => {
      await saveDraftAction({
        step: 'products',
        data: { skillIds: [UUID1, UUID2] },
        expertProfileId: PROFILE_ID,
      });
      expect(mockSyncSkills).toHaveBeenCalledWith(
        PROFILE_ID,
        [UUID1, UUID2],
        [SUPPORT_TYPE_ID_1, SUPPORT_TYPE_ID_2]
      );
    });

    it('fetches support types from reference data', async () => {
      await saveDraftAction({
        step: 'products',
        data: { skillIds: [UUID1] },
        expertProfileId: PROFILE_ID,
      });
      expect(mockGetSupportTypes).toHaveBeenCalled();
    });
  });

  describe('assessment step', () => {
    beforeEach(() => {
      setupOwnershipCheck();
    });

    it('updates skill proficiencies', async () => {
      const ratings = [{ skillId: UUID1, supportTypeId: UUID2, proficiency: 7 }];
      await saveDraftAction({
        step: 'assessment',
        data: { ratings },
        expertProfileId: PROFILE_ID,
      });
      expect(mockUpdateSkillProficiency).toHaveBeenCalledWith(PROFILE_ID, ratings);
    });
  });

  describe('certifications step', () => {
    beforeEach(() => {
      setupOwnershipCheck();
    });

    it('constructs Trailhead URL from slug', async () => {
      await saveDraftAction({
        step: 'certifications',
        data: { trailheadSlug: 'john-doe', certifications: [] },
        expertProfileId: PROFILE_ID,
      });
      expect(mockUpdateProfile).toHaveBeenCalledWith(PROFILE_ID, {
        trailheadUrl: 'https://trailblazer.me/id/john-doe',
      });
    });

    it('clears Trailhead URL when slug is empty', async () => {
      await saveDraftAction({
        step: 'certifications',
        data: { trailheadSlug: '', certifications: [] },
        expertProfileId: PROFILE_ID,
      });
      expect(mockUpdateProfile).toHaveBeenCalledWith(PROFILE_ID, {
        trailheadUrl: null,
      });
    });

    it('syncs certifications', async () => {
      const certifications = [
        { certificationId: UUID1, earnedAt: '2024-01-01', expiresAt: '', credentialUrl: '' },
      ];
      await saveDraftAction({
        step: 'certifications',
        data: { trailheadSlug: '', certifications },
        expertProfileId: PROFILE_ID,
      });
      expect(mockSyncCertifications).toHaveBeenCalledWith(PROFILE_ID, certifications);
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

  describe('invite step', () => {
    beforeEach(() => {
      setupOwnershipCheck();
    });

    it('returns success without calling any repository', async () => {
      const result = await saveDraftAction({
        step: 'invite',
        data: { emails: ['test@example.com'] },
        expertProfileId: PROFILE_ID,
      });
      expect(result.success).toBe(true);
      expect(mockUpdateProfile).not.toHaveBeenCalled();
      expect(mockSyncWorkHistory).not.toHaveBeenCalled();
    });
  });

  describe('terms step', () => {
    beforeEach(() => {
      setupOwnershipCheck();
    });

    it('returns success without calling any repository', async () => {
      const result = await saveDraftAction({
        step: 'terms',
        data: { termsAccepted: true },
        expertProfileId: PROFILE_ID,
      });
      expect(result.success).toBe(true);
      expect(mockUpdateProfile).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('returns error when repository throws during save', async () => {
      setupOwnershipCheck();
      mockUpdateProfile.mockRejectedValue(new Error('DB error'));
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

    it('returns error when draft creation fails', async () => {
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
