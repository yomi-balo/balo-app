import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFindCaseByEngagementId, mockFindProjectRequestById, mockFindRelationshipById } =
  vi.hoisted(() => ({
    mockFindCaseByEngagementId: vi.fn(),
    mockFindProjectRequestById: vi.fn(),
    mockFindRelationshipById: vi.fn(),
  }));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  caseEngagementsRepository: { findByEngagementId: mockFindCaseByEngagementId },
  projectRequestsRepository: { findById: mockFindProjectRequestById },
  requestExpertRelationshipsRepository: { findById: mockFindRelationshipById },
}));

const { resolveMeetingContextLabel } = await import('./resolve-meeting-context-label.js');

const CASE_ID = '3a1f0c88-1111-4a1b-8c9d-0e1f2a3b4c5d';
const REQUEST_ID = '7b2e0d99-2222-4a1b-8c9d-0e1f2a3b4c5d';
const ENGAGEMENT_ID = '9c3f0e11-3333-4a1b-8c9d-0e1f2a3b4c5d';
/** ⚠ A `request_expert_relationships.id`, DELIBERATELY DIFFERENT FROM {@link REQUEST_ID}. */
const RELATIONSHIP_ID = '1d4a0f22-4444-4a1b-8c9d-0e1f2a3b4c5d';

describe('resolveMeetingContextLabel (BAL-435 / R6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindCaseByEngagementId.mockResolvedValue(undefined);
    mockFindProjectRequestById.mockResolvedValue(undefined);
    mockFindRelationshipById.mockResolvedValue(undefined);
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
    // ⚠ BAL-567 — a case carries NO request. `null` here is the answer, not a missing value.
    expect(result.projectRequestId).toBeNull();
  });

  it('project_discovery: contextId IS the request id, so it is read directly', async () => {
    mockFindProjectRequestById.mockResolvedValue({ title: 'Migrate to Flow' });

    const result = await resolveMeetingContextLabel({
      contextType: 'project_discovery',
      contextId: REQUEST_ID,
    });

    expect(mockFindProjectRequestById).toHaveBeenCalledWith(REQUEST_ID);
    expect(mockFindRelationshipById).not.toHaveBeenCalled();
    expect(result.title).toBe('Migrate to Flow');
    expect(result.projectRequestId).toBe(REQUEST_ID);
  });

  /**
   * BAL-567 / D1 — THE WRONG-ID BUG THIS ARM CARRIED, PINNED.
   *
   * `request_interaction`'s `contextId` is a `request_expert_relationships.id`. Until BAL-567 it
   * shared an arm with `project_discovery` and was passed straight to
   * `projectRequestsRepository.findById`, which therefore matched nothing — so the in-call
   * heading was silently `null` for EVERY `request_interaction` meeting. No error, no log; it
   * simply read as "this kind has no title".
   *
   * ⚠ THE `toHaveBeenCalledWith(REQUEST_ID)` ASSERTION IS THE LOAD-BEARING ONE. A title
   * assertion alone passes against the buggy version as soon as the `findById` mock answers
   * unconditionally — which is exactly what the previous fixture did. Asserting WHICH id was
   * looked up is what distinguishes the two implementations.
   */
  it('BAL-567 — request_interaction hops relationship → request before reading the title', async () => {
    mockFindRelationshipById.mockResolvedValue({ projectRequestId: REQUEST_ID });
    mockFindProjectRequestById.mockResolvedValue({ title: 'Migrate to Flow' });

    const result = await resolveMeetingContextLabel({
      contextType: 'request_interaction',
      contextId: RELATIONSHIP_ID,
    });

    expect(mockFindRelationshipById).toHaveBeenCalledWith(RELATIONSHIP_ID);
    expect(mockFindProjectRequestById).toHaveBeenCalledWith(REQUEST_ID);
    expect(mockFindProjectRequestById).not.toHaveBeenCalledWith(RELATIONSHIP_ID);
    expect(result.title).toBe('Migrate to Flow');
    expect(result.projectRequestId).toBe(REQUEST_ID);
  });

  it('BAL-567 — a request_interaction whose relationship is gone yields no title and no target', async () => {
    mockFindRelationshipById.mockResolvedValue(undefined);

    const result = await resolveMeetingContextLabel({
      contextType: 'request_interaction',
      contextId: RELATIONSHIP_ID,
    });

    expect(result.title).toBeNull();
    expect(result.projectRequestId).toBeNull();
    // ⚠ FAIL-CLOSED: no request row resolved ⇒ no link target reported. `back-to-context.ts`
    // turns that into the dashboard fallback rather than `/projects/{relationshipId}`.
    expect(mockFindProjectRequestById).not.toHaveBeenCalled();
  });

  it('BAL-567 — a request that resolved to nothing reports no target either', async () => {
    mockFindProjectRequestById.mockResolvedValue(undefined);

    const result = await resolveMeetingContextLabel({
      contextType: 'project_discovery',
      contextId: REQUEST_ID,
    });

    expect(result.title).toBeNull();
    expect(result.projectRequestId).toBeNull();
  });

  it('⚠ answers null for the three delivery contexts — no title column exists for them', async () => {
    const types = ['project_kickoff', 'package_session', 'retainer_checkin'] as const;

    expect(types).toHaveLength(3);
    for (const contextType of types) {
      const result = await resolveMeetingContextLabel({ contextType, contextId: ENGAGEMENT_ID });
      expect(result.title).toBeNull();
      expect(result.projectRequestId).toBeNull();
    }
    // ⚠ AND IT READS NOTHING AT ALL for them — a lookup that cannot answer must not cost a query.
    expect(mockFindCaseByEngagementId).not.toHaveBeenCalled();
    expect(mockFindProjectRequestById).not.toHaveBeenCalled();
    expect(mockFindRelationshipById).not.toHaveBeenCalled();
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

    expect(result).toEqual({ type: 'case', id: CASE_ID, title: null, projectRequestId: null });
  });

  it('BAL-567 — a failed relationship hop degrades BOTH facts, it does not guess a target', async () => {
    mockFindRelationshipById.mockRejectedValue(new Error('connection reset'));

    const result = await resolveMeetingContextLabel({
      contextType: 'request_interaction',
      contextId: RELATIONSHIP_ID,
    });

    expect(result).toEqual({
      type: 'request_interaction',
      id: RELATIONSHIP_ID,
      title: null,
      projectRequestId: null,
    });
  });
});
