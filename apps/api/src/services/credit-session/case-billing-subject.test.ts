import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFindWithContexts, mockFindClosureSubject } = vi.hoisted(() => ({
  mockFindWithContexts: vi.fn(),
  mockFindClosureSubject: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  meetingsRepository: { findWithContexts: mockFindWithContexts },
  caseEngagementsRepository: { findClosureSubject: mockFindClosureSubject },
}));

import { resolveCaseBillingSubject } from './case-billing-subject.js';

const MEETING_ID = 'meeting-1';

function meetingWith(contexts: Array<{ contextType: string; contextId: string | null }>) {
  return { meeting: { id: MEETING_ID }, contexts };
}

/**
 * BAL-129 (D5) / BAL-474 (D5.6, D17.5) — `resolveCaseBillingSubject`'s OWN job, post-D17.5, is
 * narrowed to resolving the meeting's single `case` context and reassembling `engagementId` onto
 * whatever `caseEngagementsRepository.findClosureSubject` answers. Everything downstream of the
 * contextId — missing/non-case engagements, active vs. closed, `requireActive`'s short-circuit,
 * the close instant and closer — is now `findClosureSubject`'s own contract, covered by
 * `case-engagements.integration.test.ts` against a real Postgres row.
 */
describe('resolveCaseBillingSubject (BAL-129 D5 / BAL-474 D5.6 / D17.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindWithContexts.mockResolvedValue(
      meetingWith([{ contextType: 'case', contextId: 'engagement-1' }])
    );
    mockFindClosureSubject.mockResolvedValue({
      companyId: 'company-1',
      expertProfileId: 'expert-1',
      isActive: true,
      closedAt: null,
      closedByUserId: null,
    });
  });

  it('delegates the resolved contextId and `requireActive` verbatim, and reassembles `engagementId` onto the answer', async () => {
    await expect(resolveCaseBillingSubject(MEETING_ID, { requireActive: true })).resolves.toEqual({
      engagementId: 'engagement-1',
      companyId: 'company-1',
      expertProfileId: 'expert-1',
      isActive: true,
      closedAt: null,
      closedByUserId: null,
    });
    expect(mockFindClosureSubject).toHaveBeenCalledWith('engagement-1', { requireActive: true });
  });

  it('a missing (or soft-deleted) meeting resolves nothing, and never reads a closure subject', async () => {
    mockFindWithContexts.mockResolvedValue(undefined);
    await expect(
      resolveCaseBillingSubject(MEETING_ID, { requireActive: false })
    ).resolves.toBeUndefined();
    expect(mockFindClosureSubject).not.toHaveBeenCalled();
  });

  it.each([
    ['zero case contexts', [{ contextType: 'project_discovery', contextId: 'req-1' }]],
    [
      'more than one case context',
      [
        { contextType: 'case', contextId: 'engagement-1' },
        { contextType: 'case', contextId: 'engagement-2' },
      ],
    ],
    ['a case context with no id', [{ contextType: 'case', contextId: null }]],
  ])(
    '%s resolves nothing — never a guess at which engagement to bill',
    async (_label, contexts) => {
      mockFindWithContexts.mockResolvedValue(meetingWith(contexts));
      await expect(
        resolveCaseBillingSubject(MEETING_ID, { requireActive: false })
      ).resolves.toBeUndefined();
      expect(mockFindClosureSubject).not.toHaveBeenCalled();
    }
  );

  it('an `undefined` closure subject (missing engagement, not a case, or `requireActive` refused it) resolves nothing', async () => {
    mockFindClosureSubject.mockResolvedValue(undefined);
    await expect(
      resolveCaseBillingSubject(MEETING_ID, { requireActive: false })
    ).resolves.toBeUndefined();
  });

  it('a non-active closure subject (D5.6 coherence-only path) is reassembled the same way', async () => {
    const closedAt = new Date('2026-09-24T09:00:00.000Z');
    mockFindClosureSubject.mockResolvedValue({
      companyId: 'company-1',
      expertProfileId: 'expert-1',
      isActive: false,
      closedAt,
      closedByUserId: 'closer-1',
    });
    await expect(resolveCaseBillingSubject(MEETING_ID, { requireActive: false })).resolves.toEqual({
      engagementId: 'engagement-1',
      companyId: 'company-1',
      expertProfileId: 'expert-1',
      isActive: false,
      closedAt,
      closedByUserId: 'closer-1',
    });
  });
});
