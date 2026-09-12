import { describe, it, expect } from 'vitest';
import {
  ADMIN_ALERT_KIND_KEYS,
  ADMIN_ALERT_KINDS,
  ADMIN_ALERT_CADENCES,
  ADMIN_ALERT_GROUP_ORDER,
  ADMIN_ALERT_SWEEP_SENTINEL_ENTITY_ID,
  NOTE_CLOSEABLE_KINDS,
  isKnownAdminAlertKind,
  isNoteCloseableKind,
  adminAlertKindsForCadence,
  stormKindFor,
  baseKindOfStormKind,
  isStormKind,
  resolveAdminAlertKind,
  type AdminAlertGroup,
} from './index';

/**
 * BAL-548 / ADR-1055 — unit coverage for the pure kind registry. Pure data + pure functions —
 * no mocks.
 */

const ALL_GROUPS: readonly AdminAlertGroup[] = [...ADMIN_ALERT_GROUP_ORDER, 'platform'];

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('ADMIN_ALERT_KINDS — the registry', () => {
  it('has exactly the twelve v1 kinds (seven finder + four event-driven + sweep.failed)', () => {
    expect(ADMIN_ALERT_KIND_KEYS).toHaveLength(12);
    expect(new Set(ADMIN_ALERT_KIND_KEYS).size).toBe(12);
  });

  it('has exactly seven finder kinds', () => {
    const finderKinds = ADMIN_ALERT_KIND_KEYS.filter((k) => ADMIN_ALERT_KINDS[k].finder !== null);
    expect(finderKinds).toHaveLength(7);
  });

  it('finder === null iff cadence === null, for every kind', () => {
    for (const kind of ADMIN_ALERT_KIND_KEYS) {
      const meta = ADMIN_ALERT_KINDS[kind];
      if (meta.finder === null) {
        expect(meta.cadence, `${kind}: finder is null but cadence is not`).toBeNull();
      } else {
        expect(meta.cadence, `${kind}: finder is set but cadence is null`).not.toBeNull();
      }
    }
  });

  it('every kind belongs to a real group', () => {
    for (const kind of ADMIN_ALERT_KIND_KEYS) {
      expect(ALL_GROUPS).toContain(ADMIN_ALERT_KINDS[kind].group);
    }
  });

  it('every kind has non-empty closes copy', () => {
    for (const kind of ADMIN_ALERT_KIND_KEYS) {
      expect(ADMIN_ALERT_KINDS[kind].closes.length).toBeGreaterThan(0);
    }
  });

  it('every target() returns an in-app href starting with "/"', () => {
    for (const kind of ADMIN_ALERT_KIND_KEYS) {
      const target = ADMIN_ALERT_KINDS[kind].target({
        entityId: '11111111-1111-4111-8111-111111111111',
        detail: { title: 't', entityLabel: 'e', evidence: 'ev', facts: [] },
      });
      expect(target.href.startsWith('/')).toBe(true);
      expect(target.label.length).toBeGreaterThan(0);
    }
  });

  /**
   * BAL-550 / D3 — retargeted to the capture-health detail lens, keyed on the meeting id.
   * `targetMeetingViaTargetId` (still used by `session.settled_no_ledger_credit`) is covered by
   * its own kind's test elsewhere; this one pins the NEW `targetCaptureHealthViaTargetId`
   * behaviour for all three capture kinds, including the no-`targetId` fallback (D3: no `??
   * entityId`, deliberately — the unfiltered lens opens instead of a dead-end row).
   */
  it.each(['recording.failed', 'transcript.failed', 'transcript_capture.withheld_source'] as const)(
    '%s targets the capture-health lens, keyed on detail.targetId',
    (kind) => {
      const target = ADMIN_ALERT_KINDS[kind].target({
        entityId: 'recording-or-transcript-id',
        detail: {
          title: 't',
          entityLabel: 'e',
          evidence: 'ev',
          facts: [],
          targetId: 'meeting-id',
        },
      });
      expect(target.href).toBe('/admin/health/capture?row=meeting-id');

      const withoutTargetId = ADMIN_ALERT_KINDS[kind].target({
        entityId: 'recording-or-transcript-id',
        detail: { title: 't', entityLabel: 'e', evidence: 'ev', facts: [] },
      });
      expect(withoutTargetId.href).toBe('/admin/health/capture');
    }
  );

  it('DOES NOT stub a deferred kind', () => {
    const deferred = [
      'project.request_unmatched',
      'review.published',
      'payout.due',
      'dispute.opened',
      'meeting.cancelled_after_start',
    ];
    for (const kind of deferred) {
      expect(isKnownAdminAlertKind(kind)).toBe(false);
    }
  });
});

describe('NOTE_CLOSEABLE_KINDS', () => {
  it('is exactly the finder:null kinds', () => {
    const expected = ADMIN_ALERT_KIND_KEYS.filter((k) => ADMIN_ALERT_KINDS[k].finder === null);
    expect([...NOTE_CLOSEABLE_KINDS].sort()).toEqual([...expected].sort());
  });

  it('isNoteCloseableKind agrees with the set', () => {
    for (const kind of ADMIN_ALERT_KIND_KEYS) {
      expect(isNoteCloseableKind(kind)).toBe(NOTE_CLOSEABLE_KINDS.includes(kind));
    }
  });
});

describe('adminAlertKindsForCadence', () => {
  it('partitions the finder kinds with no overlap and no gap', () => {
    const finderKinds = ADMIN_ALERT_KIND_KEYS.filter((k) => ADMIN_ALERT_KINDS[k].finder !== null);
    const partitioned = ADMIN_ALERT_CADENCES.flatMap((cadence) =>
      adminAlertKindsForCadence(cadence)
    );
    expect([...partitioned].sort()).toEqual([...finderKinds].sort());
    // No overlap: every finder kind appears under exactly one cadence.
    expect(new Set(partitioned).size).toBe(partitioned.length);
  });

  it('returns only kinds whose registered cadence matches', () => {
    for (const cadence of ADMIN_ALERT_CADENCES) {
      for (const kind of adminAlertKindsForCadence(cadence)) {
        expect(ADMIN_ALERT_KINDS[kind].cadence).toBe(cadence);
      }
    }
  });
});

describe('isKnownAdminAlertKind — membership safety', () => {
  it('is true for every registered kind', () => {
    for (const kind of ADMIN_ALERT_KIND_KEYS) {
      expect(isKnownAdminAlertKind(kind)).toBe(true);
    }
  });

  it('rejects prototype-pollution-shaped strings', () => {
    expect(isKnownAdminAlertKind('__proto__')).toBe(false);
    expect(isKnownAdminAlertKind('constructor')).toBe(false);
    expect(isKnownAdminAlertKind('toString')).toBe(false);
    expect(isKnownAdminAlertKind('hasOwnProperty')).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(isKnownAdminAlertKind('nonsense.kind')).toBe(false);
  });
});

describe('storm helpers', () => {
  it('round-trip: baseKindOfStormKind(stormKindFor(k)) === k, for every kind', () => {
    for (const kind of ADMIN_ALERT_KIND_KEYS) {
      expect(baseKindOfStormKind(stormKindFor(kind))).toBe(kind);
    }
  });

  it('stormKindFor appends the suffix', () => {
    expect(stormKindFor('recording.failed')).toBe('recording.failed.storm');
  });

  it('baseKindOfStormKind returns null for a non-storm string', () => {
    expect(baseKindOfStormKind('recording.failed')).toBeNull();
  });

  it('baseKindOfStormKind returns null when the base is not a known kind', () => {
    expect(baseKindOfStormKind('nonsense.kind.storm')).toBeNull();
  });

  it('isStormKind agrees with baseKindOfStormKind', () => {
    expect(isStormKind('recording.failed.storm')).toBe(true);
    expect(isStormKind('recording.failed')).toBe(false);
    expect(isStormKind('nonsense.kind.storm')).toBe(false);
  });
});

describe('resolveAdminAlertKind', () => {
  it('resolves a registered kind, non-storm', () => {
    const resolved = resolveAdminAlertKind('recording.failed');
    expect(resolved).not.toBeNull();
    expect(resolved?.baseKind).toBe('recording.failed');
    expect(resolved?.isStorm).toBe(false);
    expect(resolved?.meta).toBe(ADMIN_ALERT_KINDS['recording.failed']);
  });

  it('resolves a derived storm kind, inheriting the base meta', () => {
    const resolved = resolveAdminAlertKind('recording.failed.storm');
    expect(resolved).not.toBeNull();
    expect(resolved?.baseKind).toBe('recording.failed');
    expect(resolved?.isStorm).toBe(true);
    expect(resolved?.meta).toBe(ADMIN_ALERT_KINDS['recording.failed']);
  });

  it('returns null for an unresolvable string', () => {
    expect(resolveAdminAlertKind('nonsense')).toBeNull();
    expect(resolveAdminAlertKind('__proto__')).toBeNull();
  });
});

describe('the sweep sentinel', () => {
  it('is a valid v4 uuid literal', () => {
    expect(ADMIN_ALERT_SWEEP_SENTINEL_ENTITY_ID).toMatch(UUID_V4_RE);
  });
});
