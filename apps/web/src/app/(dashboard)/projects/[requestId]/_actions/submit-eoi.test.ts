import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const RELATIONSHIP_ID = 'b0000000-0000-4000-8000-000000000002';
const EXPERT_PROFILE_ID = 'c0000000-0000-4000-8000-000000000003';
const EOI_ID = 'd0000000-0000-4000-8000-000000000004';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockFindByIdWithRelations = vi.fn();
const mockFindById = vi.fn();
const mockSubmit = vi.fn();
const mockResubmit = vi.fn();
vi.mock('@balo/db', () => ({
  projectRequestsRepository: {
    findByIdWithRelations: (...args: unknown[]) => mockFindByIdWithRelations(...args),
    // BAL-295: the request rollup is derived inside submit()/resubmit(); the action
    // re-reads the stored status via findById to source the `transitioned` flag.
    findById: (...args: unknown[]) => mockFindById(...args),
  },
  expressionsOfInterestRepository: {
    submit: (...args: unknown[]) => mockSubmit(...args),
    resubmit: (...args: unknown[]) => mockResubmit(...args),
  },
}));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireUser: () => mockRequireUser(),
}));

// Pass-through sanitiser (the real one is server-only). The action treats an empty
// post-sanitize result as a rejection, which we exercise via `isDescriptionEmpty`.
vi.mock('@/lib/sanitize/project-html', () => ({
  sanitizeProjectHtml: (html: string) => html,
}));

const mockIsDescriptionEmpty = vi.fn();
vi.mock('@/components/balo/rich-text-editor', () => ({
  isDescriptionEmpty: (html: string) => mockIsDescriptionEmpty(html),
}));

const mockPublish = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublish(...args),
}));

import { submitEoiAction } from './submit-eoi';
import { revalidatePath } from 'next/cache';

interface RequestGraphOptions {
  requestStatus?: string;
  relationshipStatus?: string;
  hasLiveEoi?: boolean;
  relationshipExpertProfileId?: string;
}

/** Build a hydrated request graph the real `resolveRequestLens` resolves to the expert lens. */
function requestGraph(opts: RequestGraphOptions = {}): Record<string, unknown> {
  const {
    requestStatus = 'experts_invited',
    relationshipStatus = 'invited',
    hasLiveEoi = false,
    relationshipExpertProfileId = EXPERT_PROFILE_ID,
  } = opts;
  return {
    id: REQUEST_ID,
    companyId: 'company-1',
    createdByUserId: 'user-client',
    status: requestStatus,
    title: 'CPQ implementation',
    relationships: [
      {
        id: RELATIONSHIP_ID,
        expertProfileId: relationshipExpertProfileId,
        status: relationshipStatus,
        invitedAt: new Date(Date.now() - 60_000),
        expertProfile: {
          id: relationshipExpertProfileId,
          user: { id: 'user-expert', firstName: 'Priya', lastName: 'Nair' },
        },
        expressionsOfInterest: hasLiveEoi
          ? [{ id: EOI_ID, submittedAt: new Date(), message: '<p>existing</p>' }]
          : [],
      },
    ],
  };
}

const EXPERT_USER = {
  id: 'user-expert',
  companyId: 'company-expert',
  platformRole: 'user',
  expertProfileId: EXPERT_PROFILE_ID,
};

const VALID_INPUT = { requestId: REQUEST_ID, message: '<p>I have led 5 CPQ migrations.</p>' };

describe('submitEoiAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(EXPERT_USER);
    mockIsDescriptionEmpty.mockReturnValue(false);
    mockFindByIdWithRelations.mockResolvedValue(requestGraph());
    mockSubmit.mockResolvedValue({ id: EOI_ID });
    mockResubmit.mockResolvedValue({ id: EOI_ID });
    // Default re-read: the rollup advanced experts_invited → eoi_submitted (the
    // hydrated graph's pre-op floor is `experts_invited`), so `transitioned` is true.
    mockFindById.mockResolvedValue({ id: REQUEST_ID, status: 'eoi_submitted' });
  });

  it('rejects an unauthenticated caller', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    const result = await submitEoiAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('rejects an invalid requestId / message', async () => {
    expect((await submitEoiAction({ requestId: 'nope', message: 'x' })).success).toBe(false);
    expect(mockFindByIdWithRelations).not.toHaveBeenCalled();
  });

  it('rejects a post-sanitize-empty (all-markup) message', async () => {
    mockIsDescriptionEmpty.mockReturnValue(true);
    const result = await submitEoiAction(VALID_INPUT);
    expect(result.success).toBe(false);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('rejects when the request no longer exists', async () => {
    mockFindByIdWithRelations.mockResolvedValue(undefined);
    const result = await submitEoiAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'This request no longer exists.' });
  });

  it('rejects a caller who is not an invited expert (different expertProfileId → lens null)', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      requestGraph({ relationshipExpertProfileId: 'someone-else' })
    );
    const result = await submitEoiAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'You are not an invited expert on this request.',
    });
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('rejects a client caller (owns the request → client lens, not expert)', async () => {
    mockRequireUser.mockResolvedValue({
      id: 'user-client',
      companyId: 'company-1',
      platformRole: 'user',
    });
    const result = await submitEoiAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'You are not an invited expert on this request.',
    });
  });

  it('never trusts a client-supplied relationshipId — derives it from the lens', async () => {
    // Even if a caller smuggled a bogus relationshipId, the action ignores it; the
    // submit call uses the SERVER-derived id from the loaded graph.
    await submitEoiAction({ ...VALID_INPUT, relationshipId: 'evil-id' } as never);
    expect(mockSubmit).toHaveBeenCalledWith({
      relationshipId: RELATIONSHIP_ID,
      message: VALID_INPUT.message,
    });
  });

  it('first EOI (relationship invited): calls submit(); the rollup-derived status re-read yields transitioned:true', async () => {
    const result = await submitEoiAction(VALID_INPUT);
    expect(mockSubmit).toHaveBeenCalledWith({
      relationshipId: RELATIONSHIP_ID,
      message: VALID_INPUT.message,
    });
    // BAL-295: the action no longer issues a request transition — submit() derives
    // it. It re-reads the stored status via findById to source `transitioned`.
    expect(mockFindById).toHaveBeenCalledWith(REQUEST_ID);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.transitioned).toBe(true);
      expect(result.relationshipId).toBe(RELATIONSHIP_ID);
      expect(result.expertProfileId).toBe(EXPERT_PROFILE_ID);
      expect(result.timeToEoiMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('second expert (request already eoi_submitted): submit(), re-read shows no advance → transitioned:false', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      requestGraph({ requestStatus: 'eoi_submitted', relationshipStatus: 'invited' })
    );
    // The request was already eoi_submitted (the pre-op floor) → re-read unchanged.
    mockFindById.mockResolvedValue({ id: REQUEST_ID, status: 'eoi_submitted' });
    const result = await submitEoiAction(VALID_INPUT);
    expect(mockSubmit).toHaveBeenCalled();
    expect(result.success && result.transitioned).toBe(false);
  });

  it('resubmit path (relationship eoi_submitted, no live EOI): calls resubmit(), transitioned:false', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      requestGraph({
        requestStatus: 'eoi_submitted',
        relationshipStatus: 'eoi_submitted',
        hasLiveEoi: false,
      })
    );
    // Resubmit does not move the relationship, so the request rollup is unchanged.
    mockFindById.mockResolvedValue({ id: REQUEST_ID, status: 'eoi_submitted' });
    const result = await submitEoiAction(VALID_INPUT);
    expect(mockResubmit).toHaveBeenCalledWith({
      relationshipId: RELATIONSHIP_ID,
      message: VALID_INPUT.message,
    });
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(result.success && result.transitioned).toBe(false);
  });

  it('already has a live EOI → friendly pre-check error', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      requestGraph({
        requestStatus: 'eoi_submitted',
        relationshipStatus: 'eoi_submitted',
        hasLiveEoi: true,
      })
    );
    const result = await submitEoiAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'You already have an active EOI. Withdraw it first to resubmit.',
    });
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockResubmit).not.toHaveBeenCalled();
  });

  it('publishes project.eoi_submitted to the client with correlationId = eoi.id', async () => {
    await submitEoiAction(VALID_INPUT);
    expect(mockPublish).toHaveBeenCalledWith('project.eoi_submitted', {
      correlationId: EOI_ID,
      recipientId: 'user-client',
      projectRequestId: REQUEST_ID,
      title: 'CPQ implementation',
      expertName: 'Priya Nair',
    });
  });

  it('re-read snapshot race (request advanced further by another expert) → still success; transitioned reflects the stored column', async () => {
    // The re-read can land AFTER a concurrent expert advanced the request further;
    // the action reports the committed status truthfully (it still differs from the
    // pre-op floor → transitioned:true) and never errors.
    mockFindById.mockResolvedValue({ id: REQUEST_ID, status: 'proposal_requested' });
    const result = await submitEoiAction(VALID_INPUT);
    expect(result.success).toBe(true);
    if (result.success) expect(result.transitioned).toBe(true);
    // The EOI persisted, so we still notify + revalidate.
    expect(mockPublish).toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
  });

  it('revalidates the request path on success', async () => {
    await submitEoiAction(VALID_INPUT);
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
  });

  it('returns a generic error on an unexpected failure', async () => {
    mockSubmit.mockRejectedValue(new Error('DB down'));
    const result = await submitEoiAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'Could not submit your interest. Please try again.',
    });
  });

  it('concurrent double-submit (partial-unique 23505 race) → friendly active-EOI copy', async () => {
    // A genuinely concurrent submit passes the in-tx live-EOI guard, then trips the
    // live-EOI partial unique index; postgres-js surfaces `.code === '23505'`.
    mockSubmit.mockRejectedValue(
      Object.assign(new Error('duplicate key value'), { code: '23505' })
    );
    const result = await submitEoiAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'You already have an active EOI. Withdraw it first to resubmit.',
    });
  });
});
