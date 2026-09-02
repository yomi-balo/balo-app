import { beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

const { mockFindWithContexts, mockFindEngagementById } = vi.hoisted(() => ({
  mockFindWithContexts: vi.fn(),
  mockFindEngagementById: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  meetingsRepository: { findWithContexts: mockFindWithContexts },
  engagementsRepository: { findById: mockFindEngagementById },
}));

const { resolveMeetingEngagement } = await import('./resolve-meeting-engagement.js');

const MEETING_ID = '11111111-1111-4111-8111-111111111111';
const ENGAGEMENT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ENGAGEMENT_ID = '33333333-3333-4333-8333-333333333333';

function meetingWithContexts(
  contexts: readonly { contextType: string; contextId: string | null }[]
): { meeting: { id: string }; contexts: typeof contexts } {
  return { meeting: { id: MEETING_ID }, contexts };
}

describe('resolveMeetingEngagement (BAL-483 §5.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindEngagementById.mockResolvedValue({ id: ENGAGEMENT_ID });
  });

  it.each(['case', 'project_kickoff', 'package_session', 'retainer_checkin'] as const)(
    'resolves each engagement-grain label: %s',
    async (contextType) => {
      mockFindWithContexts.mockResolvedValue(
        meetingWithContexts([{ contextType, contextId: ENGAGEMENT_ID }])
      );

      const result = await resolveMeetingEngagement(MEETING_ID);

      expect(result).toEqual({ outcome: 'resolved', engagementId: ENGAGEMENT_ID, contextType });
      expect(mockFindEngagementById).toHaveBeenCalledWith(ENGAGEMENT_ID);
    }
  );

  it.each(['project_discovery', 'request_interaction'] as const)(
    'request-grain context %s ⇒ no_engagement_context, carrying that label',
    async (contextType) => {
      mockFindWithContexts.mockResolvedValue(
        meetingWithContexts([{ contextType, contextId: 'req-1' }])
      );

      const result = await resolveMeetingEngagement(MEETING_ID);

      expect(result).toEqual({ outcome: 'no_engagement_context', contextType });
      expect(mockFindEngagementById).not.toHaveBeenCalled();
    }
  );

  it('an admin-only meeting ⇒ no_engagement_context with contextType: null', async () => {
    mockFindWithContexts.mockResolvedValue(
      meetingWithContexts([{ contextType: 'admin', contextId: null }])
    );

    const result = await resolveMeetingEngagement(MEETING_ID);

    expect(result).toEqual({ outcome: 'no_engagement_context', contextType: null });
  });

  it('a context-less meeting ⇒ no_engagement_context with contextType: null', async () => {
    mockFindWithContexts.mockResolvedValue(meetingWithContexts([]));

    const result = await resolveMeetingEngagement(MEETING_ID);

    expect(result).toEqual({ outcome: 'no_engagement_context', contextType: null });
  });

  it('two distinct case contexts ⇒ ambiguous_context', async () => {
    mockFindWithContexts.mockResolvedValue(
      meetingWithContexts([
        { contextType: 'case', contextId: ENGAGEMENT_ID },
        { contextType: 'case', contextId: OTHER_ENGAGEMENT_ID },
      ])
    );

    const result = await resolveMeetingEngagement(MEETING_ID);

    expect(result).toEqual({ outcome: 'ambiguous_context' });
    expect(mockFindEngagementById).not.toHaveBeenCalled();
  });

  it('a case PLUS a project_discovery ⇒ resolved (precedence resolves it, not ambiguous)', async () => {
    mockFindWithContexts.mockResolvedValue(
      meetingWithContexts([
        { contextType: 'case', contextId: ENGAGEMENT_ID },
        { contextType: 'project_discovery', contextId: 'req-1' },
      ])
    );

    const result = await resolveMeetingEngagement(MEETING_ID);

    expect(result).toEqual({
      outcome: 'resolved',
      engagementId: ENGAGEMENT_ID,
      contextType: 'case',
    });
  });

  it('an engagement id with no live row ⇒ engagement_missing', async () => {
    mockFindWithContexts.mockResolvedValue(
      meetingWithContexts([{ contextType: 'case', contextId: ENGAGEMENT_ID }])
    );
    mockFindEngagementById.mockResolvedValue(undefined);

    const result = await resolveMeetingEngagement(MEETING_ID);

    expect(result).toEqual({ outcome: 'engagement_missing', engagementId: ENGAGEMENT_ID });
  });

  it('a missing meeting ⇒ meeting_not_found', async () => {
    mockFindWithContexts.mockResolvedValue(undefined);

    const result = await resolveMeetingEngagement(MEETING_ID);

    expect(result).toEqual({ outcome: 'meeting_not_found' });
    expect(mockFindEngagementById).not.toHaveBeenCalled();
  });

  /**
   * ⚠ THE DELIBERATE DIVERGENCE FROM `open-session.ts`: engagement STATUS is never checked. A
   * case closed minutes after the consultation is the normal ending, and refusing it would
   * silently lose the recap for the most common shape.
   */
  it('⚠ a completed/cancelled engagement still resolves — status is never checked', async () => {
    mockFindWithContexts.mockResolvedValue(
      meetingWithContexts([{ contextType: 'case', contextId: ENGAGEMENT_ID }])
    );
    mockFindEngagementById.mockResolvedValue({ id: ENGAGEMENT_ID, status: 'completed' });

    const result = await resolveMeetingEngagement(MEETING_ID);

    expect(result).toEqual({
      outcome: 'resolved',
      engagementId: ENGAGEMENT_ID,
      contextType: 'case',
    });
  });
});
