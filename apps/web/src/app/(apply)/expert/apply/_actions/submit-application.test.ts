import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Constants ────────────────────────────────────────────────────

const UUID1 = 'a0000000-0000-4000-8000-000000000001';
const UUID2 = 'a0000000-0000-4000-8000-000000000002';
const USER_ID = 'user-1';
const PROFILE_ID = 'profile-1';

// ── Mocks ────────────────────────────────────────────────────────

vi.mock('server-only', () => ({}));

const mockFindApplicationWithRelations = vi.fn();
const mockSubmitApplication = vi.fn();

vi.mock('@balo/db', () => ({
  expertsRepository: {
    findApplicationWithRelations: (...args: unknown[]) => mockFindApplicationWithRelations(...args),
    submitApplication: (...args: unknown[]) => mockSubmitApplication(...args),
  },
}));

const mockSave = vi.fn();
let mockSessionObj: Record<string, unknown>;

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { submitApplicationAction } from './submit-application';

// ── Helpers ──────────────────────────────────────────────────────

interface MockAppOptions {
  profileOverrides?: Record<string, unknown>;
  languages?: Array<{ languageId: string; proficiency: string }>;
  industries?: Array<{ industryId: string }>;
  skills?: Array<{ skillId: string; supportTypeId: string; proficiency: number }>;
  certifications?: unknown[];
  workHistory?: unknown[];
}

function mockApplication(opts: MockAppOptions = {}) {
  return {
    profile: {
      id: PROFILE_ID,
      userId: USER_ID,
      applicationStatus: 'draft',
      ...opts.profileOverrides,
    },
    languages: opts.languages ?? [{ languageId: UUID1, proficiency: 'native' }],
    industries: opts.industries ?? [{ industryId: UUID1 }],
    skills: opts.skills ?? [{ skillId: UUID1, supportTypeId: UUID2, proficiency: 5 }],
    certifications: opts.certifications ?? [],
    workHistory: opts.workHistory ?? [],
  };
}

function setupValidApplication(opts: MockAppOptions = {}): void {
  mockFindApplicationWithRelations.mockResolvedValue(mockApplication(opts));
  mockSubmitApplication.mockResolvedValue(undefined);
}

// ── Tests ────────────────────────────────────────────────────────

describe('submitApplicationAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { user: { id: USER_ID, email: 'test@example.com' }, save: mockSave };
  });

  describe('authentication', () => {
    it('throws when session has no user', async () => {
      mockSessionObj = { save: mockSave };
      await expect(submitApplicationAction(PROFILE_ID)).rejects.toThrow('Unauthorized');
      expect(mockFindApplicationWithRelations).not.toHaveBeenCalled();
    });

    it('throws when session user has no id', async () => {
      mockSessionObj = { user: {}, save: mockSave };
      await expect(submitApplicationAction(PROFILE_ID)).rejects.toThrow('Unauthorized');
    });
  });

  describe('application lookup', () => {
    it('returns error when application not found', async () => {
      mockFindApplicationWithRelations.mockResolvedValue(null);
      const result = await submitApplicationAction(PROFILE_ID);
      expect(result).toEqual({ success: false, error: 'Application not found' });
    });

    it('returns error when user does not own the application', async () => {
      setupValidApplication({ profileOverrides: { userId: 'other-user' } });
      const result = await submitApplicationAction(PROFILE_ID);
      expect(result).toEqual({ success: false, error: 'Unauthorized' });
      expect(mockSubmitApplication).not.toHaveBeenCalled();
    });
  });

  describe('status validation', () => {
    it('returns error when application already submitted', async () => {
      setupValidApplication({ profileOverrides: { applicationStatus: 'submitted' } });
      const result = await submitApplicationAction(PROFILE_ID);
      expect(result).toEqual({ success: false, error: 'Application already submitted' });
      expect(mockSubmitApplication).not.toHaveBeenCalled();
    });

    it('returns error when application has approved status', async () => {
      setupValidApplication({ profileOverrides: { applicationStatus: 'approved' } });
      const result = await submitApplicationAction(PROFILE_ID);
      expect(result).toEqual({ success: false, error: 'Application already submitted' });
    });
  });

  describe('server-side validation', () => {
    it('returns error with failingStep=profile when no languages', async () => {
      setupValidApplication({ languages: [] });
      const result = await submitApplicationAction(PROFILE_ID);
      expect(result).toEqual({
        success: false,
        error: 'At least one language is required',
        failingStep: 'profile',
      });
      expect(mockSubmitApplication).not.toHaveBeenCalled();
    });

    it('returns error with failingStep=profile when no industries', async () => {
      setupValidApplication({ industries: [] });
      const result = await submitApplicationAction(PROFILE_ID);
      expect(result).toEqual({
        success: false,
        error: 'At least one industry is required',
        failingStep: 'profile',
      });
    });

    it('returns error with failingStep=products when no skills', async () => {
      setupValidApplication({ skills: [] });
      const result = await submitApplicationAction(PROFILE_ID);
      expect(result).toEqual({
        success: false,
        error: 'At least one product is required',
        failingStep: 'products',
      });
    });

    it('returns error with failingStep=assessment when a skill has all-zero proficiencies', async () => {
      setupValidApplication({
        skills: [
          { skillId: UUID1, supportTypeId: UUID2, proficiency: 0 },
          { skillId: UUID1, supportTypeId: 'a0000000-0000-4000-8000-000000000003', proficiency: 0 },
        ],
      });
      const result = await submitApplicationAction(PROFILE_ID);
      expect(result).toEqual({
        success: false,
        error: 'All products must have at least one rated dimension',
        failingStep: 'assessment',
      });
    });

    it('returns error when one skill has all zeros while another is valid', async () => {
      setupValidApplication({
        skills: [
          { skillId: UUID1, supportTypeId: UUID2, proficiency: 8 },
          { skillId: UUID2, supportTypeId: UUID2, proficiency: 0 },
          { skillId: UUID2, supportTypeId: 'a0000000-0000-4000-8000-000000000003', proficiency: 0 },
        ],
      });
      const result = await submitApplicationAction(PROFILE_ID);
      expect(result).toEqual({
        success: false,
        error: 'All products must have at least one rated dimension',
        failingStep: 'assessment',
      });
    });

    it('passes when each skill has at least one non-zero proficiency', async () => {
      setupValidApplication({
        skills: [
          { skillId: UUID1, supportTypeId: UUID2, proficiency: 5 },
          { skillId: UUID1, supportTypeId: 'a0000000-0000-4000-8000-000000000003', proficiency: 0 },
          { skillId: UUID2, supportTypeId: UUID2, proficiency: 0 },
          { skillId: UUID2, supportTypeId: 'a0000000-0000-4000-8000-000000000003', proficiency: 3 },
        ],
      });
      const result = await submitApplicationAction(PROFILE_ID);
      expect(result).toEqual({ success: true });
    });

    it('validates in correct order: languages before industries', async () => {
      setupValidApplication({ languages: [], industries: [] });
      const result = await submitApplicationAction(PROFILE_ID);
      expect(result.failingStep).toBe('profile');
      expect(result.error).toContain('language');
    });
  });

  describe('successful submission', () => {
    it('calls submitApplication with correct profile ID', async () => {
      setupValidApplication();
      await submitApplicationAction(PROFILE_ID);
      expect(mockSubmitApplication).toHaveBeenCalledWith(PROFILE_ID);
    });

    it('returns success true', async () => {
      setupValidApplication();
      const result = await submitApplicationAction(PROFILE_ID);
      expect(result).toEqual({ success: true });
    });

    it('succeeds with optional fields empty', async () => {
      setupValidApplication({ certifications: [], workHistory: [] });
      const result = await submitApplicationAction(PROFILE_ID);
      expect(result).toEqual({ success: true });
    });
  });

  describe('error handling', () => {
    it('returns generic error when repository throws', async () => {
      mockFindApplicationWithRelations.mockRejectedValue(new Error('DB connection failed'));
      const result = await submitApplicationAction(PROFILE_ID);
      expect(result).toEqual({
        success: false,
        error: 'Something went wrong submitting your application. Please try again.',
      });
    });

    it('returns generic error when submitApplication throws', async () => {
      setupValidApplication();
      mockSubmitApplication.mockRejectedValue(new Error('Transaction failed'));
      const result = await submitApplicationAction(PROFILE_ID);
      expect(result).toEqual({
        success: false,
        error: 'Something went wrong submitting your application. Please try again.',
      });
    });
  });
});
