import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Same live-gate mock as `decline-expert-application.test.ts` — granted by default so the
 * session gate (mocked below) is what every case here actually exercises. The helper's own
 * behaviour is covered in `lib/authz/live-platform-capability.test.ts`.
 */
const mockActorHoldsLive = vi.fn<(userId: string, capability: string) => Promise<boolean>>(
  async () => true
);
vi.mock('@/lib/authz/live-platform-capability', () => ({
  actorHoldsPlatformCapability: (userId: string, capability: string) =>
    mockActorHoldsLive(userId, capability),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

const { mockEditApplicationAsStaff } = vi.hoisted(() => ({
  mockEditApplicationAsStaff: vi.fn(),
}));
vi.mock('@balo/db', () => ({
  expertsRepository: {
    editApplicationAsStaff: (...a: unknown[]) => mockEditApplicationAsStaff(...a),
  },
}));

const mockPublish = vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve());
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => mockPublish(...a),
}));

import { editExpertApplicationAction } from './edit-expert-application';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const PROFILE_ID = 'b0000000-0000-4000-8000-000000000001';
const APPLICANT_ID = 'b0000000-0000-4000-8000-000000000002';
const AUDIT_ID = 'b0000000-0000-4000-8000-000000000003';
const PRODUCT_ID = 'c0000000-0000-4000-8000-000000000001';
const SUPPORT_TYPE_ID = 'c0000000-0000-4000-8000-000000000002';
const ANOTHER_PRODUCT_ID = 'c0000000-0000-4000-8000-000000000003';
const CERT_ID = 'c0000000-0000-4000-8000-000000000004';

const ADMIN = { id: 'admin-1', firstName: 'Dana', lastName: null, platformRole: 'admin' };
const PLAIN_USER = { id: 'user-1', platformRole: 'user' };

const VALID_EDIT = {
  ratings: [{ productId: PRODUCT_ID, supportTypeId: SUPPORT_TYPE_ID, proficiency: 7 }],
};

const VALID_INPUT = { expertProfileId: PROFILE_ID, edit: VALID_EDIT };

const EDITED_RESULT = (
  overrides: Partial<{
    applicationStatus: 'submitted' | 'under_review' | 'approved';
  }> = {}
) => ({
  outcome: 'edited' as const,
  applicantUserId: APPLICANT_ID,
  applicationStatus: 'submitted' as const,
  auditEventId: AUDIT_ID,
  sections: ['ratings'] as const,
  counts: {
    ratingsAdjusted: 1,
    productsAdded: 0,
    productsRemoved: 0,
    certificationsAdded: 0,
    certificationsRemoved: 0,
  },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue(ADMIN);
  mockEditApplicationAsStaff.mockResolvedValue(EDITED_RESULT());
});

describe('editExpertApplicationAction — auth', () => {
  it('refuses a signed-out caller with code denied and never calls the repository', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const result = await editExpertApplicationAction(VALID_INPUT);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.code).toBe('denied');
    expect(mockEditApplicationAsStaff).not.toHaveBeenCalled();
  });

  it('refuses a caller without review_expert_applications', async () => {
    mockGetCurrentUser.mockResolvedValue(PLAIN_USER);
    const result = await editExpertApplicationAction(VALID_INPUT);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.code).toBe('denied');
    expect(mockEditApplicationAsStaff).not.toHaveBeenCalled();
  });
});

describe('editExpertApplicationAction — Zod refusals', () => {
  it('rejects an unknown top-level key (.strict)', async () => {
    const result = await editExpertApplicationAction({
      ...VALID_INPUT,
      // @ts-expect-error — deliberately malformed input for the strict-schema test
      hax: 1,
    });
    expect(result.success).toBe(false);
    expect(mockEditApplicationAsStaff).not.toHaveBeenCalled();
  });

  it('rejects an empty delta', async () => {
    const result = await editExpertApplicationAction({ expertProfileId: PROFILE_ID, edit: {} });
    expect(result.success).toBe(false);
    expect(mockEditApplicationAsStaff).not.toHaveBeenCalled();
  });

  it('rejects a productsRemoved id that overlaps productsAdded', async () => {
    const result = await editExpertApplicationAction({
      expertProfileId: PROFILE_ID,
      edit: {
        productsAdded: [
          { productId: PRODUCT_ID, ratings: [{ supportTypeId: SUPPORT_TYPE_ID, proficiency: 5 }] },
        ],
        productsRemoved: [PRODUCT_ID],
      },
    });
    expect(result.success).toBe(false);
    expect(mockEditApplicationAsStaff).not.toHaveBeenCalled();
  });

  it('rejects a productsRemoved id that overlaps ratings', async () => {
    const result = await editExpertApplicationAction({
      expertProfileId: PROFILE_ID,
      edit: {
        ratings: [{ productId: PRODUCT_ID, supportTypeId: SUPPORT_TYPE_ID, proficiency: 5 }],
        productsRemoved: [PRODUCT_ID],
      },
    });
    expect(result.success).toBe(false);
    expect(mockEditApplicationAsStaff).not.toHaveBeenCalled();
  });

  it('rejects overlapping certification add/remove lists', async () => {
    const result = await editExpertApplicationAction({
      expertProfileId: PROFILE_ID,
      edit: { certificationsAdded: [CERT_ID], certificationsRemoved: [CERT_ID] },
    });
    expect(result.success).toBe(false);
    expect(mockEditApplicationAsStaff).not.toHaveBeenCalled();
  });

  it('rejects a rating of 11', async () => {
    const result = await editExpertApplicationAction({
      expertProfileId: PROFILE_ID,
      edit: {
        ratings: [{ productId: PRODUCT_ID, supportTypeId: SUPPORT_TYPE_ID, proficiency: 11 }],
      },
    });
    expect(result.success).toBe(false);
    expect(mockEditApplicationAsStaff).not.toHaveBeenCalled();
  });

  it('rejects a staff-added product with an empty ratings array', async () => {
    const result = await editExpertApplicationAction({
      expertProfileId: PROFILE_ID,
      edit: { productsAdded: [{ productId: PRODUCT_ID, ratings: [] }] },
    });
    expect(result.success).toBe(false);
    expect(mockEditApplicationAsStaff).not.toHaveBeenCalled();
  });

  it('rejects an unknown key nested inside a ratings item (.strict on the item, not just the delta)', async () => {
    const result = await editExpertApplicationAction({
      expertProfileId: PROFILE_ID,
      edit: {
        ratings: [
          {
            productId: PRODUCT_ID,
            supportTypeId: SUPPORT_TYPE_ID,
            proficiency: 5,
            // @ts-expect-error — deliberately malformed input for the nested strict-schema test
            hax: 1,
          },
        ],
      },
    });
    expect(result.success).toBe(false);
    expect(mockEditApplicationAsStaff).not.toHaveBeenCalled();
  });

  it('rejects a duplicate id within the same list', async () => {
    const result = await editExpertApplicationAction({
      expertProfileId: PROFILE_ID,
      edit: { certificationsAdded: [CERT_ID, CERT_ID] },
    });
    expect(result.success).toBe(false);
    expect(mockEditApplicationAsStaff).not.toHaveBeenCalled();
  });

  it('rejects projectLeadCountMin greater than projectCountMin', async () => {
    const result = await editExpertApplicationAction({
      expertProfileId: PROFILE_ID,
      edit: { experience: { projectCountMin: 1, projectLeadCountMin: 10 } },
    });
    expect(result.success).toBe(false);
    expect(mockEditApplicationAsStaff).not.toHaveBeenCalled();
  });

  it('rejects an experience count outside the PROJECT_COUNT_RANGES vocabulary', async () => {
    const result = await editExpertApplicationAction({
      expertProfileId: PROFILE_ID,
      edit: { experience: { projectCountMin: 7 } },
    });
    expect(result.success).toBe(false);
    expect(mockEditApplicationAsStaff).not.toHaveBeenCalled();
  });

  it('accepts a valid delta with a second, distinct product in productsAdded and ratings', async () => {
    const result = await editExpertApplicationAction({
      expertProfileId: PROFILE_ID,
      edit: {
        productsAdded: [
          {
            productId: ANOTHER_PRODUCT_ID,
            ratings: [{ supportTypeId: SUPPORT_TYPE_ID, proficiency: 3 }],
          },
        ],
        ratings: [{ productId: PRODUCT_ID, supportTypeId: SUPPORT_TYPE_ID, proficiency: 5 }],
      },
    });
    expect(result.success).toBe(true);
    expect(mockEditApplicationAsStaff).toHaveBeenCalled();
  });
});

describe('editExpertApplicationAction — repository outcomes', () => {
  it('maps not_found to code gone', async () => {
    mockEditApplicationAsStaff.mockResolvedValue({ outcome: 'not_found' });
    const result = await editExpertApplicationAction(VALID_INPUT);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.code).toBe('gone');
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('maps not_editable to code not_editable', async () => {
    mockEditApplicationAsStaff.mockResolvedValue({
      outcome: 'not_editable',
      currentStatus: 'rejected',
    });
    const result = await editExpertApplicationAction(VALID_INPUT);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.code).toBe('not_editable');
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('maps invalid_experience to code invalid, and never publishes', async () => {
    mockEditApplicationAsStaff.mockResolvedValue({ outcome: 'invalid_experience' });
    const result = await editExpertApplicationAction(VALID_INPUT);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.code).toBe('invalid');
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('maps no_changes to a success with changed:false, and never publishes', async () => {
    mockEditApplicationAsStaff.mockResolvedValue({
      outcome: 'no_changes',
      applicationStatus: 'submitted',
    });
    const result = await editExpertApplicationAction(VALID_INPUT);
    expect(result).toEqual({ success: true, changed: false });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('a pending edit (submitted/under_review) never publishes, and reports analytics status pending', async () => {
    mockEditApplicationAsStaff.mockResolvedValue(EDITED_RESULT({ applicationStatus: 'submitted' }));
    const result = await editExpertApplicationAction(VALID_INPUT);
    expect(mockPublish).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      changed: true,
      live: false,
      analytics: {
        status: 'pending',
        sections: ['ratings'],
        ratings_adjusted: 1,
        products_added: 0,
        products_removed: 0,
        certifications_added: 0,
        certifications_removed: 0,
      },
    });
  });

  it('an approved edit publishes expert.application_edited exactly once with the compound id', async () => {
    mockEditApplicationAsStaff.mockResolvedValue(EDITED_RESULT({ applicationStatus: 'approved' }));
    const result = await editExpertApplicationAction(VALID_INPUT);

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [event, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe('expert.application_edited');
    expect(payload).toEqual({
      correlationId: `expert-application-edited.${PROFILE_ID}.${AUDIT_ID}`,
      userId: APPLICANT_ID,
      expertProfileId: PROFILE_ID,
      sections: ['ratings'],
    });
    expect(payload.correlationId as string).not.toContain(':');
    if (result.success && result.changed) {
      expect(result.live).toBe(true);
      expect(result.analytics.status).toBe('approved');
    } else {
      throw new Error('expected a changed, successful result');
    }
  });

  it('logs on a successful edit, naming the sections but never the raw edit payload fields', async () => {
    await editExpertApplicationAction(VALID_INPUT);
    expect(log.info).toHaveBeenCalledWith(
      'Expert application edited',
      expect.objectContaining({
        expertProfileId: PROFILE_ID,
        actorUserId: ADMIN.id,
        applicantUserId: APPLICANT_ID,
        applicationStatus: 'submitted',
        sections: ['ratings'],
        auditEventId: AUDIT_ID,
      })
    );
  });

  it('revalidates both the list and the detail path on a successful edit', async () => {
    await editExpertApplicationAction(VALID_INPUT);
    expect(revalidatePath).toHaveBeenCalledWith('/admin/applications');
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/applications/${PROFILE_ID}`);
    expect(revalidatePath).toHaveBeenCalledTimes(2);
  });

  it('a publish failure is swallowed (logged internally) and the edit still reports success', async () => {
    mockEditApplicationAsStaff.mockResolvedValue(EDITED_RESULT({ applicationStatus: 'approved' }));
    mockPublish.mockImplementationOnce(() => {
      log.error('Notification publish request failed', { event: 'expert.application_edited' });
      return Promise.reject(new Error('transport error'));
    });

    const result = await editExpertApplicationAction(VALID_INPUT);

    expect(result.success).toBe(true);
    if (result.success) expect(result.changed).toBe(true);
    expect(log.error).toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledTimes(2);
  });

  it('log.error fires and a generic failure is returned when the repository throws', async () => {
    mockEditApplicationAsStaff.mockRejectedValue(new Error('DB down'));
    const result = await editExpertApplicationAction(VALID_INPUT);
    expect(result.success).toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      'Failed to edit expert application',
      expect.objectContaining({
        expertProfileId: PROFILE_ID,
        actorUserId: ADMIN.id,
        error: 'DB down',
      })
    );
  });
});
