import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireUser(),
}));

const mockCore = vi.fn();
vi.mock('./_shared/proposal-draft-generation', () => ({
  runStartProposalDraft: (...a: unknown[]) => mockCore(...a),
}));

import { startProposalDraftAction } from './start-proposal-draft';

const USER = { id: 'user-expert' };
const INPUT = {
  requestId: 'a0000000-0000-4000-8000-000000000001',
  relationshipId: 'b0000000-0000-4000-8000-000000000002',
  generationId: 'c0000000-0000-4000-8000-000000000003',
};

describe('startProposalDraftAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
    mockCore.mockResolvedValue({ status: 'pending', generationId: INPUT.generationId });
  });

  it("answers 'skipped' without running the core when the caller is not signed in", async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    expect(await startProposalDraftAction(INPUT)).toEqual({ status: 'skipped' });
    expect(mockCore).not.toHaveBeenCalled();
  });

  it('delegates to the core with the signed-in user and the input', async () => {
    const result = await startProposalDraftAction(INPUT);
    expect(mockCore).toHaveBeenCalledWith(USER, INPUT);
    expect(result).toEqual({ status: 'pending', generationId: INPUT.generationId });
  });
});
