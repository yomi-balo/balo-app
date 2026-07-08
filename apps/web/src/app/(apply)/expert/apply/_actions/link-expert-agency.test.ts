import { describe, it, expect, vi, beforeEach } from 'vitest';
import { log } from '@/lib/logging';

// ── Mocks ───────────────────────────────────────────────────────
// `@/lib/logging` is globally mocked in test/setup.ts.

const { mockFindProfileById, mockRun, mockPublishNotifs, MockAgencyDomainCaptureConflictError } =
  vi.hoisted(() => {
    class MockAgencyDomainCaptureConflictError extends Error {
      constructor(
        public readonly domain: string,
        public readonly captureOutcome: string
      ) {
        super(`Agency domain capture conflict for "${domain}"`);
        this.name = 'AgencyDomainCaptureConflictError';
      }
    }
    return {
      mockFindProfileById: vi.fn(),
      mockRun: vi.fn(),
      mockPublishNotifs: vi.fn(() => Promise.resolve()),
      MockAgencyDomainCaptureConflictError,
    };
  });

vi.mock('@balo/db', () => ({
  expertsRepository: { findProfileById: mockFindProfileById },
  AgencyDomainCaptureConflictError: MockAgencyDomainCaptureConflictError,
}));

vi.mock('@/lib/expert-agency/link-expert-agency', () => ({
  runLinkExpertAgency: mockRun,
  publishAgencyResolutionNotifications: mockPublishNotifs,
}));

let mockSessionObj: Record<string, unknown> | null;
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { linkExpertAgencyAction } from './link-expert-agency';

// ── Constants ───────────────────────────────────────────────────

const USER_ID = 'user-1';
const PROFILE_ID = 'b0000000-0000-4000-8000-000000000001';
const RETRYABLE =
  "We couldn't finish setting this up just now. Nothing was changed — please try again.";

beforeEach(() => {
  vi.clearAllMocks();
  mockSessionObj = {
    user: { id: USER_ID, email: 'founder@acme.io', firstName: 'Jane', lastName: 'Doe' },
  };
  mockFindProfileById.mockResolvedValue({ id: PROFILE_ID, userId: USER_ID, agencyId: null });
});

describe('linkExpertAgencyAction', () => {
  it('rejects when the profile belongs to another user (ownership guard)', async () => {
    mockFindProfileById.mockResolvedValue({
      id: PROFILE_ID,
      userId: 'someone-else',
      agencyId: null,
    });

    const result = await linkExpertAgencyAction({ expertProfileId: PROFILE_ID });

    expect(result).toEqual({ success: false, error: 'Unauthorized' });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('rejects when the profile does not exist', async () => {
    mockFindProfileById.mockResolvedValue(undefined);

    const result = await linkExpertAgencyAction({ expertProfileId: PROFILE_ID });

    expect(result).toEqual({ success: false, error: 'Unauthorized' });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('performs the write, publishes on a fresh outcome, and logs the resolved event', async () => {
    mockRun.mockResolvedValue({ outcome: 'provision', agencyId: 'agency-new', fresh: true });

    const result = await linkExpertAgencyAction({ expertProfileId: PROFILE_ID });

    expect(result).toEqual({ success: true, outcome: 'provision', agencyId: 'agency-new' });
    expect(mockPublishNotifs).toHaveBeenCalledWith(
      { outcome: 'provision', agencyId: 'agency-new', fresh: true },
      USER_ID
    );
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      'Expert agency resolved',
      expect.objectContaining({ outcome: 'provision', agencyId: 'agency-new' })
    );
  });

  it('does NOT publish a notification on the idempotent already_linked resume', async () => {
    mockRun.mockResolvedValue({ outcome: 'already_linked', agencyId: 'agency-9', fresh: false });

    const result = await linkExpertAgencyAction({ expertProfileId: PROFILE_ID });

    expect(result).toEqual({ success: true, outcome: 'already_linked', agencyId: 'agency-9' });
    expect(mockPublishNotifs).not.toHaveBeenCalled();
  });

  it('never trusts a client-supplied kind — it passes only the session-derived inputs', async () => {
    mockRun.mockResolvedValue({ outcome: 'solo', agencyId: 'agency-solo', fresh: true });

    // The client tries to force a JOIN by smuggling a `kind`.
    const result = await linkExpertAgencyAction({
      expertProfileId: PROFILE_ID,
      kind: 'join',
    } as unknown as { expertProfileId: string });

    // The outcome is the SERVER-re-resolved one (solo), not the client's 'join'.
    expect(result).toEqual({ success: true, outcome: 'solo', agencyId: 'agency-solo' });
    // runLinkExpertAgency receives only the trusted, session-derived fields — no `kind`.
    expect(mockRun).toHaveBeenCalledWith({
      userId: USER_ID,
      email: 'founder@acme.io',
      firstName: 'Jane',
      lastName: 'Doe',
      expertProfileId: PROFILE_ID,
    });
    expect(mockRun.mock.calls[0]?.[0]).not.toHaveProperty('kind');
  });

  it('fails CLOSED with a retryable message when the write throws', async () => {
    mockRun.mockRejectedValue(new Error('boom'));

    const result = await linkExpertAgencyAction({ expertProfileId: PROFILE_ID });

    expect(result).toEqual({ success: false, error: RETRYABLE });
    expect(vi.mocked(log.error)).toHaveBeenCalled();
  });

  it('maps a lost domain-capture race to the same retryable message (self-healing on retry)', async () => {
    mockRun.mockRejectedValue(new MockAgencyDomainCaptureConflictError('acme.io', 'already_owned'));

    const result = await linkExpertAgencyAction({ expertProfileId: PROFILE_ID });

    expect(result).toEqual({ success: false, error: RETRYABLE });
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      'Expert agency link failed',
      expect.objectContaining({ isCaptureConflict: true })
    );
  });

  it('fails closed on an invalid (non-uuid) expertProfileId', async () => {
    const result = await linkExpertAgencyAction({ expertProfileId: 'not-a-uuid' });

    expect(result).toEqual({ success: false, error: RETRYABLE });
    expect(mockRun).not.toHaveBeenCalled();
  });
});
