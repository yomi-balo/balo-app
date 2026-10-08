import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EXPERT_SERVER_EVENTS } from '@balo/analytics/events';
import { log } from '@/lib/logging';

// ── Constants ────────────────────────────────────────────────────

const UUID1 = 'a0000000-0000-4000-8000-000000000001';
const UUID2 = 'a0000000-0000-4000-8000-000000000002';
const USER_ID = 'user-1';
const PROFILE_ID = 'b0000000-0000-4000-8000-000000000001';
const VERTICAL_ID = 'vertical-1';
const SUPPORT_TYPE_ID_1 = 'a0000000-0000-4000-8000-000000000010';
const SUPPORT_TYPE_ID_2 = 'a0000000-0000-4000-8000-000000000011';

// ── Mocks ────────────────────────────────────────────────────────

// BAL-568 — the seams re-read the LIVE `users` row; this suite is not about that gate.
vi.mock('@/lib/auth/live-user', async () => (await import('@/test/live-user-double')).mock);

vi.mock('server-only', () => ({}));

const mockSaveApplicantDraftStep = vi.fn();
const mockIsUniqueViolation = vi.fn();

const mockGetSalesforceVertical = vi.fn();
const mockGetSupportTypes = vi.fn();

vi.mock('@balo/db', () => ({
  expertsRepository: {
    saveApplicantDraftStep: (...args: unknown[]) => mockSaveApplicantDraftStep(...args),
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
import {
  DECLINED_APPLICATION_ERROR,
  SUBMITTED_APPLICATION_ERROR,
} from './declined-application-copy';

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

function savedResult(expertProfileId: string = PROFILE_ID): {
  outcome: 'saved';
  expertProfileId: string;
} {
  return { outcome: 'saved', expertProfileId };
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
    mockSaveApplicantDraftStep.mockResolvedValue(savedResult());
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
      const result = await saveDraftAction({
        step: 'profile',
        data: { yearStartedSalesforce: 'not-a-number' }, // wrong type
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to save. Please try again.');
    });

    it('does NOT write to the repository when validation fails (validate-before-write)', async () => {
      await saveDraftAction({
        step: 'profile',
        data: { yearStartedSalesforce: 'not-a-number' },
      });
      expect(mockSaveApplicantDraftStep).not.toHaveBeenCalled();
      expect(mockGetSalesforceVertical).not.toHaveBeenCalled();
    });

    it('fires DRAFT_SAVE_FAILED with error_code "validation" on a schema failure', async () => {
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

  /**
   * BAL-593 H1 — every repository outcome, mapped. The writability check itself (draft / grace /
   * declined / closed) lives in `saveApplicantDraftStep`'s own tests; this action's job is only to
   * translate the discriminant into the right `SaveDraftResult`.
   */
  describe('outcome mapping', () => {
    it('maps not_owner to Unauthorized with an empty id', async () => {
      mockSaveApplicantDraftStep.mockResolvedValue({ outcome: 'not_owner' });
      const result = await saveDraftAction({
        step: 'profile',
        data: validProfileData(),
        expertProfileId: PROFILE_ID,
      });
      expect(result).toEqual({ success: false, expertProfileId: '', error: 'Unauthorized' });
    });

    it('maps declined to the declined-application copy', async () => {
      mockSaveApplicantDraftStep.mockResolvedValue({
        outcome: 'declined',
        expertProfileId: PROFILE_ID,
      });
      const result = await saveDraftAction({
        step: 'profile',
        data: validProfileData(),
        expertProfileId: PROFILE_ID,
      });
      expect(result).toEqual({
        success: false,
        expertProfileId: PROFILE_ID,
        error: DECLINED_APPLICATION_ERROR,
      });
    });

    it('maps closed to SUBMITTED_APPLICATION_ERROR and logs a warning', async () => {
      mockSaveApplicantDraftStep.mockResolvedValue({
        outcome: 'closed',
        expertProfileId: PROFILE_ID,
        currentStatus: 'approved',
      });
      const result = await saveDraftAction({
        step: 'profile',
        data: validProfileData(),
        expertProfileId: PROFILE_ID,
      });
      expect(result).toEqual({
        success: false,
        expertProfileId: PROFILE_ID,
        error: SUBMITTED_APPLICATION_ERROR,
      });
      expect(log.warn).toHaveBeenCalledWith(
        'Expert application draft write refused: application no longer a draft',
        expect.objectContaining({
          userId: USER_ID,
          expertProfileId: PROFILE_ID,
          step: 'profile',
          currentStatus: 'approved',
        })
      );
    });

    it('maps saved to success with the resolved id', async () => {
      mockSaveApplicantDraftStep.mockResolvedValue(savedResult(PROFILE_ID));
      const result = await saveDraftAction({
        step: 'profile',
        data: validProfileData(),
        expertProfileId: PROFILE_ID,
      });
      expect(result).toEqual({ success: true, expertProfileId: PROFILE_ID });
    });
  });

  describe('draft creation (first save, no id)', () => {
    it('builds a draftInput and passes expertProfileId undefined', async () => {
      mockGetSalesforceVertical.mockResolvedValue({ id: VERTICAL_ID });
      const result = await saveDraftAction({
        step: 'profile',
        data: validProfileData(),
      });
      expect(mockSaveApplicantDraftStep).toHaveBeenCalledWith(
        expect.objectContaining({
          applicantUserId: USER_ID,
          expertProfileId: undefined,
          draftInput: expect.objectContaining({
            userId: USER_ID,
            verticalId: VERTICAL_ID,
            type: 'freelancer',
            firstName: 'John',
            lastName: 'Doe',
          }),
          write: expect.objectContaining({ step: 'profile' }),
        })
      );
      expect(result.success).toBe(true);
      expect(result.expertProfileId).toBe(PROFILE_ID);
    });

    it('passes no draftInput (and the existing id) when expertProfileId is provided', async () => {
      const result = await saveDraftAction({
        step: 'profile',
        data: validProfileData(),
        expertProfileId: PROFILE_ID,
      });
      expect(mockGetSalesforceVertical).not.toHaveBeenCalled();
      expect(mockSaveApplicantDraftStep).toHaveBeenCalledWith(
        expect.objectContaining({ expertProfileId: PROFILE_ID, draftInput: undefined })
      );
      expect(result.success).toBe(true);
    });

    it('accepts a lenient draft with empty languages and industries', async () => {
      mockGetSalesforceVertical.mockResolvedValue({ id: VERTICAL_ID });
      const result = await saveDraftAction({
        step: 'profile',
        data: { ...validProfileData(), languages: [], industryIds: [] },
      });
      expect(result.success).toBe(true);
      expect(mockSaveApplicantDraftStep).toHaveBeenCalledWith(
        expect.objectContaining({
          write: expect.objectContaining({
            data: expect.objectContaining({ languages: [], industryIds: [] }),
          }),
        })
      );
    });
  });

  describe('profile step', () => {
    it('maps profile fields into the write', async () => {
      await saveDraftAction({
        step: 'profile',
        data: validProfileData(),
        expertProfileId: PROFILE_ID,
      });
      expect(mockSaveApplicantDraftStep).toHaveBeenCalledWith(
        expect.objectContaining({
          write: {
            step: 'profile',
            data: expect.objectContaining({
              yearStartedSalesforce: 2015,
              projectCountMin: 10,
              projectLeadCountMin: 1,
              linkedinUrl: 'https://linkedin.com/in/john-doe',
              isSalesforceMvp: false,
              isSalesforceCta: false,
              isCertifiedTrainer: false,
              languages: [{ languageId: UUID1, proficiency: 'native' }],
              industryIds: [UUID1],
            }),
          },
        })
      );
    });

    it('writes null linkedinUrl when slug is empty', async () => {
      await saveDraftAction({
        step: 'profile',
        data: { ...validProfileData(), linkedinSlug: '' },
        expertProfileId: PROFILE_ID,
      });
      expect(mockSaveApplicantDraftStep).toHaveBeenCalledWith(
        expect.objectContaining({
          write: expect.objectContaining({ data: expect.objectContaining({ linkedinUrl: null }) }),
        })
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
      mockGetSalesforceVertical.mockResolvedValue({ id: VERTICAL_ID });
      mockGetSupportTypes.mockResolvedValue([{ id: SUPPORT_TYPE_ID_1 }, { id: SUPPORT_TYPE_ID_2 }]);
    });

    it('builds the products write with support type ids', async () => {
      await saveDraftAction({
        step: 'products',
        data: { productIds: [UUID1, UUID2] },
        expertProfileId: PROFILE_ID,
      });
      expect(mockSaveApplicantDraftStep).toHaveBeenCalledWith(
        expect.objectContaining({
          write: {
            step: 'products',
            productIds: [UUID1, UUID2],
            supportTypeIds: [SUPPORT_TYPE_ID_1, SUPPORT_TYPE_ID_2],
          },
        })
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

    it('returns a failure (unknown) and calls no repository method when no draft exists yet', async () => {
      const result = await saveDraftAction({
        step: 'products',
        data: { productIds: [UUID1] },
      });
      expect(result.success).toBe(false);
      expect(mockSaveApplicantDraftStep).not.toHaveBeenCalled();
      expect(mockTrackServerAndFlush).toHaveBeenCalledWith(
        EXPERT_SERVER_EVENTS.DRAFT_SAVE_FAILED,
        expect.objectContaining({ step: 'products', error_code: 'unknown' })
      );
    });
  });

  describe('assessment step', () => {
    it('builds the assessment write with the ratings', async () => {
      const ratings = [{ productId: UUID1, supportTypeId: UUID2, proficiency: 7 }];
      await saveDraftAction({
        step: 'assessment',
        data: { ratings },
        expertProfileId: PROFILE_ID,
      });
      expect(mockSaveApplicantDraftStep).toHaveBeenCalledWith(
        expect.objectContaining({ write: { step: 'assessment', ratings } })
      );
    });

    it('accepts an all-zero assessment draft (refine dropped)', async () => {
      const ratings = [{ productId: UUID1, supportTypeId: UUID2, proficiency: 0 }];
      const result = await saveDraftAction({
        step: 'assessment',
        data: { ratings },
        expertProfileId: PROFILE_ID,
      });
      expect(result.success).toBe(true);
      expect(mockSaveApplicantDraftStep).toHaveBeenCalledWith(
        expect.objectContaining({ write: { step: 'assessment', ratings } })
      );
    });
  });

  describe('certifications step', () => {
    it('builds the certifications write, deriving the Trailhead URL', async () => {
      const certifications = [
        { certificationId: UUID1, earnedAt: '2024-01-01', expiresAt: '', credentialUrl: '' },
      ];
      await saveDraftAction({
        step: 'certifications',
        data: { trailheadSlug: 'john-doe', certifications },
        expertProfileId: PROFILE_ID,
      });
      expect(mockSaveApplicantDraftStep).toHaveBeenCalledWith(
        expect.objectContaining({
          write: {
            step: 'certifications',
            trailheadUrl: 'https://trailblazer.me/id/john-doe',
            certs: certifications,
          },
        })
      );
    });

    it('clears the Trailhead URL when the slug is empty', async () => {
      await saveDraftAction({
        step: 'certifications',
        data: { trailheadSlug: '', certifications: [] },
        expertProfileId: PROFILE_ID,
      });
      expect(mockSaveApplicantDraftStep).toHaveBeenCalledWith(
        expect.objectContaining({
          write: { step: 'certifications', trailheadUrl: null, certs: [] },
        })
      );
    });
  });

  describe('work-history step', () => {
    it('builds the work-history write with sanitized responsibilities', async () => {
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
      // A legacy plain-text value is persisted as escaped paragraph HTML.
      expect(mockSaveApplicantDraftStep).toHaveBeenCalledWith(
        expect.objectContaining({
          write: {
            step: 'work-history',
            entries: [{ ...entries[0], responsibilities: '<p>Led projects.</p>' }],
          },
        })
      );
    });

    const ENTRY = {
      role: 'Senior Consultant',
      company: 'Acme Corp',
      startedAt: '2020-01-01',
      endedAt: '2023-06-01',
      isCurrent: false,
    };

    async function saveResponsibilities(responsibilities: string): Promise<unknown> {
      return saveDraftAction({
        step: 'work-history',
        data: { entries: [{ ...ENTRY, responsibilities }] },
        expertProfileId: PROFILE_ID,
      });
    }

    function persistedResponsibilities(): unknown {
      const [call] = mockSaveApplicantDraftStep.mock.calls as [
        { write: { entries: Array<{ responsibilities: string }> } },
      ][];
      return call?.[0].write.entries[0]?.responsibilities;
    }

    it('keeps the editor formatting and strips anything outside the allow-list', async () => {
      await saveResponsibilities(
        '<ul><li><strong>Led</strong> delivery</li></ul><script>alert(1)</script><p onclick="x()">Ran CPQ</p>'
      );
      expect(persistedResponsibilities()).toBe(
        '<ul><li><strong>Led</strong> delivery</li></ul><p>Ran CPQ</p>'
      );
    });

    it("stores nothing for the editor's empty document", async () => {
      await saveResponsibilities('<p></p>');
      expect(persistedResponsibilities()).toBe('');
    });

    it('bounds the VISIBLE text, not the markup: 1,000 characters of bold text is allowed', async () => {
      await saveResponsibilities(`<p><strong>${'a'.repeat(1000)}</strong></p>`);
      expect(mockSaveApplicantDraftStep).toHaveBeenCalled();
    });

    it('refuses more than 1,000 visible characters and writes nothing', async () => {
      const result = await saveResponsibilities(`<p>${'a'.repeat(1001)}</p>`);
      expect(result).toMatchObject({ success: false });
      expect(mockSaveApplicantDraftStep).not.toHaveBeenCalled();
    });
  });

  describe('removed invite step (BAL-325)', () => {
    it('rejects the retired step: "invite" as invalid input', async () => {
      const result = await saveDraftAction({
        // The invite step was removed — the enum no longer accepts it, so the
        // envelope parse throws a ZodError and the action returns a save failure.
        step: 'invite' as unknown as 'terms',
        data: { emails: ['test@example.com'] },
        expertProfileId: PROFILE_ID,
      });
      expect(result.success).toBe(false);
      expect(mockSaveApplicantDraftStep).not.toHaveBeenCalled();
    });
  });

  describe('terms step', () => {
    it('returns success and accepts an unchecked terms draft, with a none write', async () => {
      const result = await saveDraftAction({
        step: 'terms',
        data: { termsAccepted: false },
        expertProfileId: PROFILE_ID,
      });
      expect(result.success).toBe(true);
      expect(mockSaveApplicantDraftStep).toHaveBeenCalledWith(
        expect.objectContaining({ write: { step: 'none' } })
      );
    });
  });

  describe('agency step (BAL-356 — self-advancing no-op)', () => {
    it('accepts the permissive agency draft with a none write (the write is its own action)', async () => {
      const result = await saveDraftAction({
        step: 'agency',
        data: { agencyId: null },
        expertProfileId: PROFILE_ID,
      });
      expect(result.success).toBe(true);
      expect(result.expertProfileId).toBe(PROFILE_ID);
      expect(mockSaveApplicantDraftStep).toHaveBeenCalledWith(
        expect.objectContaining({ write: { step: 'none' } })
      );
    });

    it('no-ops without a repository call when there is no draft yet', async () => {
      const result = await saveDraftAction({
        step: 'agency',
        data: { agencyId: null },
      });
      expect(result.success).toBe(true);
      expect(result.expertProfileId).toBe('');
      expect(mockSaveApplicantDraftStep).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('returns the known id (not empty) when the repository throws during save', async () => {
      mockSaveApplicantDraftStep.mockRejectedValue(new Error('DB error'));
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
      const uniqueViolation = Object.assign(new Error('duplicate key value'), {
        code: '23505',
        constraint_name: 'expert_user_vertical_idx',
      });
      mockSaveApplicantDraftStep.mockRejectedValue(uniqueViolation);
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
      mockSaveApplicantDraftStep.mockRejectedValue(new Error('connection reset'));
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
