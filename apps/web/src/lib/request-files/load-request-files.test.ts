import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * BAL-431 §7.1 — THE SERVER LOADER.
 *
 * ⚠ WHY THIS FILE EXISTS. The loader owns four things nothing else does: `closedReasonOf` (the
 * ONLY producer of Ruling 2's `'declined' | 'not_selected'` distinction, and the reason the
 * single-live-definition invariant grants this module an exemption), the expert arm's per-file
 * `requestFileVisibleToTrack` filter, the admin arm's tombstone-inclusive read, and the
 * `REQUEST_SHARED_FILE_LIST_LIMIT` truncation warning. All four are asserted here.
 *
 * ⚠ THE SCOPE GATE IS A DOUBLE, BY DESIGN. It has its own suite
 * (`authorize-request-file-scope.test.ts`) which mocks nothing but the I/O seams; re-proving it
 * through the loader would only make the two agree with each other. The AUDIENCE RULE, by
 * contrast, is REAL here (`@balo/shared/authz` is not mocked) — the expert filter must be
 * tested against the actual rule, not a stub of it.
 */

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const OTHER_REL_ID = 'b0000000-0000-4000-8000-000000000003';
const EXPERT_PROFILE_ID = 'e0000000-0000-4000-8000-000000000004';
const OTHER_EXPERT_PROFILE_ID = 'e0000000-0000-4000-8000-000000000005';
const CLIENT_USER_ID = 'u0000000-0000-4000-8000-000000000006';

/** ⚠ A SMALL CAP, on purpose: the loader compares `rows.length === <the constant>`, so what is
 *  under test is the COMPARISON, not the number 200. A small value keeps the fixture honest. */
const CAP = 3;

const mockListForRequest = vi.fn();
const mockListByRequest = vi.fn();
const mockFindNamesByIds = vi.fn();
vi.mock('@balo/db', () => ({
  requestSharedFilesRepository: {
    listForRequest: (...args: unknown[]) => mockListForRequest(...args),
  },
  requestExpertRelationshipsRepository: {
    listByRequest: (...args: unknown[]) => mockListByRequest(...args),
  },
  usersRepository: {
    findNamesByIds: (...args: unknown[]) => mockFindNamesByIds(...args),
  },
  REQUEST_SHARED_FILE_LIST_LIMIT: 3,
}));

const mockAuthorizeScope = vi.fn();
vi.mock('./authorize-request-file-scope', () => ({
  authorizeRequestFileScope: (...args: unknown[]) => mockAuthorizeScope(...args),
  REQUEST_FILES_UNAVAILABLE_COPY: 'These files are no longer available.',
}));

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));
vi.mock('@/lib/logging', () => ({
  log: { info: vi.fn(), warn: mockWarn, error: vi.fn() },
}));

import type { SessionUser } from '@/lib/auth/session';
import { closedReasonOf, clientUploaderLabel, loadRequestFiles } from './load-request-files';

const USER = { id: CLIENT_USER_ID } as SessionUser;

const INVITED_AT = new Date('2026-08-01T00:00:00.000Z');
const SHARED_AT = new Date('2026-08-05T00:00:00.000Z');

function fileRow(
  overrides: Partial<{
    id: string;
    fileName: string;
    side: 'client' | 'expert';
    audience: 'all_live_tracks' | 'grants' | 'own_track';
    expertRelationshipId: string | null;
    createdAt: Date;
    deletedAt: Date | null;
    deletedByUserId: string | null;
  }> = {}
): unknown {
  return {
    id: 'f0000000-0000-4000-8000-000000000001',
    projectRequestId: REQUEST_ID,
    uploadedByUserId: CLIENT_USER_ID,
    fileName: 'Requirements.pdf',
    contentType: 'application/pdf',
    sizeBytes: 2048,
    side: 'client',
    audience: 'all_live_tracks',
    expertRelationshipId: null,
    r2Key: `request-files/${REQUEST_ID}/${CLIENT_USER_ID}/x`,
    createdAt: SHARED_AT,
    deletedAt: null,
    deletedByUserId: null,
    ...overrides,
  };
}

/** The narrow render-graph relationship the request row carries (status + invitedAt only). */
function narrowRel(id: string, expertProfileId: string, firstName: string): unknown {
  return {
    id,
    expertProfileId,
    status: 'proposal_submitted',
    invitedAt: INVITED_AT,
    expertProfile: { user: { firstName, lastName: null } },
  };
}

function requestRow(relationships: unknown[]): unknown {
  return {
    id: REQUEST_ID,
    companyId: 'c1',
    company: { name: 'Acme Corp' },
    relationships,
  };
}

function fullRel(
  id: string,
  expertProfileId: string,
  overrides: Partial<{ status: string; declinedAt: Date | null; notSelectedAt: Date | null }> = {}
): unknown {
  return {
    id,
    expertProfileId,
    status: 'proposal_submitted',
    declinedAt: null,
    deletedAt: null,
    notSelectedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindNamesByIds.mockResolvedValue([
    { id: CLIENT_USER_ID, firstName: 'Sarah', lastName: 'Chen' },
  ]);
  mockListByRequest.mockResolvedValue([]);
});

// ── closedReasonOf ───────────────────────────────────────────────────────────────────

describe('closedReasonOf — Ruling 2’s reason distinction', () => {
  const CLOSED_AT = new Date('2026-08-10T00:00:00.000Z');

  it('names DECLINED from the status label, through the shared predicate', () => {
    expect(closedReasonOf({ status: 'declined', declinedAt: null, notSelectedAt: null })).toBe(
      'declined'
    );
  });

  it('names DECLINED from the timestamp even when the status has not caught up', () => {
    expect(
      closedReasonOf({ status: 'proposal_submitted', declinedAt: CLOSED_AT, notSelectedAt: null })
    ).toBe('declined');
  });

  it('names NOT_SELECTED for a track closed by an award', () => {
    expect(
      closedReasonOf({
        status: 'proposal_submitted',
        declinedAt: null,
        notSelectedAt: CLOSED_AT,
      })
    ).toBe('not_selected');
  });

  /**
   * ⚠ PRECEDENCE, NOT AN ARBITRARY ORDER. A track that DECLINED and was later swept by an award
   * declined — the file plane takes the EARLIEST instant, and the reason must agree with it.
   */
  it('prefers DECLINED over NOT_SELECTED when a declined track was later swept', () => {
    expect(
      closedReasonOf({ status: 'declined', declinedAt: CLOSED_AT, notSelectedAt: CLOSED_AT })
    ).toBe('declined');
  });

  it('returns null for a live track', () => {
    expect(
      closedReasonOf({ status: 'proposal_submitted', declinedAt: null, notSelectedAt: null })
    ).toBeNull();
  });
});

// ── clientUploaderLabel ──────────────────────────────────────────────────────────────

describe('clientUploaderLabel', () => {
  it('is the "Person @ Org" retrospective form (CLAUDE.md attribution)', () => {
    expect(clientUploaderLabel('Sarah Chen', 'Acme Corp')).toBe('Sarah Chen @ Acme Corp');
  });
});

// ── loadRequestFiles ─────────────────────────────────────────────────────────────────

describe('loadRequestFiles', () => {
  it('returns null — not an error — when the gate denies, so the panel is simply ABSENT', async () => {
    mockAuthorizeScope.mockResolvedValue({ ok: false, code: 'request_files_not_found' });
    expect(await loadRequestFiles(USER, REQUEST_ID)).toBeNull();
    expect(mockListForRequest).not.toHaveBeenCalled();
  });

  // ── Expert arm ──

  /**
   * ⚠ THE PER-FILE AUDIENCE FILTER, AGAINST THE REAL RULE. Three files reach the loader; the
   * viewer may see exactly two. The one it must NOT see is a SIBLING CANDIDATE'S own-track
   * upload — the cross-track read ADR-1048 §7 invariant 1 exists to make impossible.
   */
  it('expert arm: filters out a file the viewer cannot see, including a sibling’s own upload', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'expert',
      request: requestRow([narrowRel(REL_ID, EXPERT_PROFILE_ID, 'Wei')]),
      viewer: {
        relationshipId: REL_ID,
        expertProfileId: EXPERT_PROFILE_ID,
        access: { kind: 'live' },
        standing: { status: 'proposal_submitted', declinedAt: null, notSelectedAt: null },
      },
    });
    mockListForRequest.mockResolvedValue([
      { file: fileRow({ id: 'f1', fileName: 'all-tracks.pdf' }), grants: [] },
      {
        file: fileRow({
          id: 'f2',
          fileName: 'mine.pdf',
          side: 'expert',
          audience: 'own_track',
          expertRelationshipId: REL_ID,
        }),
        grants: [],
      },
      {
        file: fileRow({
          id: 'f3',
          fileName: 'rivals.pdf',
          side: 'expert',
          audience: 'own_track',
          expertRelationshipId: OTHER_REL_ID,
        }),
        grants: [],
      },
      {
        file: fileRow({ id: 'f4', fileName: 'granted-to-rival.pdf', audience: 'grants' }),
        grants: [{ relationshipId: OTHER_REL_ID }],
      },
    ]);

    const view = await loadRequestFiles(USER, REQUEST_ID);

    if (view?.lens !== 'expert') throw new Error('expected the expert lens');
    expect(view.files.map((f) => f.fileName)).toEqual(['all-tracks.pdf', 'mine.pdf']);
    // Not tombstone-inclusive: the expert lens never asks for deleted rows.
    expect(mockListForRequest).toHaveBeenCalledWith(REQUEST_ID, { includeDeleted: false });
  });

  it('expert arm: carries the CLIENT PARTY name and a null closedReason for a live track', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'expert',
      request: requestRow([narrowRel(REL_ID, EXPERT_PROFILE_ID, 'Wei')]),
      viewer: {
        relationshipId: REL_ID,
        expertProfileId: EXPERT_PROFILE_ID,
        access: { kind: 'live' },
        standing: { status: 'proposal_submitted', declinedAt: null, notSelectedAt: null },
      },
    });
    mockListForRequest.mockResolvedValue([]);

    const view = await loadRequestFiles(USER, REQUEST_ID);

    if (view?.lens !== 'expert') throw new Error('expected the expert lens');
    expect(view.clientPartyName).toBe('Acme Corp');
    expect(view.closedReason).toBeNull();
  });

  /**
   * ⚠⚠ THE BUG THIS REPLACES. `access.kind === 'closed'` is true for declined ∨ withdrawn ∨
   * not-selected; a boolean carried that collapse to the banner, which then told a NOT-SELECTED
   * expert they had declined. Fails if `closedReason` is ever collapsed back to a boolean.
   */
  it('expert arm: a NOT-SELECTED track reports `not_selected`, never `declined`', async () => {
    const closedAt = new Date('2026-08-20T00:00:00.000Z');
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'expert',
      request: requestRow([narrowRel(REL_ID, EXPERT_PROFILE_ID, 'Wei')]),
      viewer: {
        relationshipId: REL_ID,
        expertProfileId: EXPERT_PROFILE_ID,
        access: { kind: 'closed', closedAt },
        standing: {
          status: 'proposal_submitted',
          declinedAt: null,
          notSelectedAt: closedAt,
        },
      },
    });
    mockListForRequest.mockResolvedValue([]);

    const view = await loadRequestFiles(USER, REQUEST_ID);

    if (view?.lens !== 'expert') throw new Error('expected the expert lens');
    expect(view.closedReason).toBe('not_selected');
  });

  it('expert arm: a DECLINED track reports `declined`', async () => {
    const closedAt = new Date('2026-08-20T00:00:00.000Z');
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'expert',
      request: requestRow([narrowRel(REL_ID, EXPERT_PROFILE_ID, 'Wei')]),
      viewer: {
        relationshipId: REL_ID,
        expertProfileId: EXPERT_PROFILE_ID,
        access: { kind: 'closed', closedAt },
        standing: { status: 'declined', declinedAt: closedAt, notSelectedAt: null },
      },
    });
    mockListForRequest.mockResolvedValue([]);

    const view = await loadRequestFiles(USER, REQUEST_ID);

    if (view?.lens !== 'expert') throw new Error('expected the expert lens');
    expect(view.closedReason).toBe('declined');
  });

  // ── Client arm ──

  it('client arm: offers only LIVE tracks as share targets and attributes "Person @ Org"', async () => {
    const closedAt = new Date('2026-08-20T00:00:00.000Z');
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'client',
      companyId: 'c1',
      request: requestRow([
        narrowRel(REL_ID, EXPERT_PROFILE_ID, 'Wei'),
        narrowRel(OTHER_REL_ID, OTHER_EXPERT_PROFILE_ID, 'Priya'),
      ]),
      tracks: [
        {
          relationshipId: REL_ID,
          expertProfileId: EXPERT_PROFILE_ID,
          access: { kind: 'live' },
          standing: { status: 'proposal_submitted', declinedAt: null, notSelectedAt: null },
        },
        {
          relationshipId: OTHER_REL_ID,
          expertProfileId: OTHER_EXPERT_PROFILE_ID,
          access: { kind: 'closed', closedAt },
          standing: {
            status: 'proposal_submitted',
            declinedAt: null,
            notSelectedAt: closedAt,
          },
        },
      ],
    });
    mockListByRequest.mockResolvedValue([
      fullRel(REL_ID, EXPERT_PROFILE_ID),
      fullRel(OTHER_REL_ID, OTHER_EXPERT_PROFILE_ID, { notSelectedAt: closedAt }),
    ]);
    mockListForRequest.mockResolvedValue([{ file: fileRow(), grants: [] }]);

    const view = await loadRequestFiles(USER, REQUEST_ID);

    if (view?.lens !== 'client') throw new Error('expected the client lens');
    // ⚠ CLOSED TRACKS ARE NOT OFFERABLE — invariant 4 at the picker layer.
    expect(view.liveTracks).toEqual([{ relationshipId: REL_ID, trackName: 'Wei' }]);
    // ⚠ THE SAME LABEL THE CONFIRM ACTION EMITS — the file must not change format on reload.
    expect(view.files[0]?.uploadedByName).toBe('Sarah Chen @ Acme Corp');
    // The closed track still appears as an ANNOTATION, with the right reason.
    const audience = view.files[0]?.audience;
    expect(audience?.type === 'all_live_tracks' && audience.annotations).toEqual([
      {
        relationshipId: OTHER_REL_ID,
        trackName: 'Priya',
        reason: 'not_selected',
        keptAccess: true,
      },
    ]);
    // ⚠ THE HAPPY PATH IS SILENT. Both tracks resolved a REAL name, so the divergence warning
    // below must not fire — otherwise that warning is noise and nobody will act on it.
    expect(mockWarn).not.toHaveBeenCalled();
  });

  /**
   * ⚠ THE NAME-SOURCE DIVERGENCE, DRIVEN RATHER THAN ASSERTED. `loadTrackDisplays` builds its
   * names from `scope.request.relationships` but ITERATES `listByRequest`. A relationship
   * present in the second and absent from the first collapses to the generic 'Expert' — and
   * with TWO such tracks the client sees two identical rows in the share picker and the
   * audience badges, with no way to tell which is which. The old code argued in a comment that
   * this cannot happen; this drives it and proves it is at least DETECTABLE when it does.
   *
   * Delete the `log.warn` and this test fails.
   */
  it('client arm: warns per track whose name is missing from the request row, keeping the fallback', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'client',
      companyId: 'c1',
      // ⚠ EMPTY on purpose — the name source knows about neither track.
      request: requestRow([]),
      tracks: [
        {
          relationshipId: REL_ID,
          expertProfileId: EXPERT_PROFILE_ID,
          access: { kind: 'live' },
          standing: { status: 'proposal_submitted', declinedAt: null, notSelectedAt: null },
        },
        {
          relationshipId: OTHER_REL_ID,
          expertProfileId: OTHER_EXPERT_PROFILE_ID,
          access: { kind: 'live' },
          standing: { status: 'proposal_submitted', declinedAt: null, notSelectedAt: null },
        },
      ],
    });
    mockListByRequest.mockResolvedValue([
      fullRel(REL_ID, EXPERT_PROFILE_ID),
      fullRel(OTHER_REL_ID, OTHER_EXPERT_PROFILE_ID),
    ]);
    mockListForRequest.mockResolvedValue([{ file: fileRow(), grants: [] }]);

    const view = await loadRequestFiles(USER, REQUEST_ID);

    if (view?.lens !== 'client') throw new Error('expected the client lens');
    // The fallback SURVIVES — a nameless track must still render, and still be offerable.
    expect(view.liveTracks).toEqual([
      { relationshipId: REL_ID, trackName: 'Expert' },
      { relationshipId: OTHER_REL_ID, trackName: 'Expert' },
    ]);
    // …and this is exactly the collapse that used to be silent: two indistinguishable rows.
    expect(mockWarn).toHaveBeenCalledTimes(2);
    expect(mockWarn).toHaveBeenCalledWith('Request file track has no resolved display name', {
      requestId: REQUEST_ID,
      relationshipId: REL_ID,
    });
    expect(mockWarn).toHaveBeenCalledWith('Request file track has no resolved display name', {
      requestId: REQUEST_ID,
      relationshipId: OTHER_REL_ID,
    });
  });

  // ── Admin arm ──

  /** ⚠ TOMBSTONES ARE THE ADMIN LENS'S EXPLICITLY-NAMED PATH — never a relaxed predicate. */
  it('admin arm: asks for tombstones and renders them as deleted', async () => {
    const deletedAt = new Date('2026-08-25T00:00:00.000Z');
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'admin',
      request: requestRow([narrowRel(REL_ID, EXPERT_PROFILE_ID, 'Wei')]),
      tracks: [
        {
          relationshipId: REL_ID,
          expertProfileId: EXPERT_PROFILE_ID,
          access: { kind: 'live' },
          standing: { status: 'proposal_submitted', declinedAt: null, notSelectedAt: null },
        },
      ],
    });
    mockListByRequest.mockResolvedValue([fullRel(REL_ID, EXPERT_PROFILE_ID)]);
    mockListForRequest.mockResolvedValue([
      { file: fileRow({ id: 'f1', fileName: 'live.pdf' }), grants: [] },
      {
        file: fileRow({
          id: 'f2',
          fileName: 'gone.pdf',
          deletedAt,
          deletedByUserId: CLIENT_USER_ID,
        }),
        grants: [],
      },
    ]);

    const view = await loadRequestFiles(USER, REQUEST_ID);

    expect(mockListForRequest).toHaveBeenCalledWith(REQUEST_ID, { includeDeleted: true });
    if (view?.lens !== 'admin') throw new Error('expected the admin lens');
    expect(view.files.map((f) => [f.fileName, f.deleted])).toEqual([
      ['live.pdf', false],
      ['gone.pdf', true],
    ]);
    // A tombstone is invisible to the audience rule, so nobody can still see it.
    expect(view.files[1]?.visibleTo).toEqual([]);
    expect(view.files[0]?.visibleTo.map((v) => v.trackName)).toEqual(['Wei']);
  });

  // ── The truncation warning ──

  /**
   * ⚠ AT EXACTLY THE CAP, AND NOT BELOW IT. The list is a CAP, not pagination, and it is
   * oldest-first — so truncation drops the NEWEST files, silently, on an oversight lens. The
   * warning is the only signal that happened.
   */
  it('warns when the list comes back at exactly the cap', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'admin',
      request: requestRow([]),
      tracks: [],
    });
    mockListForRequest.mockResolvedValue(
      Array.from({ length: CAP }, (_unused, i) => ({
        file: fileRow({ id: `f${i}`, fileName: `f${i}.pdf` }),
        grants: [],
      }))
    );

    await loadRequestFiles(USER, REQUEST_ID);

    expect(mockWarn).toHaveBeenCalledWith(
      'Request shared file list truncated at cap',
      expect.objectContaining({ requestId: REQUEST_ID, side: 'admin', limit: CAP })
    );
  });

  it('does NOT warn one row below the cap', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'admin',
      request: requestRow([]),
      tracks: [],
    });
    mockListForRequest.mockResolvedValue(
      Array.from({ length: CAP - 1 }, (_unused, i) => ({
        file: fileRow({ id: `f${i}`, fileName: `f${i}.pdf` }),
        grants: [],
      }))
    );

    await loadRequestFiles(USER, REQUEST_ID);

    expect(mockWarn).not.toHaveBeenCalled();
  });

  // ── Attribution of an EXPERT-side upload ──

  /**
   * ⚠ AN EXPERT UPLOAD IS ATTRIBUTED TO ITS TRACK, NOT TO A PERSON. `uploadedByUserId` on an
   * expert-side row is the individual expert, but the client and admin lenses must show the
   * TRACK name — the same label the picker and the audience badges use — so one file does not
   * read one way in the list and another way in its audience. This is the arm that resolves the
   * name from `tracks` rather than through `clientUploaderLabel`.
   */
  it('client arm: attributes an expert-side file to its track name, not the uploader', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'client',
      companyId: 'c1',
      request: requestRow([narrowRel(REL_ID, EXPERT_PROFILE_ID, 'Wei')]),
      tracks: [
        {
          relationshipId: REL_ID,
          expertProfileId: EXPERT_PROFILE_ID,
          access: { kind: 'live' },
          standing: { status: 'proposal_submitted', declinedAt: null, notSelectedAt: null },
        },
      ],
    });
    mockListByRequest.mockResolvedValue([fullRel(REL_ID, EXPERT_PROFILE_ID)]);
    mockListForRequest.mockResolvedValue([
      {
        file: fileRow({
          fileName: 'Approach.pdf',
          side: 'expert',
          audience: 'own_track',
          expertRelationshipId: REL_ID,
        }),
        grants: [],
      },
    ]);

    const view = await loadRequestFiles(USER, REQUEST_ID);

    if (view?.lens !== 'client') throw new Error('expected the client lens');
    expect(view.files[0]?.uploadedByName).toBe('Wei');
    expect(view.files[0]?.uploadedByName).not.toContain('@');
    // An own-track upload is scoped to that expert's conversation, never to the whole audience.
    expect(view.files[0]?.audience.type).toBe('expert_own_track');
  });

  /** The same rule on the oversight lens — one attribution rule, two lenses. */
  it('admin arm: attributes an expert-side file to its track name', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'admin',
      request: requestRow([narrowRel(REL_ID, EXPERT_PROFILE_ID, 'Wei')]),
      tracks: [
        {
          relationshipId: REL_ID,
          expertProfileId: EXPERT_PROFILE_ID,
          access: { kind: 'live' },
          standing: { status: 'proposal_submitted', declinedAt: null, notSelectedAt: null },
        },
      ],
    });
    mockListByRequest.mockResolvedValue([fullRel(REL_ID, EXPERT_PROFILE_ID)]);
    mockListForRequest.mockResolvedValue([
      {
        file: fileRow({
          fileName: 'Approach.pdf',
          side: 'expert',
          audience: 'own_track',
          expertRelationshipId: REL_ID,
        }),
        grants: [],
      },
    ]);

    const view = await loadRequestFiles(USER, REQUEST_ID);

    if (view?.lens !== 'admin') throw new Error('expected the admin lens');
    expect(view.files[0]?.uploadedByName).toBe('Wei');
    expect(view.files[0]?.side).toBe('expert');
  });

  /**
   * ⚠ THE GRANTS AUDIENCE IS BUILT FROM THE GRANT ROWS. A `grants`-mode file's audience must
   * name exactly the tracks holding a live grant — reading it from the track list instead
   * would show a sensitive, narrowly-shared document as visible to everyone.
   */
  it('client arm: a grants-mode file names only the tracks actually granted', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'client',
      companyId: 'c1',
      request: requestRow([
        narrowRel(REL_ID, EXPERT_PROFILE_ID, 'Wei'),
        narrowRel(OTHER_REL_ID, OTHER_EXPERT_PROFILE_ID, 'Priya'),
      ]),
      tracks: [
        {
          relationshipId: REL_ID,
          expertProfileId: EXPERT_PROFILE_ID,
          access: { kind: 'live' },
          standing: { status: 'proposal_submitted', declinedAt: null, notSelectedAt: null },
        },
        {
          relationshipId: OTHER_REL_ID,
          expertProfileId: OTHER_EXPERT_PROFILE_ID,
          access: { kind: 'live' },
          standing: { status: 'proposal_submitted', declinedAt: null, notSelectedAt: null },
        },
      ],
    });
    mockListByRequest.mockResolvedValue([
      fullRel(REL_ID, EXPERT_PROFILE_ID),
      fullRel(OTHER_REL_ID, OTHER_EXPERT_PROFILE_ID),
    ]);
    mockListForRequest.mockResolvedValue([
      {
        file: fileRow({ fileName: 'NDA.pdf', audience: 'grants' }),
        grants: [{ relationshipId: REL_ID }],
      },
    ]);

    const view = await loadRequestFiles(USER, REQUEST_ID);

    if (view?.lens !== 'client') throw new Error('expected the client lens');
    const audience = view.files[0]?.audience;
    expect(audience?.type).toBe('grants');
    expect(audience?.type === 'grants' && audience.grants).toEqual([
      { relationshipId: REL_ID, trackName: 'Wei' },
    ]);
  });
});
