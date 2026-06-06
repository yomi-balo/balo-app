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
const mockGetProductsByVertical = vi.fn();
const mockGetSupportTypes = vi.fn();
const mockGetCertsByVertical = vi.fn();

vi.mock('@balo/db', () => ({
  expertsRepository: {
    findApplicationByUserId: (...args: unknown[]) => mockFindApplicationByUserId(...args),
    findApplicationWithRelations: (...args: unknown[]) => mockFindApplicationWithRelations(...args),
  },
  referenceDataRepository: {
    getSalesforceVertical: (...args: unknown[]) => mockGetSalesforceVertical(...args),
    getProductsByVertical: (...args: unknown[]) => mockGetProductsByVertical(...args),
    getSupportTypes: (...args: unknown[]) => mockGetSupportTypes(...args),
    getCertificationsByVertical: (...args: unknown[]) => mockGetCertsByVertical(...args),
  },
}));

const mockSave = vi.fn();
let mockSessionObj: Record<string, unknown>;

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { loadSubmittedApplication } from './load-submitted';

// ── Helpers ──────────────────────────────────────────────────────

const mockVertical = { id: VERTICAL_ID, name: 'Salesforce' };
const mockSkills = [
  { category: { id: 'cat-1', name: 'Sales Cloud' }, products: [{ id: 'skill-1' }] },
];
const mockSupportTypesList = [{ id: 'st-1', name: 'Technical Support' }];
const mockCerts = [
  { category: { id: 'cc-1', name: 'Administrator' }, certifications: [{ id: 'cert-1' }] },
];

function mockApplication() {
  return {
    profile: { id: PROFILE_ID, userId: USER_ID, applicationStatus: 'submitted' },
    languages: [],
    industries: [],
    skills: [],
    certifications: [],
    workHistory: [],
  };
}

function setupReferenceData(): void {
  mockGetSalesforceVertical.mockResolvedValue(mockVertical);
  mockGetProductsByVertical.mockResolvedValue(mockSkills);
  mockGetSupportTypes.mockResolvedValue(mockSupportTypesList);
  mockGetCertsByVertical.mockResolvedValue(mockCerts);
}

// ── Tests ────────────────────────────────────────────────────────

describe('loadSubmittedApplication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { user: { id: USER_ID, email: 'test@example.com' }, save: mockSave };
    setupReferenceData();
  });

  describe('authentication', () => {
    it('throws when session has no user', async () => {
      mockSessionObj = { save: mockSave };
      await expect(loadSubmittedApplication()).rejects.toThrow('Unauthorized');
    });

    it('throws when session user has no id', async () => {
      mockSessionObj = { user: {}, save: mockSave };
      await expect(loadSubmittedApplication()).rejects.toThrow('Unauthorized');
    });
  });

  describe('no existing profile', () => {
    beforeEach(() => {
      mockFindApplicationByUserId.mockResolvedValue(undefined);
    });

    it('returns null', async () => {
      const result = await loadSubmittedApplication();
      expect(result).toBeNull();
    });

    it('does not load reference data or relations', async () => {
      await loadSubmittedApplication();
      expect(mockFindApplicationWithRelations).not.toHaveBeenCalled();
      expect(mockGetProductsByVertical).not.toHaveBeenCalled();
      expect(mockGetSupportTypes).not.toHaveBeenCalled();
      expect(mockGetCertsByVertical).not.toHaveBeenCalled();
    });
  });

  describe('existing submitted application', () => {
    const application = mockApplication();

    beforeEach(() => {
      mockFindApplicationByUserId.mockResolvedValue({ id: PROFILE_ID });
      mockFindApplicationWithRelations.mockResolvedValue(application);
    });

    it('returns the application with reference data', async () => {
      const result = await loadSubmittedApplication();
      expect(result).toEqual({
        application,
        skillsByCategory: mockSkills,
        supportTypes: mockSupportTypesList,
        certificationsByCategory: mockCerts,
      });
    });

    it('passes user ID and vertical ID to findApplicationByUserId', async () => {
      await loadSubmittedApplication();
      expect(mockFindApplicationByUserId).toHaveBeenCalledWith(USER_ID, VERTICAL_ID);
    });

    it('loads relations using the profile ID from findApplicationByUserId', async () => {
      await loadSubmittedApplication();
      expect(mockFindApplicationWithRelations).toHaveBeenCalledWith(PROFILE_ID);
    });

    it('loads reference data scoped to the vertical', async () => {
      await loadSubmittedApplication();
      expect(mockGetProductsByVertical).toHaveBeenCalledWith(VERTICAL_ID);
      expect(mockGetSupportTypes).toHaveBeenCalledWith(VERTICAL_ID);
      expect(mockGetCertsByVertical).toHaveBeenCalledWith(VERTICAL_ID);
    });

    it('returns null when relations load resolves to null', async () => {
      mockFindApplicationWithRelations.mockResolvedValue(null);
      const result = await loadSubmittedApplication();
      expect(result).toBeNull();
    });
  });

  describe('error handling', () => {
    it('rethrows when getSalesforceVertical fails (for error boundary)', async () => {
      mockGetSalesforceVertical.mockRejectedValue(new Error('DB connection failed'));
      await expect(loadSubmittedApplication()).rejects.toThrow('DB connection failed');
    });

    it('rethrows when findApplicationWithRelations fails', async () => {
      mockFindApplicationByUserId.mockResolvedValue({ id: PROFILE_ID });
      mockFindApplicationWithRelations.mockRejectedValue(new Error('Query failed'));
      await expect(loadSubmittedApplication()).rejects.toThrow('Query failed');
    });
  });
});
