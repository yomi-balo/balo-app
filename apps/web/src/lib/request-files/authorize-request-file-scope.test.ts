import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * BAL-431 / ADR-1048 §4 layer 2 — THE REQUEST-FILE SCOPE GATE.
 *
 * ⚠ WHY THIS FILE EXISTS. This gate is the direct replacement for the
 * containment-by-`conversationId` IDOR defence a request-grain file dissolves, and all five
 * Server Actions plus the RSC loader `vi.mock` it away in their own suites. Nothing else
 * anywhere exercises the admin arm's platform-capability check, the client arm's PARTICIPATE
 * check (Ruling 3's load-bearing predicate — delete right ≡ upload right), the
 * `relationshipId === null` deny, the `viewer === undefined` fail-closed, or the SECOND
 * relationship read the module's own docblock calls "LOAD-BEARING … must not be optimised
 * away". Every one of those is asserted below.
 *
 * ⚠ ONLY THE I/O SEAMS ARE MOCKED. `@balo/db`, `@/lib/authz` and `@/lib/authz/platform` are
 * doubles; `resolveRequestLens` and the whole `@balo/shared/authz` file-plane core run FOR
 * REAL, because mocking them would make the test agree with itself rather than with the rule.
 */

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000001';
const OTHER_COMPANY_ID = 'c0000000-0000-4000-8000-000000000009';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const OTHER_REL_ID = 'b0000000-0000-4000-8000-000000000003';
const EXPERT_PROFILE_ID = 'e0000000-0000-4000-8000-000000000004';
const OTHER_EXPERT_PROFILE_ID = 'e0000000-0000-4000-8000-000000000005';

const mockFindByIdWithRelations = vi.fn();
const mockListByRequest = vi.fn();
vi.mock('@balo/db', () => ({
  projectRequestsRepository: {
    findByIdWithRelations: (...args: unknown[]) => mockFindByIdWithRelations(...args),
  },
  requestExpertRelationshipsRepository: {
    listByRequest: (...args: unknown[]) => mockListByRequest(...args),
  },
}));

const mockHasCapability = vi.fn();
vi.mock('@/lib/authz', () => ({
  hasCapability: (...args: unknown[]) => mockHasCapability(...args),
  CAPABILITIES: { PARTICIPATE: 'participate' },
}));

const mockHasPlatformCapability = vi.fn();
vi.mock('@/lib/authz/platform', () => ({
  hasPlatformCapability: (...args: unknown[]) => mockHasPlatformCapability(...args),
  PLATFORM_CAPABILITIES: { VIEW_ANY_REQUEST_FILE: 'view_any_request_file' },
}));

// `vi.hoisted` — the logging mock factory runs before the module body, so a plain `const`
// would be in its temporal dead zone.
const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));
vi.mock('@/lib/logging', () => ({
  log: { info: vi.fn(), warn: mockWarn, error: vi.fn() },
}));

import type { SessionUser } from '@/lib/auth/session';
import { authorizeRequestFileScope } from './authorize-request-file-scope';

function sessionUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'u0000000-0000-4000-8000-000000000001',
    email: 'a@b.test',
    firstName: 'Dana',
    lastName: 'Okafor',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'user',
    companyId: COMPANY_ID,
    companyName: 'Northwind Industrial',
    companyRole: 'member',
    ...overrides,
  } as SessionUser;
}

/**
 * ⚠ THE NARROW RENDER-GRAPH SHAPE, ON PURPOSE. `findByIdWithRelations`'s `relationships`
 * sub-select is an allow-list carrying `status` but NOT `declinedAt` / `deletedAt` /
 * `notSelectedAt` (BAL-283 refused to widen it). Every fixture below feeds exactly that,
 * which is what makes the "second read is load-bearing" cases real.
 */
function narrowRequest(
  relationships: Array<{ id: string; expertProfileId: string; status: string }>
): unknown {
  return {
    id: REQUEST_ID,
    companyId: COMPANY_ID,
    status: 'proposal_submitted',
    relationships,
  };
}

/** The FULL relationship row `listByRequest` returns — all three closure columns present. */
function fullRelationship(
  overrides: Partial<{
    id: string;
    expertProfileId: string;
    status: string;
    declinedAt: Date | null;
    deletedAt: Date | null;
    notSelectedAt: Date | null;
  }> = {}
): unknown {
  return {
    id: REL_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    status: 'proposal_submitted',
    declinedAt: null,
    deletedAt: null,
    notSelectedAt: null,
    ...overrides,
  };
}

describe('authorizeRequestFileScope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListByRequest.mockResolvedValue([]);
    mockHasCapability.mockResolvedValue(true);
    mockHasPlatformCapability.mockReturnValue(true);
  });

  // ── Denials before any lens is resolved ────────────────────────────────────────────

  it('denies a missing request with the ONE literal, and reads no relationships', async () => {
    mockFindByIdWithRelations.mockResolvedValue(undefined);

    const scope = await authorizeRequestFileScope(sessionUser(), REQUEST_ID);

    expect(scope).toEqual({ ok: false, code: 'request_files_not_found' });
    expect(mockListByRequest).not.toHaveBeenCalled();
  });

  it('denies a stranger (no lens) with the SAME literal — existence never leaks', async () => {
    mockFindByIdWithRelations.mockResolvedValue(narrowRequest([]));

    const scope = await authorizeRequestFileScope(
      sessionUser({ companyId: OTHER_COMPANY_ID, expertProfileId: undefined }),
      REQUEST_ID
    );

    expect(scope).toEqual({ ok: false, code: 'request_files_not_found' });
    expect(mockListByRequest).not.toHaveBeenCalled();
  });

  // ── Admin arm — the PLATFORM axis (ADR-1035), not the lens alone ───────────────────

  it('resolves the admin arm when the platform capability is held', async () => {
    mockFindByIdWithRelations.mockResolvedValue(narrowRequest([]));
    mockListByRequest.mockResolvedValue([fullRelationship()]);

    const scope = await authorizeRequestFileScope(
      sessionUser({ platformRole: 'admin', companyId: OTHER_COMPANY_ID }),
      REQUEST_ID
    );

    expect(scope.ok).toBe(true);
    expect(scope.ok === true && scope.side).toBe('admin');
    expect(mockHasPlatformCapability).toHaveBeenCalledWith(
      expect.objectContaining({ platformRole: 'admin' }),
      'view_any_request_file'
    );
  });

  /**
   * ⚠ THE LENS IS NOT THE AUTHORIZATION. `resolveRequestLens` puts every `admin` /
   * `super_admin` on the observer arm; whether that observer may perform a CROSS-TENANT read
   * of party data is the platform capability's question. If this ever passes with the
   * capability denied, the two boundaries have been collapsed into one.
   */
  it('denies an observer WITHOUT the platform capability, and never reads the tracks', async () => {
    mockFindByIdWithRelations.mockResolvedValue(narrowRequest([]));
    mockHasPlatformCapability.mockReturnValue(false);

    const scope = await authorizeRequestFileScope(
      sessionUser({ platformRole: 'admin', companyId: OTHER_COMPANY_ID }),
      REQUEST_ID
    );

    expect(scope).toEqual({ ok: false, code: 'request_files_not_found' });
    expect(mockListByRequest).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      'Request file scope denied',
      expect.objectContaining({ reason: 'admin_capability_denied' })
    );
  });

  // ── Client arm — the MEMBERSHIP axis (Ruling 3's load-bearing predicate) ───────────

  it('resolves the client arm through the PARTICIPATE capability on the request’s company', async () => {
    mockFindByIdWithRelations.mockResolvedValue(narrowRequest([]));
    mockListByRequest.mockResolvedValue([fullRelationship()]);

    const scope = await authorizeRequestFileScope(sessionUser(), REQUEST_ID);

    expect(scope.ok === true && scope.side).toBe('client');
    expect(scope.ok === true && scope.side === 'client' && scope.companyId).toBe(COMPANY_ID);
    expect(mockHasCapability).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      'participate',
      {
        companyId: COMPANY_ID,
      }
    );
  });

  /**
   * ⚠ THE CAPABILITY, NOT THE LENS. `resolveRequestLens` resolves `client` on a bare
   * `user.companyId === request.companyId` match — a VIEW rule. A company member who cannot
   * PARTICIPATE must not reach the file plane at all, because Ruling 3 makes the SAME
   * predicate grant both upload and delete.
   */
  it('denies a company viewer WITHOUT PARTICIPATE, even though the lens resolved client', async () => {
    mockFindByIdWithRelations.mockResolvedValue(narrowRequest([]));
    mockHasCapability.mockResolvedValue(false);

    const scope = await authorizeRequestFileScope(sessionUser(), REQUEST_ID);

    expect(scope).toEqual({ ok: false, code: 'request_files_not_found' });
    expect(mockListByRequest).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      'Request file scope denied',
      expect.objectContaining({ reason: 'client_capability_denied' })
    );
  });

  // ── Expert arm ────────────────────────────────────────────────────────────────────

  it('resolves the expert arm to the viewer’s OWN track, and never exposes the others', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      narrowRequest([
        { id: REL_ID, expertProfileId: EXPERT_PROFILE_ID, status: 'proposal_submitted' },
        { id: OTHER_REL_ID, expertProfileId: OTHER_EXPERT_PROFILE_ID, status: 'invited' },
      ])
    );
    mockListByRequest.mockResolvedValue([
      fullRelationship(),
      fullRelationship({ id: OTHER_REL_ID, expertProfileId: OTHER_EXPERT_PROFILE_ID }),
    ]);

    const scope = await authorizeRequestFileScope(
      sessionUser({ companyId: OTHER_COMPANY_ID, expertProfileId: EXPERT_PROFILE_ID }),
      REQUEST_ID
    );

    expect(scope.ok).toBe(true);
    if (!scope.ok || scope.side !== 'expert') throw new Error('expected the expert arm');
    expect(scope.viewer.relationshipId).toBe(REL_ID);
    // ⚠ THE CONCEALMENT SHAPE: the expert arm has no `tracks` field at all.
    expect(scope).not.toHaveProperty('tracks');
    expect(Object.keys(scope).sort()).toEqual(['ok', 'request', 'side', 'viewer']);
  });

  /**
   * `ctx.relationshipId === null` is reachable for a viewer whose lens is neither admin nor
   * client — i.e. a non-admin, non-owner with no `expertProfileId` match would already have
   * been denied by the lens, so this arm is reached only through a lens that resolved
   * `expert` with a null id. Asserted as a fail-closed rather than left to inference.
   */
  it('fails closed when the viewer’s track has vanished between the two reads', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      narrowRequest([
        { id: REL_ID, expertProfileId: EXPERT_PROFILE_ID, status: 'proposal_submitted' },
      ])
    );
    // The full re-read (which filters `deleted_at IS NULL`) no longer sees that track —
    // a withdrawal, or a hard-delete race.
    mockListByRequest.mockResolvedValue([]);

    const scope = await authorizeRequestFileScope(
      sessionUser({ companyId: OTHER_COMPANY_ID, expertProfileId: EXPERT_PROFILE_ID }),
      REQUEST_ID
    );

    expect(scope).toEqual({ ok: false, code: 'request_files_not_found' });
    expect(mockWarn).toHaveBeenCalledWith(
      'Request file scope denied',
      expect.objectContaining({ reason: 'expert_track_missing' })
    );
  });

  it('denies a declined expert — the lens itself walls them off (OSD-3)', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      narrowRequest([{ id: REL_ID, expertProfileId: EXPERT_PROFILE_ID, status: 'declined' }])
    );

    const scope = await authorizeRequestFileScope(
      sessionUser({ companyId: OTHER_COMPANY_ID, expertProfileId: EXPERT_PROFILE_ID }),
      REQUEST_ID
    );

    expect(scope).toEqual({ ok: false, code: 'request_files_not_found' });
    expect(mockListByRequest).not.toHaveBeenCalled();
  });

  // ── ⚠⚠ THE SECOND RELATIONSHIP READ IS LOAD-BEARING ───────────────────────────────

  /**
   * ⚠⚠ THE TEST THAT FAILS IF SOMEONE "OPTIMISES AWAY" `listByRequest`.
   *
   * The fixtures below feed `findByIdWithRelations` the NARROW render-graph shape — no
   * `declinedAt`, no `deletedAt`, no `notSelectedAt`. Resolving standing from THAT row yields
   * `{ kind: 'closed', closedAt: null }` for every track, because `resolveRequestTrackFileAccess`
   * fails closed when the columns are absent (`undefined !== null`). Only the FULL re-read can
   * produce a LIVE track. So a gate that dropped the second read would report this live,
   * `invited` expert as CLOSED — and they would lose every share-to-all file the moment their
   * track existed, which is ADR-1048's headline scenario.
   */
  it('resolves LIVE standing from the full re-read, not from the narrow render graph', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      narrowRequest([{ id: REL_ID, expertProfileId: EXPERT_PROFILE_ID, status: 'invited' }])
    );
    mockListByRequest.mockResolvedValue([fullRelationship({ status: 'invited' })]);

    const scope = await authorizeRequestFileScope(
      sessionUser({ companyId: OTHER_COMPANY_ID, expertProfileId: EXPERT_PROFILE_ID }),
      REQUEST_ID
    );

    if (!scope.ok || scope.side !== 'expert') throw new Error('expected the expert arm');
    expect(mockListByRequest).toHaveBeenCalledWith(REQUEST_ID);
    // `invited` IS live for files (Ruling 2) — and unreachable without the second read.
    expect(scope.viewer.access).toEqual({ kind: 'live' });
    expect(scope.viewer.standing).toEqual({
      status: 'invited',
      declinedAt: null,
      notSelectedAt: null,
    });
  });

  /**
   * The same read is what carries the CLOSURE INSTANT and the closure REASON. `not_selected_at`
   * exists on no render-graph projection anywhere, so this is unanswerable without it — and it
   * is the value the expert's own closure banner (Ruling 2) is keyed off.
   */
  it('carries `notSelectedAt` — the closure instant and reason — through from the full re-read', async () => {
    const closedAt = new Date('2026-08-20T10:00:00.000Z');
    mockFindByIdWithRelations.mockResolvedValue(
      narrowRequest([
        { id: REL_ID, expertProfileId: EXPERT_PROFILE_ID, status: 'proposal_submitted' },
      ])
    );
    mockListByRequest.mockResolvedValue([fullRelationship({ notSelectedAt: closedAt })]);

    const scope = await authorizeRequestFileScope(
      sessionUser({ companyId: OTHER_COMPANY_ID, expertProfileId: EXPERT_PROFILE_ID }),
      REQUEST_ID
    );

    if (!scope.ok || scope.side !== 'expert') throw new Error('expected the expert arm');
    expect(scope.viewer.access).toEqual({ kind: 'closed', closedAt });
    expect(scope.viewer.standing.notSelectedAt).toEqual(closedAt);
  });

  /**
   * The client/admin `tracks` list is documented as "live AND closed — filter before offering
   * a share target". Pinned so the docblock and the behaviour cannot drift apart.
   */
  it('returns CLOSED tracks on the client arm too (they are not a share-target list)', async () => {
    const closedAt = new Date('2026-08-20T10:00:00.000Z');
    mockFindByIdWithRelations.mockResolvedValue(narrowRequest([]));
    mockListByRequest.mockResolvedValue([
      fullRelationship(),
      fullRelationship({
        id: OTHER_REL_ID,
        expertProfileId: OTHER_EXPERT_PROFILE_ID,
        notSelectedAt: closedAt,
      }),
    ]);

    const scope = await authorizeRequestFileScope(sessionUser(), REQUEST_ID);

    if (!scope.ok || scope.side !== 'client') throw new Error('expected the client arm');
    expect(scope.tracks.map((t) => t.access.kind)).toEqual(['live', 'closed']);
  });

  // ── No writes on any path (what lets the download action sit on READ_ONLY_ALLOWLIST) ──

  it('performs NO write on any path — only the two documented reads', async () => {
    mockFindByIdWithRelations.mockResolvedValue(narrowRequest([]));
    mockListByRequest.mockResolvedValue([fullRelationship()]);

    await authorizeRequestFileScope(sessionUser(), REQUEST_ID);

    expect(mockFindByIdWithRelations).toHaveBeenCalledTimes(1);
    expect(mockListByRequest).toHaveBeenCalledTimes(1);
  });
});
