import { describe, it, expect } from 'vitest';

import {
  resolveRequestTrackFileAccess,
  requestTrackIsLiveForFiles,
  trackCanReadAllAudienceShare,
  requestFileVisibleToTrack,
  resolveRequestFileAudience,
  type RequestFileAudienceFacts,
  type RequestTrackFileStanding,
  type RequestTrackRef,
} from './request-files';
import { relationshipDeniesHosting } from './engagement';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-02-01T00:00:00.000Z');
const T2 = new Date('2026-03-01T00:00:00.000Z');
const T3 = new Date('2026-04-01T00:00:00.000Z');

function standing(over: Partial<RequestTrackFileStanding> = {}): RequestTrackFileStanding {
  return {
    status: 'proposal_submitted',
    declinedAt: null,
    deletedAt: null,
    notSelectedAt: null,
    ...over,
  };
}

function track(over: Partial<RequestTrackRef> = {}): RequestTrackRef {
  return {
    relationshipId: 'rel_1',
    expertProfileId: 'exp_1',
    access: { kind: 'live' },
    ...over,
  };
}

function clientFile(over: Partial<RequestFileAudienceFacts> = {}): RequestFileAudienceFacts {
  return {
    side: 'client',
    audience: 'all_live_tracks',
    expertRelationshipId: null,
    createdAt: T1,
    deletedAt: null,
    ...over,
  };
}

describe('resolveRequestTrackFileAccess', () => {
  /**
   * ⚠ THE HEADLINE SCENARIO (ADR-1048 §1). A track at `invited` is LIVE for files, so a late
   * invitee inherits every prior share-to-all the moment their track exists. This is exactly
   * where "live for files" diverges from `isThreadOpenStatus`, which excludes `invited` by
   * design and is pinned by its own test in `apps/web`. Do not reconcile the two.
   */
  it('treats `invited` as LIVE — the late-invitee headline scenario', () => {
    expect(resolveRequestTrackFileAccess(standing({ status: 'invited' }))).toEqual({
      kind: 'live',
    });
    expect(requestTrackIsLiveForFiles(standing({ status: 'invited' }))).toBe(true);
  });

  it.each([
    ['invited'],
    ['eoi_submitted'],
    ['proposal_requested'],
    ['proposal_submitted'],
    ['accepted'],
  ])('treats a non-declined, non-deleted, non-swept `%s` track as live', (status) => {
    expect(requestTrackIsLiveForFiles(standing({ status }))).toBe(true);
  });

  it('closes a DECLINED track at `declinedAt`', () => {
    expect(resolveRequestTrackFileAccess(standing({ status: 'declined', declinedAt: T2 }))).toEqual(
      {
        kind: 'closed',
        closedAt: T2,
      }
    );
  });

  it('closes a WITHDRAWN (soft-deleted) track at `deletedAt`', () => {
    expect(resolveRequestTrackFileAccess(standing({ deletedAt: T2 }))).toEqual({
      kind: 'closed',
      closedAt: T2,
    });
  });

  it('closes a NOT-SELECTED (closed-by-award) track at `notSelectedAt`', () => {
    expect(resolveRequestTrackFileAccess(standing({ notSelectedAt: T2 }))).toEqual({
      kind: 'closed',
      closedAt: T2,
    });
  });

  /**
   * ⚠ FAIL CLOSED. A partial write — the enum label says `declined` but `declined_at` was
   * never stamped — names no instant, so NO historical read is granted. Nothing can be
   * ordered against an unknown.
   */
  it('fails closed when the row says closed but names no instant', () => {
    const access = resolveRequestTrackFileAccess(
      standing({ status: 'declined', declinedAt: null })
    );
    expect(access).toEqual({ kind: 'closed', closedAt: null });
    expect(trackCanReadAllAudienceShare(access, T0)).toBe(false);
  });

  it('takes the EARLIEST instant when two or three are set', () => {
    expect(
      resolveRequestTrackFileAccess(
        standing({ status: 'declined', declinedAt: T2, deletedAt: T1, notSelectedAt: T3 })
      )
    ).toEqual({ kind: 'closed', closedAt: T1 });

    expect(
      resolveRequestTrackFileAccess(
        standing({ status: 'declined', declinedAt: T1, notSelectedAt: T3 })
      )
    ).toEqual({ kind: 'closed', closedAt: T1 });
  });

  /**
   * ⚠ REUSE, NOT REDEFINITION (CLAUDE.md / Ruling 2). The declined arm is
   * `relationshipDeniesHosting` and nothing else. Feed rows where the two representations
   * DISAGREE in each direction: both must close, and both must agree with the shared
   * predicate — which is what makes "there is no second definition of declined" testable
   * rather than merely asserted in a comment.
   */
  it.each([
    ['label only', { status: 'declined', declinedAt: null }],
    ['timestamp only', { status: 'proposal_submitted', declinedAt: T2 }],
  ])('delegates the declined arm to relationshipDeniesHosting (%s)', (_label, over) => {
    const row = standing(over);
    expect(relationshipDeniesHosting(row)).toBe(true);
    expect(resolveRequestTrackFileAccess(row).kind).toBe('closed');
    expect(requestTrackIsLiveForFiles(row)).toBe(false);
  });

  it('does NOT consult `declinedAt` when the predicate says the track is not declined', () => {
    // A live row can never reach the instant-collection branch, so a stray timestamp on a
    // non-declined row is impossible by construction — assert the live short-circuit holds.
    const row = standing({ status: 'accepted', declinedAt: null });
    expect(relationshipDeniesHosting(row)).toBe(false);
    expect(resolveRequestTrackFileAccess(row)).toEqual({ kind: 'live' });
  });
});

describe('trackCanReadAllAudienceShare', () => {
  it('grants everything to a live track', () => {
    expect(trackCanReadAllAudienceShare({ kind: 'live' }, T3)).toBe(true);
  });

  it('grants a share made strictly BEFORE closure — decline ends the future, not the past', () => {
    expect(trackCanReadAllAudienceShare({ kind: 'closed', closedAt: T2 }, T1)).toBe(true);
  });

  it('denies a share made AFTER closure', () => {
    expect(trackCanReadAllAudienceShare({ kind: 'closed', closedAt: T2 }, T3)).toBe(false);
  });

  /** ⚠ STRICT `<`. A share landing at exactly `closedAt` is NOT readable. */
  it('denies a share made at EXACTLY the closure instant', () => {
    expect(trackCanReadAllAudienceShare({ kind: 'closed', closedAt: T2 }, new Date(T2))).toBe(
      false
    );
  });
});

describe('requestFileVisibleToTrack', () => {
  const NO_GRANTS: ReadonlySet<string> = new Set();

  it('hides a TOMBSTONE from every track, on every audience', () => {
    for (const audience of ['all_live_tracks', 'grants'] as const) {
      expect(
        requestFileVisibleToTrack(
          clientFile({ audience, deletedAt: T3 }),
          track(),
          new Set(['rel_1'])
        )
      ).toBe(false);
    }
  });

  /**
   * ⚠ THE CROSS-TRACK INVARIANT (ADR-1048 §7), as a pure rule. A sibling candidate's upload
   * is never visible: the comparison is against the viewer's OWN relationship id, taken from
   * the gate.
   */
  it('shows an expert file to its OWN track and to no other', () => {
    const own: RequestFileAudienceFacts = {
      side: 'expert',
      audience: 'own_track',
      expertRelationshipId: 'rel_1',
      createdAt: T1,
      deletedAt: null,
    };
    expect(requestFileVisibleToTrack(own, track({ relationshipId: 'rel_1' }), NO_GRANTS)).toBe(
      true
    );
    expect(requestFileVisibleToTrack(own, track({ relationshipId: 'rel_2' }), NO_GRANTS)).toBe(
      false
    );
  });

  it('fails closed for an expert file with no named track', () => {
    expect(
      requestFileVisibleToTrack(
        {
          side: 'expert',
          audience: 'own_track',
          expertRelationshipId: null,
          createdAt: T1,
          deletedAt: null,
        },
        track(),
        NO_GRANTS
      )
    ).toBe(false);
  });

  it('shows a GRANTS file only to granted tracks — and does so even after closure', () => {
    const file = clientFile({ audience: 'grants' });
    const granted = new Set(['rel_1']);

    expect(requestFileVisibleToTrack(file, track({ relationshipId: 'rel_1' }), granted)).toBe(true);
    expect(requestFileVisibleToTrack(file, track({ relationshipId: 'rel_2' }), granted)).toBe(
      false
    );

    // ⚠ Grants survive closure UNCONDITIONALLY — asserted directly rather than relying on
    // "a new grant to a closed track is impossible" ordering.
    const closed = track({
      relationshipId: 'rel_1',
      access: { kind: 'closed', closedAt: T0 },
    });
    expect(requestFileVisibleToTrack(file, closed, granted)).toBe(true);
  });

  it('applies the historical-read inequality to an ALL_LIVE_TRACKS file', () => {
    const file = clientFile({ createdAt: T1 });
    expect(requestFileVisibleToTrack(file, track(), NO_GRANTS)).toBe(true);
    expect(
      requestFileVisibleToTrack(
        file,
        track({ access: { kind: 'closed', closedAt: T2 } }),
        NO_GRANTS
      )
    ).toBe(true);
    expect(
      requestFileVisibleToTrack(
        file,
        track({ access: { kind: 'closed', closedAt: T0 } }),
        NO_GRANTS
      )
    ).toBe(false);
    expect(
      requestFileVisibleToTrack(
        file,
        track({ access: { kind: 'closed', closedAt: null } }),
        NO_GRANTS
      )
    ).toBe(false);
  });

  /** `own_track` on a CLIENT file is unrepresentable in the DB (CHECK) — fail closed anyway. */
  it('fails closed on the unrepresentable client/own_track combination', () => {
    expect(
      requestFileVisibleToTrack(clientFile({ audience: 'own_track' }), track(), new Set(['rel_1']))
    ).toBe(false);
  });
});

describe('resolveRequestFileAudience', () => {
  const TRACKS: RequestTrackRef[] = [
    track({ relationshipId: 'rel_1', expertProfileId: 'exp_1' }),
    track({ relationshipId: 'rel_2', expertProfileId: 'exp_2' }),
    track({
      relationshipId: 'rel_3',
      expertProfileId: 'exp_3',
      access: { kind: 'closed', closedAt: T0 },
    }),
  ];

  it('labels an ALL_LIVE_TRACKS share with `all_live_tracks` and excludes the closed track', () => {
    expect(resolveRequestFileAudience(clientFile({ createdAt: T1 }), TRACKS, new Set())).toEqual([
      { relationshipId: 'rel_1', expertProfileId: 'exp_1', via: 'all_live_tracks' },
      { relationshipId: 'rel_2', expertProfileId: 'exp_2', via: 'all_live_tracks' },
    ]);
  });

  it('labels explicit grants with `grant`', () => {
    expect(
      resolveRequestFileAudience(
        clientFile({ audience: 'grants' }),
        TRACKS,
        new Set(['rel_2', 'rel_3'])
      )
    ).toEqual([
      { relationshipId: 'rel_2', expertProfileId: 'exp_2', via: 'grant' },
      { relationshipId: 'rel_3', expertProfileId: 'exp_3', via: 'grant' },
    ]);
  });

  it('labels an expert own-track file with `own_track`', () => {
    expect(
      resolveRequestFileAudience(
        {
          side: 'expert',
          audience: 'own_track',
          expertRelationshipId: 'rel_2',
          createdAt: T1,
          deletedAt: null,
        },
        TRACKS,
        new Set()
      )
    ).toEqual([{ relationshipId: 'rel_2', expertProfileId: 'exp_2', via: 'own_track' }]);
  });

  /**
   * ⚠ THE ANTI-DRIFT PIN, and it is what makes the DELETE audit snapshot trustworthy:
   * `audit_events` is append-only (Ruling 4), so a snapshot computed by a second rule that
   * drifted from the read rule would be unrecoverably wrong. Asserted over a generated
   * table rather than by inspection.
   */
  it('is exactly `tracks.filter(requestFileVisibleToTrack)` over the full matrix', () => {
    const sides = ['client', 'expert'] as const;
    const audiences = ['all_live_tracks', 'grants', 'own_track'] as const;
    const relIds = [null, 'rel_1', 'rel_2', 'rel_3'];
    const deletions = [null, T3];
    const grantSets = [new Set<string>(), new Set(['rel_1']), new Set(['rel_2', 'rel_3'])];

    for (const side of sides) {
      for (const audience of audiences) {
        for (const expertRelationshipId of relIds) {
          for (const deletedAt of deletions) {
            for (const grants of grantSets) {
              const file: RequestFileAudienceFacts = {
                side,
                audience,
                expertRelationshipId,
                createdAt: T1,
                deletedAt,
              };
              const expected = TRACKS.filter((t) => requestFileVisibleToTrack(file, t, grants)).map(
                (t) => t.relationshipId
              );
              expect(
                resolveRequestFileAudience(file, TRACKS, grants).map((e) => e.relationshipId)
              ).toEqual(expected);
            }
          }
        }
      }
    }
  });
});
