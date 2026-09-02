import { describe, it, expect } from 'vitest';
import {
  toExpertRequestFileView,
  toClientRequestFileView,
  toAdminRequestFileView,
  REQUEST_FILE_EXPERT_VIEW_KEYS,
  REQUEST_FILE_CLIENT_VIEW_KEYS,
  REQUEST_FILE_ADMIN_VIEW_KEYS,
  REQUEST_FILE_CONCEALED_KEYS,
  type RequestFileSerializerFile,
  type RequestFileSerializerTrack,
} from './request-file-audience-view';

/**
 * BAL-431 / ADR-1048 §3 — THE CONCEALMENT PROOF (invariant 2). Copies the STRONGER house
 * template (`packages/shared/src/meetings/recording-view.test.ts`) because this concealment is
 * security-critical, layered with `proposal-audience-view.test.ts`'s per-level assertions.
 */

const SENTINELS = {
  audience: 'SENTINEL_AUDIENCE',
  expertRelationshipId: 'SENTINEL_REL_ID',
  r2Key: 'SENTINEL_R2_KEY',
  uploadedByUserId: 'SENTINEL_UPLOADER_ID',
  deletedByUserId: 'SENTINEL_DELETER_ID',
} as const;

function overWideClientFile(): RequestFileSerializerFile & Record<string, unknown> {
  return {
    id: 'file_1',
    fileName: 'Requirements.pdf',
    contentType: 'application/pdf',
    sizeBytes: 2048,
    side: 'client',
    audience: 'all_live_tracks',
    expertRelationshipId: null,
    // ⚠ Deliberately AFTER `CLOSED_TRACK.access.closedAt` (2026-08-05) so the default fixture
    // exercises the "shared after closing — not shared" branch; the "kept access" branch gets
    // its own test below with an earlier `createdAt`.
    createdAt: new Date('2026-08-10T00:00:00Z'),
    deletedAt: null,
    deletedByUserId: null,
    // ── Everything below MUST be concealed from the EXPERT view. ──
    r2Key: SENTINELS.r2Key,
    uploadedByUserId: SENTINELS.uploadedByUserId,
  };
}

const LIVE_TRACK: RequestFileSerializerTrack = {
  relationshipId: 'rel_priya',
  expertProfileId: 'ep_priya',
  trackName: 'Priya Sharma',
  access: { kind: 'live' },
  closedReason: null,
};

const CLOSED_TRACK: RequestFileSerializerTrack = {
  relationshipId: 'rel_wei',
  expertProfileId: 'ep_wei',
  trackName: 'Wei Zhang',
  access: { kind: 'closed', closedAt: new Date('2026-08-05T00:00:00Z') },
  closedReason: 'declined',
};

describe('toExpertRequestFileView — the concealment boundary', () => {
  const viewer = {
    relationshipId: 'rel_priya',
    invitedAt: new Date('2026-07-01T00:00:00Z'),
    access: { kind: 'live' as const },
  };

  it('returns exactly the expert view key set, even from an over-wide input', () => {
    const view = toExpertRequestFileView(overWideClientFile(), 'Acme Corp', viewer);
    expect(Object.keys(view).sort()).toStrictEqual([...REQUEST_FILE_EXPERT_VIEW_KEYS].sort());
  });

  it('never serializes any concealed sentinel', () => {
    const view = toExpertRequestFileView(overWideClientFile(), 'Acme Corp', viewer);
    const json = JSON.stringify(view);
    for (const sentinel of Object.values(SENTINELS)) {
      expect(json).not.toContain(sentinel);
    }
  });

  it('never carries any of the named concealed keys', () => {
    const view = toExpertRequestFileView(
      overWideClientFile(),
      'Acme Corp',
      viewer
    ) as unknown as Record<string, unknown>;
    for (const key of REQUEST_FILE_CONCEALED_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(view, key)).toBe(false);
    }
  });

  it('carries no `audience` key or value at the root', () => {
    const view = toExpertRequestFileView(overWideClientFile(), 'Acme Corp', viewer);
    expect(Object.keys(view)).not.toContain('audience');
    expect(view).not.toHaveProperty('audience');
  });

  it('computes sharedBeforeYouJoined from dates only, never audience', () => {
    const before = toExpertRequestFileView(overWideClientFile(), 'Acme Corp', {
      ...viewer,
      invitedAt: new Date('2026-09-01T00:00:00Z'),
    });
    expect(before.sharedBeforeYouJoined).toBe(true);

    const after = toExpertRequestFileView(overWideClientFile(), 'Acme Corp', {
      ...viewer,
      invitedAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect(after.sharedBeforeYouJoined).toBe(false);
  });

  it('source is "you" for an own-track upload and "client" for a client file', () => {
    const ownFile: RequestFileSerializerFile = {
      ...overWideClientFile(),
      side: 'expert',
      audience: 'own_track',
      expertRelationshipId: 'rel_priya',
    };
    expect(toExpertRequestFileView(ownFile, 'Acme Corp', viewer).source).toBe('you');
    expect(toExpertRequestFileView(overWideClientFile(), 'Acme Corp', viewer).source).toBe(
      'client'
    );
  });

  it('canDelete is true only for a live own-track upload; false for a client file or a closed track', () => {
    const ownFile: RequestFileSerializerFile = {
      ...overWideClientFile(),
      side: 'expert',
      audience: 'own_track',
      expertRelationshipId: 'rel_priya',
    };
    expect(toExpertRequestFileView(ownFile, 'Acme Corp', viewer).canDelete).toBe(true);
    expect(toExpertRequestFileView(overWideClientFile(), 'Acme Corp', viewer).canDelete).toBe(
      false
    );
    expect(
      toExpertRequestFileView(ownFile, 'Acme Corp', {
        ...viewer,
        access: { kind: 'closed', closedAt: new Date('2026-08-05T00:00:00Z') },
      }).canDelete
    ).toBe(false);
  });
});

describe('toClientRequestFileView', () => {
  it('carries the audience block, live count and per-track annotations', () => {
    const view = toClientRequestFileView(
      overWideClientFile(),
      new Set<string>(),
      [LIVE_TRACK, CLOSED_TRACK],
      'Sarah Chen @ Acme Corp'
    );
    expect(Object.keys(view).sort()).toStrictEqual([...REQUEST_FILE_CLIENT_VIEW_KEYS].sort());
    expect(view.audience).toEqual({
      type: 'all_live_tracks',
      liveTrackCount: 1,
      annotations: [
        {
          relationshipId: 'rel_wei',
          trackName: 'Wei Zhang',
          reason: 'declined',
          keptAccess: false, // shared 2026-08-10, closed 2026-08-05 → shared AFTER closure.
        },
      ],
    });
  });

  it('keptAccess is true when the file was shared strictly before the track closed', () => {
    const earlyFile = { ...overWideClientFile(), createdAt: new Date('2026-07-01T00:00:00Z') };
    const view = toClientRequestFileView(
      earlyFile,
      new Set<string>(),
      [CLOSED_TRACK],
      'Sarah Chen @ Acme Corp'
    );
    expect(view.audience).toMatchObject({
      annotations: [expect.objectContaining({ keptAccess: true })],
    });
  });

  it('grants mode lists only the granted tracks, by relationship id', () => {
    const file = { ...overWideClientFile(), audience: 'grants' as const };
    const view = toClientRequestFileView(
      file,
      new Set(['rel_wei']),
      [LIVE_TRACK, CLOSED_TRACK],
      'Sarah Chen @ Acme Corp'
    );
    expect(view.audience).toEqual({
      type: 'grants',
      grants: [{ relationshipId: 'rel_wei', trackName: 'Wei Zhang' }],
    });
  });

  it('canDelete is true for a client file and false for an expert-uploaded file', () => {
    const clientView = toClientRequestFileView(
      overWideClientFile(),
      new Set<string>(),
      [LIVE_TRACK],
      'Sarah Chen @ Acme Corp'
    );
    expect(clientView.canDelete).toBe(true);

    const expertFile: RequestFileSerializerFile = {
      ...overWideClientFile(),
      side: 'expert',
      audience: 'own_track',
      expertRelationshipId: 'rel_priya',
    };
    const expertView = toClientRequestFileView(
      expertFile,
      new Set<string>(),
      [LIVE_TRACK],
      'Priya Sharma'
    );
    expect(expertView.canDelete).toBe(false);
    expect(expertView.audience).toEqual({ type: 'expert_own_track' });
  });
});

describe('toAdminRequestFileView', () => {
  it('carries side, audience, visibleTo and tombstone fields', () => {
    const view = toAdminRequestFileView(
      overWideClientFile(),
      'Sarah Chen @ Acme Corp',
      [{ relationshipId: 'rel_priya', trackName: 'Priya Sharma', via: 'all_live_tracks' }],
      null
    );
    expect(Object.keys(view).sort()).toStrictEqual([...REQUEST_FILE_ADMIN_VIEW_KEYS].sort());
    expect(view.deleted).toBe(false);
    expect(view.deletedAtIso).toBeNull();
    expect(view.deletedByName).toBeNull();
  });

  it('renders a tombstone with its deleter name', () => {
    const deletedFile: RequestFileSerializerFile = {
      ...overWideClientFile(),
      deletedAt: new Date('2026-08-10T00:00:00Z'),
      deletedByUserId: 'user_1',
    };
    const view = toAdminRequestFileView(deletedFile, 'Sarah Chen @ Acme Corp', [], 'Sarah Chen');
    expect(view.deleted).toBe(true);
    expect(view.deletedAtIso).toBe('2026-08-10T00:00:00.000Z');
    expect(view.deletedByName).toBe('Sarah Chen');
  });
});

describe('three-lens table — one input row, three audience-shaped outputs', () => {
  it('client and admin carry audience data; expert never does', () => {
    const file = overWideClientFile();
    const clientView = toClientRequestFileView(
      file,
      new Set<string>(),
      [LIVE_TRACK, CLOSED_TRACK],
      'Sarah Chen @ Acme Corp'
    ) as unknown as Record<string, unknown>;
    const adminView = toAdminRequestFileView(
      file,
      'Sarah Chen @ Acme Corp',
      [{ relationshipId: 'rel_priya', trackName: 'Priya Sharma', via: 'all_live_tracks' }],
      null
    ) as unknown as Record<string, unknown>;
    const expertView = toExpertRequestFileView(file, 'Acme Corp', {
      relationshipId: 'rel_priya',
      invitedAt: new Date('2026-01-01T00:00:00Z'),
      access: { kind: 'live' },
    }) as unknown as Record<string, unknown>;

    expect(clientView).toHaveProperty('audience');
    expect(adminView).toHaveProperty('audience');
    expect(adminView).toHaveProperty('visibleTo');
    expect(expertView).not.toHaveProperty('audience');
    expect(expertView).not.toHaveProperty('visibleTo');
  });
});
