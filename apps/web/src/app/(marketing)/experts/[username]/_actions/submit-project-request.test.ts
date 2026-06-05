import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { z } from 'zod';
import { log } from '@/lib/logging';
import type { projectRequestInputSchema } from './schemas';

type RawInput = z.input<typeof projectRequestInputSchema>;

// ── Constants ────────────────────────────────────────────────────

const EXPERT_PROFILE_ID = 'a0000000-0000-4000-8000-000000000001';
const USER_ID = 'user-1';
const COMPANY_ID = 'company-1';
const CREATED_ID = 'request-1';

// ── Mocks ────────────────────────────────────────────────────────

vi.mock('server-only', () => ({}));

const mockCreateProjectRequest = vi.fn();
vi.mock('@balo/db', () => ({
  projectRequestsRepository: {
    createProjectRequest: (...args: unknown[]) => mockCreateProjectRequest(...args),
  },
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublish(...args),
}));

let mockSessionObj: Record<string, unknown>;
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { submitProjectRequestAction } from './submit-project-request';

// ── Helpers ──────────────────────────────────────────────────────

function validInput(overrides: Partial<RawInput> = {}): RawInput {
  return {
    expertProfileId: EXPERT_PROFILE_ID,
    title: 'Lead routing rebuild',
    description: 'Rebuild lead routing in Flow with proper assignment rules.',
    ...overrides,
  };
}

function createdRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CREATED_ID,
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    createdByUserId: USER_ID,
    status: 'submitted',
    source: 'manual',
    title: 'Lead routing rebuild',
    description: 'Rebuild lead routing in Flow with proper assignment rules.',
    focusArea: null,
    budget: null,
    timeline: null,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('submitProjectRequestAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { user: { id: USER_ID, companyId: COMPANY_ID, email: 'test@example.com' } };
    mockPublish.mockResolvedValue(undefined);
  });

  describe('authentication', () => {
    it('throws when session has no user', async () => {
      mockSessionObj = {};
      await expect(submitProjectRequestAction(validInput())).rejects.toThrow('Unauthorized');
      expect(mockCreateProjectRequest).not.toHaveBeenCalled();
    });

    it('throws when session user has no id', async () => {
      mockSessionObj = { user: {} };
      await expect(submitProjectRequestAction(validInput())).rejects.toThrow('Unauthorized');
    });
  });

  describe('successful submission', () => {
    it('returns success with the created project request id', async () => {
      mockCreateProjectRequest.mockResolvedValue(createdRow());
      const result = await submitProjectRequestAction(validInput());
      expect(result).toEqual({ success: true, projectRequestId: CREATED_ID });
    });

    it('derives companyId and createdByUserId from the session, not the client input', async () => {
      mockCreateProjectRequest.mockResolvedValue(createdRow());
      // Simulate a client attempting to spoof ownership via extra fields.
      const spoofed = {
        ...validInput(),
        companyId: 'spoofed-company',
        createdByUserId: 'spoofed-user',
      } as RawInput;
      await submitProjectRequestAction(spoofed);
      expect(mockCreateProjectRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: COMPANY_ID,
          createdByUserId: USER_ID,
          expertProfileId: EXPERT_PROFILE_ID,
          status: 'submitted',
          source: 'manual',
        })
      );
    });

    it('trims title/description and persists optional fields', async () => {
      mockCreateProjectRequest.mockResolvedValue(createdRow());
      await submitProjectRequestAction(
        validInput({
          title: '  Padded  ',
          description: '  A long enough description here  ',
          focusArea: 'Sales Cloud',
          budget: 'A$2–5k',
          timeline: 'ASAP',
        })
      );
      expect(mockCreateProjectRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Padded',
          description: 'A long enough description here',
          focusArea: 'Sales Cloud',
          budget: 'A$2–5k',
          timeline: 'ASAP',
        })
      );
    });

    it('defaults omitted optional fields to null', async () => {
      mockCreateProjectRequest.mockResolvedValue(createdRow());
      await submitProjectRequestAction(validInput());
      expect(mockCreateProjectRequest).toHaveBeenCalledWith(
        expect.objectContaining({ focusArea: null, budget: null, timeline: null })
      );
    });

    it('publishes the project.request_submitted event with correlationId === created.id', async () => {
      mockCreateProjectRequest.mockResolvedValue(createdRow());
      await submitProjectRequestAction(validInput());
      expect(mockPublish).toHaveBeenCalledWith('project.request_submitted', {
        correlationId: CREATED_ID,
        projectRequestId: CREATED_ID,
        expertProfileId: EXPERT_PROFILE_ID,
        companyId: COMPANY_ID,
        title: 'Lead routing rebuild',
      });
    });

    it('logs the business event on success', async () => {
      mockCreateProjectRequest.mockResolvedValue(createdRow());
      await submitProjectRequestAction(validInput());
      expect(log.info).toHaveBeenCalledWith(
        'Project request submitted',
        expect.objectContaining({ projectRequestId: CREATED_ID })
      );
    });
  });

  describe('fire-and-forget notification', () => {
    it('still succeeds when publishNotificationEvent rejects', async () => {
      mockCreateProjectRequest.mockResolvedValue(createdRow());
      mockPublish.mockRejectedValue(new Error('publish failed'));
      const result = await submitProjectRequestAction(validInput());
      expect(result).toEqual({ success: true, projectRequestId: CREATED_ID });
    });
  });

  describe('validation', () => {
    it('returns a generic error when the input is invalid', async () => {
      const result = await submitProjectRequestAction(validInput({ title: 'no' }));
      expect(result.success).toBe(false);
      expect(result.error).toBe('Something went wrong sending your request. Please try again.');
      expect(mockCreateProjectRequest).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('returns a generic error and logs when the repository throws', async () => {
      mockCreateProjectRequest.mockRejectedValue(new Error('DB connection failed'));
      const result = await submitProjectRequestAction(validInput());
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
