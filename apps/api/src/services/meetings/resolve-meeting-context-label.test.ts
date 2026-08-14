import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFindCaseByEngagementId, mockFindProjectRequestById } = vi.hoisted(() => ({
  mockFindCaseByEngagementId: vi.fn(),
  mockFindProjectRequestById: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  caseEngagementsRepository: { findByEngagementId: mockFindCaseByEngagementId },
  projectRequestsRepository: { findById: mockFindProjectRequestById },
}));

const { resolveMeetingContextLabel } = await import('./resolve-meeting-context-label.js');

const CASE_ID = '3a1f0c88-1111-4a1b-8c9d-0e1f2a3b4c5d';
const REQUEST_ID = '7b2e0d99-2222-4a1b-8c9d-0e1f2a3b4c5d';
const ENGAGEMENT_ID = '9c3f0e11-3333-4a1b-8c9d-0e1f2a3b4c5d';

describe('resolveMeetingContextLabel (BAL-435 / R6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindCaseByEngagementId.mockResolvedValue(undefined);
    mockFindProjectRequestById.mockResolvedValue(undefined);
  });

  it('always echoes the context type and id, which is what "Back to {context}" needs', async () => {
    const result = await resolveMeetingContextLabel({
      contextType: 'project_kickoff',
      contextId: ENGAGEMENT_ID,
    });

    expect(result.type).toBe('project_kickoff');
    expect(result.id).toBe(ENGAGEMENT_ID);
  });

  it('reads a case title from case_engagements', async () => {
    mockFindCaseByEngagementId.mockResolvedValue({ title: 'Salesforce CPQ consultation' });

    const result = await resolveMeetingContextLabel({ contextType: 'case', contextId: CASE_ID });

    expect(mockFindCaseByEngagementId).toHaveBeenCalledWith(CASE_ID);
    expect(result.title).toBe('Salesforce CPQ consultation');
  });

  it('reads a project-request title for BOTH request-grain context types', async () => {
    mockFindProjectRequestById.mockResolvedValue({ title: 'Migrate to Flow' });

    const discovery = await resolveMeetingContextLabel({
      contextType: 'project_discovery',
      contextId: REQUEST_ID,
    });
    const interaction = await resolveMeetingContextLabel({
      contextType: 'request_interaction',
      contextId: REQUEST_ID,
    });

    expect(discovery.title).toBe('Migrate to Flow');
    expect(interaction.title).toBe('Migrate to Flow');
  });

  it('⚠ answers null for the three delivery contexts — no title column exists for them', async () => {
    const types = ['project_kickoff', 'package_session', 'retainer_checkin'] as const;

    for (const contextType of types) {
      const result = await resolveMeetingContextLabel({ contextType, contextId: ENGAGEMENT_ID });
      expect(result.title).toBeNull();
    }
    // ⚠ AND IT READS NOTHING AT ALL for them — a lookup that cannot answer must not cost a query.
    expect(mockFindCaseByEngagementId).not.toHaveBeenCalled();
    expect(mockFindProjectRequestById).not.toHaveBeenCalled();
  });

  it('normalises a missing or whitespace-only title to null, never to an empty heading', async () => {
    mockFindCaseByEngagementId.mockResolvedValue({ title: '   ' });
    expect(
      (await resolveMeetingContextLabel({ contextType: 'case', contextId: CASE_ID })).title
    ).toBeNull();

    mockFindCaseByEngagementId.mockResolvedValue(undefined);
    expect(
      (await resolveMeetingContextLabel({ contextType: 'case', contextId: CASE_ID })).title
    ).toBeNull();
  });

  it('⚠ NEVER throws — a repository failure degrades the label, it does not refuse the join', async () => {
    mockFindCaseByEngagementId.mockRejectedValue(new Error('connection reset'));

    const result = await resolveMeetingContextLabel({ contextType: 'case', contextId: CASE_ID });

    expect(result).toEqual({ type: 'case', id: CASE_ID, title: null });
  });
});
