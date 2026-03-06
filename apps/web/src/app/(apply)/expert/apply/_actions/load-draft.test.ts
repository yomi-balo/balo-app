import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Constants ────────────────────────────────────────────────────

const USER_ID = 'user-1';
const PROFILE_ID = 'profile-1';
const VERTICAL_ID = 'vertical-1';

// ── Mocks ────────────────────────────────────────────────────────

vi.mock('server-only', () => ({}));

const mockFindApplicationByUserId = vi.fn();
const mockFindApplicationWithRelations = vi.fn();
const mockGetSalesforceVertical = vi.fn();
const mockGetSkillsByVertical = vi.fn();
const mockGetSupportTypes = vi.fn();
const mockGetCertsByVertical = vi.fn();
const mockGetLanguages = vi.fn();
const mockGetIndustries = vi.fn();

vi.mock('@balo/db', () => ({
  expertsRepository: {
    findApplicationByUserId: (...args: unknown[]) => mockFindApplicationByUserId(...args),
    findApplicationWithRelations: (...args: unknown[]) => mockFindApplicationWithRelations(...args),
  },
  referenceDataRepository: {
    getSalesforceVertical: (...args: unknown[]) => mockGetSalesforceVertical(...args),
    getSkillsByVertical: (...args: unknown[]) => mockGetSkillsByVertical(...args),
    getSupportTypes: (...args: unknown[]) => mockGetSupportTypes(...args),
    getCertificationsByVertical: (...args: unknown[]) => mockGetCertsByVertical(...args),
    getLanguages: (...args: unknown[]) => mockGetLanguages(...args),
    getIndustries: (...args: unknown[]) => mockGetIndustries(...args),
  },
}));

const mockSave = vi.fn();
let mockSessionObj: Record<string, unknown>;

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { loadDraftAction } from './load-draft';

// ── Helpers ──────────────────────────────────────────────────────

const mockVertical = { id: VERTICAL_ID, name: 'Salesforce' };
const mockSkills = [{ categoryName: 'Sales Cloud', skills: [{ id: 'skill-1', name: 'CPQ' }] }];
const mockSupportTypesList = [{ id: 'st-1', name: 'Technical Support' }];
const mockCerts = [{ categoryName: 'Administrator', certifications: [{ id: 'cert-1' }] }];
const mockLangs = [{ id: 'lang-1', name: 'English' }];
const mockInds = [{ id: 'ind-1', name: 'Financial Services' }];

function setupReferenceData(): void {
  mockGetSalesforceVertical.mockResolvedValue(mockVertical);
  mockGetSkillsByVertical.mockResolvedValue(mockSkills);
  mockGetSupportTypes.mockResolvedValue(mockSupportTypesList);
  mockGetCertsByVertical.mockResolvedValue(mockCerts);
  mockGetLanguages.mockResolvedValue(mockLangs);
  mockGetIndustries.mockResolvedValue(mockInds);
}

function mockDraft() {
  return {
    profile: { id: PROFILE_ID, userId: USER_ID, applicationStatus: 'draft' },
    languages: [],
    industries: [],
    skills: [],
    certifications: [],
    workHistory: [],
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('loadDraftAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { user: { id: USER_ID, email: 'test@example.com' }, save: mockSave };
    setupReferenceData();
  });

  describe('authentication', () => {
    it('throws when session has no user', async () => {
      mockSessionObj = { save: mockSave };
      await expect(loadDraftAction()).rejects.toThrow('Unauthorized');
    });

    it('throws when session user has no id', async () => {
      mockSessionObj = { user: {}, save: mockSave };
      await expect(loadDraftAction()).rejects.toThrow('Unauthorized');
    });
  });

  describe('no existing draft', () => {
    beforeEach(() => {
      mockFindApplicationByUserId.mockResolvedValue(null);
    });

    it('returns null draft', async () => {
      const result = await loadDraftAction();
      expect(result.draft).toBeNull();
    });

    it('does not call findApplicationWithRelations', async () => {
      await loadDraftAction();
      expect(mockFindApplicationWithRelations).not.toHaveBeenCalled();
    });

    it('returns all reference data', async () => {
      const result = await loadDraftAction();
      expect(result.referenceData).toEqual({
        skillsByCategory: mockSkills,
        supportTypes: mockSupportTypesList,
        certificationsByCategory: mockCerts,
        languages: mockLangs,
        industries: mockInds,
        vertical: mockVertical,
      });
    });
  });

  describe('existing draft', () => {
    const draft = mockDraft();

    beforeEach(() => {
      mockFindApplicationByUserId.mockResolvedValue({ id: PROFILE_ID });
      mockFindApplicationWithRelations.mockResolvedValue(draft);
    });

    it('returns the draft with relations', async () => {
      const result = await loadDraftAction();
      expect(result.draft).toEqual(draft);
    });

    it('loads draft using the profile ID from findApplicationByUserId', async () => {
      await loadDraftAction();
      expect(mockFindApplicationWithRelations).toHaveBeenCalledWith(PROFILE_ID);
    });

    it('passes user ID and vertical ID to findApplicationByUserId', async () => {
      await loadDraftAction();
      expect(mockFindApplicationByUserId).toHaveBeenCalledWith(USER_ID, VERTICAL_ID);
    });

    it('returns reference data alongside the draft', async () => {
      const result = await loadDraftAction();
      expect(result.referenceData.vertical).toEqual(mockVertical);
      expect(result.referenceData.skillsByCategory).toEqual(mockSkills);
    });
  });

  describe('error handling', () => {
    it('throws when repository throws (for error boundary)', async () => {
      mockGetSalesforceVertical.mockRejectedValue(new Error('DB connection failed'));
      await expect(loadDraftAction()).rejects.toThrow('DB connection failed');
    });

    it('throws when findApplicationWithRelations fails', async () => {
      mockFindApplicationByUserId.mockResolvedValue({ id: PROFILE_ID });
      mockFindApplicationWithRelations.mockRejectedValue(new Error('Query failed'));
      await expect(loadDraftAction()).rejects.toThrow('Query failed');
    });
  });
});
