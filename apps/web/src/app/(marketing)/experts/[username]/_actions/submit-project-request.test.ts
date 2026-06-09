import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { z } from 'zod';
import { log } from '@/lib/logging';
import type { projectRequestInputSchema } from './schemas';

type RawInput = z.input<typeof projectRequestInputSchema>;

// ── Constants ────────────────────────────────────────────────────

const EXPERT_PROFILE_ID = 'a0000000-0000-4000-8000-000000000001';
const TAG_ID = 'b0000000-0000-4000-8000-000000000002';
const PRODUCT_ID = 'c0000000-0000-4000-8000-000000000003';
const USER_ID = 'user-1';
const COMPANY_ID = 'company-1';
const CREATED_ID = 'request-1';

// ── Mocks ────────────────────────────────────────────────────────

vi.mock('server-only', () => ({}));

const mockCreateProjectRequest = vi.fn();
const mockGetVertical = vi.fn();
const mockGetTags = vi.fn();
const mockGetProducts = vi.fn();
vi.mock('@balo/db', () => ({
  projectRequestsRepository: {
    createProjectRequest: (...args: unknown[]) => mockCreateProjectRequest(...args),
  },
  referenceDataRepository: {
    getSalesforceVertical: (...args: unknown[]) => mockGetVertical(...args),
    getProjectTagsByVertical: (...args: unknown[]) => mockGetTags(...args),
    getProductsByVertical: (...args: unknown[]) => mockGetProducts(...args),
  },
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublish(...args),
}));

// The sanitiser is exercised in its own unit test; here we mock it so we can
// assert the action wires it in (and exercise the empty-after-sanitise branch).
const mockSanitize = vi.fn();
vi.mock('@/lib/sanitize/project-html', () => ({
  sanitizeProjectHtml: (...args: unknown[]) => mockSanitize(...args),
}));

let mockSessionObj: Record<string, unknown>;
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { submitProjectRequestAction } from './submit-project-request';

// ── Helpers ──────────────────────────────────────────────────────

function directInput(overrides: Partial<RawInput> = {}): RawInput {
  return {
    sendTo: 'direct',
    expertProfileId: EXPERT_PROFILE_ID,
    title: 'Lead routing rebuild',
    description: '<p>Rebuild lead routing in Flow.</p>',
    ...overrides,
  } as RawInput;
}

function matchInput(overrides: Partial<RawInput> = {}): RawInput {
  return {
    sendTo: 'match',
    title: 'Lead routing rebuild',
    description: '<p>Rebuild lead routing in Flow.</p>',
    ...overrides,
  } as RawInput;
}

function createdRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CREATED_ID,
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    createdByUserId: USER_ID,
    sendTo: 'direct',
    status: 'requested',
    source: 'manual',
    title: 'Lead routing rebuild',
    description: '<p>Rebuild lead routing in Flow.</p>',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('submitProjectRequestAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { user: { id: USER_ID, companyId: COMPANY_ID, email: 'test@example.com' } };
    mockPublish.mockResolvedValue(undefined);
    mockSanitize.mockImplementation((html: string) => html);
    mockGetVertical.mockResolvedValue({ id: 'vert-sf', slug: 'salesforce' });
    mockGetTags.mockResolvedValue([
      {
        group: { id: 'grp', name: 'Foundational', slug: 'foundational', sortOrder: 0 },
        tags: [{ id: TAG_ID, name: 'New Implementation', slug: 'new', sortOrder: 0 }],
      },
    ]);
    mockGetProducts.mockResolvedValue([
      {
        category: { id: 'cat', name: 'AI', slug: 'ai', sortOrder: 0 },
        products: [{ id: PRODUCT_ID, name: 'Agentforce', slug: 'agentforce', sortOrder: 0 }],
      },
    ]);
    mockCreateProjectRequest.mockResolvedValue(createdRow());
  });

  describe('authentication', () => {
    it('throws when session has no user', async () => {
      mockSessionObj = {};
      await expect(submitProjectRequestAction(directInput())).rejects.toThrow('Unauthorized');
      expect(mockCreateProjectRequest).not.toHaveBeenCalled();
    });

    it('throws when session user has no id', async () => {
      mockSessionObj = { user: {} };
      await expect(submitProjectRequestAction(directInput())).rejects.toThrow('Unauthorized');
    });
  });

  describe('direct routing', () => {
    it('returns success with the created project request id', async () => {
      const result = await submitProjectRequestAction(directInput());
      expect(result).toEqual({ success: true, projectRequestId: CREATED_ID });
    });

    it('derives company/creator from the session and persists the expert profile id', async () => {
      // Simulate a client attempting to spoof ownership via extra fields. The
      // discriminated union rejects unknown keys at the type level, so cast
      // through `unknown` — the point is that the runtime action ignores them.
      const spoofed = {
        ...directInput(),
        companyId: 'spoofed-company',
        createdByUserId: 'spoofed-user',
      } as unknown as RawInput;
      await submitProjectRequestAction(spoofed);
      expect(mockCreateProjectRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            companyId: COMPANY_ID,
            createdByUserId: USER_ID,
            sendTo: 'direct',
            expertProfileId: EXPERT_PROFILE_ID,
            status: 'requested',
            source: 'manual',
          }),
        })
      );
    });

    it('persists validated tags, products, and documents', async () => {
      await submitProjectRequestAction(
        directInput({
          tagIds: [TAG_ID],
          productIds: [PRODUCT_ID],
          documents: [
            {
              r2Key: 'project-documents/c/u/d',
              fileName: 'brief.pdf',
              contentType: 'application/pdf',
              sizeBytes: 1024,
            },
          ],
        })
      );
      expect(mockCreateProjectRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          tagIds: [TAG_ID],
          productIds: [PRODUCT_ID],
          documents: [
            expect.objectContaining({ r2Key: 'project-documents/c/u/d', sizeBytes: 1024 }),
          ],
        })
      );
    });

    it('publishes project.request_submitted with the enriched payload', async () => {
      await submitProjectRequestAction(directInput({ tagIds: [TAG_ID], productIds: [PRODUCT_ID] }));
      expect(mockPublish).toHaveBeenCalledWith('project.request_submitted', {
        correlationId: CREATED_ID,
        projectRequestId: CREATED_ID,
        expertProfileId: EXPERT_PROFILE_ID,
        companyId: COMPANY_ID,
        title: 'Lead routing rebuild',
        sendTo: 'direct',
        tagIds: [TAG_ID],
        productIds: [PRODUCT_ID],
        documentCount: 0,
      });
    });
  });

  describe('match routing', () => {
    it('persists a null expertProfileId for match mode', async () => {
      mockCreateProjectRequest.mockResolvedValue(
        createdRow({ sendTo: 'match', expertProfileId: null })
      );
      await submitProjectRequestAction(matchInput());
      expect(mockCreateProjectRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({ sendTo: 'match', expertProfileId: null }),
        })
      );
    });

    it('publishes project.match_requested (no expertProfileId)', async () => {
      mockCreateProjectRequest.mockResolvedValue(
        createdRow({ sendTo: 'match', expertProfileId: null })
      );
      await submitProjectRequestAction(matchInput({ tagIds: [TAG_ID] }));
      expect(mockPublish).toHaveBeenCalledWith('project.match_requested', {
        correlationId: CREATED_ID,
        projectRequestId: CREATED_ID,
        companyId: COMPANY_ID,
        title: 'Lead routing rebuild',
        tagIds: [TAG_ID],
        productIds: [],
        documentCount: 0,
      });
      // Must NOT publish the direct event.
      expect(mockPublish).not.toHaveBeenCalledWith('project.request_submitted', expect.anything());
    });
  });

  describe('sanitisation', () => {
    it('sanitises the description before persisting and stores the safe HTML', async () => {
      mockSanitize.mockReturnValue('<p>safe</p>');
      await submitProjectRequestAction(
        directInput({ description: '<p>safe</p><script>x</script>' })
      );
      expect(mockSanitize).toHaveBeenCalledWith('<p>safe</p><script>x</script>');
      expect(mockCreateProjectRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({ description: '<p>safe</p>' }),
        })
      );
    });

    it('rejects a description that sanitises to empty', async () => {
      mockSanitize.mockReturnValue('   ');
      const result = await submitProjectRequestAction(
        directInput({ description: '<script>alert(1)</script>' })
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe('Add a few words about what you need.');
      expect(mockCreateProjectRequest).not.toHaveBeenCalled();
    });
  });

  describe('taxonomy validation', () => {
    it('rejects unknown tag ids', async () => {
      const unknown = 'd0000000-0000-4000-8000-000000000099';
      const result = await submitProjectRequestAction(directInput({ tagIds: [unknown] }));
      expect(result.success).toBe(false);
      expect(result.error).toBe('Some of your selections are no longer available.');
      expect(mockCreateProjectRequest).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        'Project request rejected — unknown taxonomy ids',
        expect.objectContaining({ unknownTagIds: [unknown] })
      );
    });

    it('rejects unknown product ids', async () => {
      const unknown = 'e0000000-0000-4000-8000-000000000098';
      const result = await submitProjectRequestAction(directInput({ productIds: [unknown] }));
      expect(result.success).toBe(false);
      expect(mockCreateProjectRequest).not.toHaveBeenCalled();
    });
  });

  describe('logging + fire-and-forget', () => {
    it('logs the business event with routing + counts', async () => {
      await submitProjectRequestAction(directInput({ tagIds: [TAG_ID] }));
      expect(log.info).toHaveBeenCalledWith(
        'Project request submitted',
        expect.objectContaining({
          projectRequestId: CREATED_ID,
          sendTo: 'direct',
          tagCount: 1,
          productCount: 0,
          documentCount: 0,
        })
      );
    });

    it('still succeeds when publishNotificationEvent rejects', async () => {
      mockPublish.mockRejectedValue(new Error('publish failed'));
      const result = await submitProjectRequestAction(directInput());
      expect(result).toEqual({ success: true, projectRequestId: CREATED_ID });
    });
  });

  describe('validation', () => {
    it('returns a generic error when the input is invalid', async () => {
      const result = await submitProjectRequestAction(directInput({ title: 'no' }));
      expect(result.success).toBe(false);
      expect(result.error).toBe('Something went wrong sending your request. Please try again.');
      expect(mockCreateProjectRequest).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('returns a generic error and logs when the repository throws', async () => {
      mockCreateProjectRequest.mockRejectedValue(new Error('DB connection failed'));
      const result = await submitProjectRequestAction(directInput());
      expect(result).toEqual({
        success: false,
        error: 'Something went wrong sending your request. Please try again.',
      });
      expect(log.error).toHaveBeenCalledWith(
        'Project request submission failed',
        expect.objectContaining({ error: 'DB connection failed' })
      );
    });
  });
});
