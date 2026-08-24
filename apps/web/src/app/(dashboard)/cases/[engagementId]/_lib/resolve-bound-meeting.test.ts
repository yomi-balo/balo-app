import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Fix round 1 item 9 — the extracted B3 binding proof, shared by
 * `propose-reschedule.ts`, `respond-to-reschedule-proposal.ts` and `reschedule-consultation.ts`.
 */

vi.mock('server-only', () => ({}));

const mockFindWithContexts = vi.fn();
vi.mock('@balo/db', () => ({
  meetingsRepository: { findWithContexts: (...a: unknown[]) => mockFindWithContexts(...a) },
}));

import { log } from '@/lib/logging';
import { resolveBoundMeeting } from './resolve-bound-meeting';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000002';
const USER_ID = 'a0000000-0000-4000-8000-000000000003';

function meetingWithContexts(overrides: Record<string, unknown> = {}): unknown {
  return {
    meeting: { id: MEETING_ID },
    contexts: [{ contextType: 'case', contextId: ENGAGEMENT_ID }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveBoundMeeting', () => {
  it('resolves the meeting when a live "case" context matches engagementId', async () => {
    mockFindWithContexts.mockResolvedValue(meetingWithContexts());
    const result = await resolveBoundMeeting(MEETING_ID, ENGAGEMENT_ID, USER_ID, 'Reschedule');
    expect(result).toEqual({ ok: true, meeting: { id: MEETING_ID } });
  });

  it('refuses meeting_not_found when the meeting does not resolve at all', async () => {
    mockFindWithContexts.mockResolvedValue(undefined);
    const result = await resolveBoundMeeting(MEETING_ID, ENGAGEMENT_ID, USER_ID, 'Reschedule');
    expect(result).toEqual({
      ok: false,
      code: 'meeting_not_found',
      error: "We couldn't find that consultation.",
    });
  });

  it('B3 — refuses and logs when the live context belongs to a DIFFERENT engagementId', async () => {
    mockFindWithContexts.mockResolvedValue(
      meetingWithContexts({ contexts: [{ contextType: 'case', contextId: 'some-other-case' }] })
    );
    const result = await resolveBoundMeeting(
      MEETING_ID,
      ENGAGEMENT_ID,
      USER_ID,
      'Reschedule proposal'
    );
    expect(result).toEqual({
      ok: false,
      code: 'meeting_not_found',
      error: "We couldn't find that consultation.",
    });
    expect(log.error).toHaveBeenCalledWith(
      'Reschedule proposal meetingId does not belong to engagementId — refusing',
      expect.objectContaining({
        meetingId: MEETING_ID,
        engagementId: ENGAGEMENT_ID,
        userId: USER_ID,
      })
    );
  });

  it('refuses when the meeting has NO live "case" context at all', async () => {
    mockFindWithContexts.mockResolvedValue(meetingWithContexts({ contexts: [] }));
    const result = await resolveBoundMeeting(MEETING_ID, ENGAGEMENT_ID, USER_ID, 'Reschedule');
    expect(result.ok).toBe(false);
  });

  it('the `action` label appears verbatim in the log line', async () => {
    mockFindWithContexts.mockResolvedValue(
      meetingWithContexts({ contexts: [{ contextType: 'case', contextId: 'some-other-case' }] })
    );
    await resolveBoundMeeting(MEETING_ID, ENGAGEMENT_ID, USER_ID, 'Reschedule proposal answer');
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('Reschedule proposal answer meetingId does not belong'),
      expect.anything()
    );
  });
});
