import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * BAL-541 §7.2 — the "Balo" panel's server loader. `@balo/db` is mocked (pure I/O boundary).
 *
 * `hasPlatformCapability` is ALSO mocked here, deliberately: every platform role that holds
 * `MANAGE_INTERNAL_NOTES` or `ASSIGN_ANY_REQUEST_OWNER` today holds BOTH (D1 puts them in the
 * same staff bundle), so there is no real `platformRole` that isolates one token from the
 * other. Mocking the capability resolver — rather than `platformRole` — lets each of the
 * three-boolean combinations the plan calls for (§13.1: "canWriteNotes:false when only
 * ASSIGN_ANY_REQUEST_OWNER") be exercised directly, independent of how the bundle happens to
 * be composed today. `resolve-request-lens.test.ts` and `platform.test.ts` already pin the
 * REAL bundle composition; this file is about `loadBaloPanel`'s branching on the three
 * booleans, not about re-proving the bundle.
 */

const mockHasPlatformCapability = vi.fn();
vi.mock('@/lib/authz/platform', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/authz/platform')>('@/lib/authz/platform');
  return {
    ...actual,
    hasPlatformCapability: (...args: unknown[]) => mockHasPlatformCapability(...args),
  };
});

const mockListForEntity = vi.fn();
const mockListPlatformStaff = vi.fn();
const mockFindNamesByIds = vi.fn();

vi.mock('@balo/db', () => ({
  internalNotesRepository: {
    listForEntity: (...args: unknown[]) => mockListForEntity(...args),
  },
  usersRepository: {
    listPlatformStaff: (...args: unknown[]) => mockListPlatformStaff(...args),
    findNamesByIds: (...args: unknown[]) => mockFindNamesByIds(...args),
  },
}));

import type { SessionUser } from '@/lib/auth/session';
import type { ProjectRequestWithRelations } from '@balo/db';
import { PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { loadBaloPanel } from './load-balo-panel';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const OWNER_ID = 'b0000000-0000-4000-8000-000000000002';
const AUTHOR_ID = 'c0000000-0000-4000-8000-000000000003';
const OTHER_STAFF_ID = 'd0000000-0000-4000-8000-000000000004';

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: AUTHOR_ID,
    email: 'staff@balo.test',
    firstName: 'Adeeb',
    lastName: 'Khan',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'admin',
    companyId: 'company-1',
    companyName: 'Balo',
    companyRole: 'owner',
    ...overrides,
  };
}

function request(
  overrides: Partial<ProjectRequestWithRelations> = {}
): ProjectRequestWithRelations {
  return {
    id: REQUEST_ID,
    baloOwnerUserId: null,
    ...overrides,
  } as ProjectRequestWithRelations;
}

/** Drive `hasPlatformCapability` for exactly the three BAL-541 tokens the loader resolves. */
function grant(
  tokens: Partial<{
    assignOwner: boolean;
    manageNotes: boolean;
    deleteAny: boolean;
  }> = {}
): void {
  const { assignOwner = false, manageNotes = false, deleteAny = false } = tokens;
  mockHasPlatformCapability.mockImplementation((_user: unknown, capability: string) => {
    if (capability === PLATFORM_CAPABILITIES.ASSIGN_ANY_REQUEST_OWNER) return assignOwner;
    if (capability === PLATFORM_CAPABILITIES.MANAGE_INTERNAL_NOTES) return manageNotes;
    if (capability === PLATFORM_CAPABILITIES.DELETE_ANY_INTERNAL_NOTE) return deleteAny;
    return false;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListForEntity.mockResolvedValue([]);
  mockListPlatformStaff.mockResolvedValue([]);
  mockFindNamesByIds.mockResolvedValue([]);
  grant();
});

describe('loadBaloPanel', () => {
  it('returns null for a viewer holding neither BAL-541 token', async () => {
    grant({ assignOwner: false, manageNotes: false });
    const view = await loadBaloPanel(user(), request());
    expect(view).toBeNull();
    expect(mockListForEntity).not.toHaveBeenCalled();
    expect(mockListPlatformStaff).not.toHaveBeenCalled();
  });

  it('reports notes:[] and canWriteNotes:false, and never reads notes, for a viewer holding only ASSIGN_ANY_REQUEST_OWNER', async () => {
    grant({ assignOwner: true, manageNotes: false });
    mockListPlatformStaff.mockResolvedValue([
      {
        id: OTHER_STAFF_ID,
        firstName: 'Priya',
        lastName: 'Nair',
        email: 'p@balo.test',
        platformRole: 'admin',
      },
    ]);

    const view = await loadBaloPanel(user(), request());

    expect(view).not.toBeNull();
    expect(view?.canAssignOwner).toBe(true);
    expect(view?.canWriteNotes).toBe(false);
    expect(view?.notes).toEqual([]);
    expect(view?.staff).toEqual([{ userId: OTHER_STAFF_ID, name: 'Priya Nair' }]);
    expect(mockListForEntity).not.toHaveBeenCalled();
  });

  it('staff is [] and no roster is fetched for a viewer holding only MANAGE_INTERNAL_NOTES', async () => {
    grant({ assignOwner: false, manageNotes: true });
    const view = await loadBaloPanel(user(), request());
    expect(view?.canAssignOwner).toBe(false);
    expect(view?.staff).toEqual([]);
    expect(mockListPlatformStaff).not.toHaveBeenCalled();
  });

  it('resolves owner, staff, and notes when both tokens are held', async () => {
    grant({ assignOwner: true, manageNotes: true });
    mockListPlatformStaff.mockResolvedValue([
      {
        id: OTHER_STAFF_ID,
        firstName: 'Priya',
        lastName: 'Nair',
        email: 'p@balo.test',
        platformRole: 'admin',
      },
    ]);
    mockFindNamesByIds.mockResolvedValue([{ id: OWNER_ID, firstName: 'Dana', lastName: 'Ho' }]);
    mockListForEntity.mockResolvedValue([
      {
        id: 'note-1',
        entityType: 'project_request',
        entityId: REQUEST_ID,
        body: 'Handover: waiting on the client.',
        authorUserId: AUTHOR_ID,
        authorFirstName: 'Adeeb',
        authorLastName: 'Khan',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);

    const view = await loadBaloPanel(user(), request({ baloOwnerUserId: OWNER_ID }));

    expect(view).not.toBeNull();
    expect(view?.canAssignOwner).toBe(true);
    expect(view?.canWriteNotes).toBe(true);
    expect(view?.canDeleteAnyNote).toBe(false);
    expect(view?.owner).toEqual({ userId: OWNER_ID, name: 'Dana Ho' });
    expect(view?.staff).toEqual([{ userId: OTHER_STAFF_ID, name: 'Priya Nair' }]);
    expect(view?.notes).toHaveLength(1);
    expect(view?.notes[0]).toMatchObject({
      id: 'note-1',
      authorName: 'Adeeb Khan',
      authorInitials: 'AK',
      body: 'Handover: waiting on the client.',
      createdAtIso: '2026-01-01T00:00:00.000Z',
      canDelete: true, // author === viewer
    });
    expect(mockFindNamesByIds).toHaveBeenCalledWith([OWNER_ID]);
  });

  it('canDelete is false for a non-author without DELETE_ANY_INTERNAL_NOTE, true for a super_admin holder on any note', async () => {
    mockListForEntity.mockResolvedValue([
      {
        id: 'note-1',
        entityType: 'project_request',
        entityId: REQUEST_ID,
        body: 'Someone else wrote this.',
        authorUserId: OTHER_STAFF_ID,
        authorFirstName: 'Priya',
        authorLastName: 'Nair',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);

    grant({ assignOwner: true, manageNotes: true, deleteAny: false });
    const nonAuthorView = await loadBaloPanel(user(), request());
    expect(nonAuthorView?.notes[0]?.canDelete).toBe(false);

    grant({ assignOwner: true, manageNotes: true, deleteAny: true });
    const superAdminView = await loadBaloPanel(user(), request());
    expect(superAdminView?.canDeleteAnyNote).toBe(true);
    expect(superAdminView?.notes[0]?.canDelete).toBe(true);
  });

  it('does not call findNamesByIds with an id when there is no owner (empty-input short-circuit)', async () => {
    grant({ assignOwner: true, manageNotes: true });
    await loadBaloPanel(user(), request({ baloOwnerUserId: null }));
    expect(mockFindNamesByIds).toHaveBeenCalledWith([]);
  });

  it('a demoted past owner still renders — no role re-filter (D7)', async () => {
    grant({ assignOwner: true, manageNotes: true });
    // The owner name-hydration path (`findNamesByIds`) carries no role column at all, so a
    // demoted user's past ownership renders identically to a current staffer's.
    mockFindNamesByIds.mockResolvedValue([
      { id: OWNER_ID, firstName: 'Demoted', lastName: 'Owner' },
    ]);
    const view = await loadBaloPanel(user(), request({ baloOwnerUserId: OWNER_ID }));
    expect(view?.owner).toEqual({ userId: OWNER_ID, name: 'Demoted Owner' });
  });

  it("a soft-deleted owner resolves to 'A team member' rather than a blank picker", async () => {
    grant({ assignOwner: true, manageNotes: true });
    mockFindNamesByIds.mockResolvedValue([]); // findNamesByIds filters deleted_at IS NULL
    const view = await loadBaloPanel(user(), request({ baloOwnerUserId: OWNER_ID }));
    expect(view?.owner).toEqual({ userId: OWNER_ID, name: 'A team member' });
  });

  it("a soft-deleted note author renders as 'A team member'", async () => {
    grant({ assignOwner: true, manageNotes: true, deleteAny: true });
    mockListForEntity.mockResolvedValue([
      {
        id: 'note-1',
        entityType: 'project_request',
        entityId: REQUEST_ID,
        body: 'Left behind by someone no longer here.',
        authorUserId: 'deleted-author',
        authorFirstName: null,
        authorLastName: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
    const view = await loadBaloPanel(user(), request());
    expect(view?.notes[0]?.authorName).toBe('A team member');
    expect(view?.notes[0]?.authorInitials).toBe('AT');
  });

  it('serializes createdAt to an ISO string', async () => {
    grant({ assignOwner: true, manageNotes: true });
    const createdAt = new Date('2026-03-15T09:30:00.000Z');
    mockListForEntity.mockResolvedValue([
      {
        id: 'note-1',
        entityType: 'project_request',
        entityId: REQUEST_ID,
        body: 'Body',
        authorUserId: AUTHOR_ID,
        authorFirstName: 'Adeeb',
        authorLastName: 'Khan',
        createdAt,
      },
    ]);
    const view = await loadBaloPanel(user(), request());
    expect(view?.notes[0]?.createdAtIso).toBe('2026-03-15T09:30:00.000Z');
  });
});
