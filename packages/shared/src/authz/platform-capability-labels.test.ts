import { describe, expect, it } from 'vitest';
import {
  PLATFORM_CAPABILITIES,
  PLATFORM_CAPABILITY_GROUPS,
  PLATFORM_CAPABILITY_LABELS,
  isPlatformCapability,
  platformCapabilityGroupMembers,
  platformCapabilityDisplayOrder,
  type PlatformCapability,
} from './platform';

/**
 * BAL-561 / D7 — unit tests for the platform-capability axis's DISPLAY metadata. Pure map, no
 * I/O: locks the label/group/note table so the Staff access page can never silently render a
 * token with no label, a mystery group, or copy that promises a hidden view (N3).
 */

const ALL_TOKENS = Object.values(PLATFORM_CAPABILITIES);

describe('PLATFORM_CAPABILITY_LABELS', () => {
  it('has exactly one entry per token on the axis — 19', () => {
    expect(ALL_TOKENS).toHaveLength(19);
    expect(Object.keys(PLATFORM_CAPABILITY_LABELS)).toHaveLength(19);
    for (const token of ALL_TOKENS) {
      expect(Object.hasOwn(PLATFORM_CAPABILITY_LABELS, token), `missing label for ${token}`).toBe(
        true
      );
    }
  });

  it('every name is unique and non-empty', () => {
    const names = Object.values(PLATFORM_CAPABILITY_LABELS).map((label) => label.name);
    expect(names).toHaveLength(19);
    for (const name of names) {
      expect(name.length).toBeGreaterThan(0);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it('every group is non-empty and every group key appears in PLATFORM_CAPABILITY_GROUPS', () => {
    const declaredGroupKeys = new Set(PLATFORM_CAPABILITY_GROUPS.map((group) => group.key));
    const usedGroupKeys = new Set(
      Object.values(PLATFORM_CAPABILITY_LABELS).map((label) => label.group)
    );
    expect(declaredGroupKeys.size).toBe(5);
    for (const key of usedGroupKeys) {
      expect(
        declaredGroupKeys.has(key),
        `${key} must be declared in PLATFORM_CAPABILITY_GROUPS`
      ).toBe(true);
    }
    for (const group of PLATFORM_CAPABILITY_GROUPS) {
      const membersOfGroup = Object.values(PLATFORM_CAPABILITY_LABELS).filter(
        (label) => label.group === group.key
      );
      expect(membersOfGroup.length, `${group.key} must have at least one member`).toBeGreaterThan(
        0
      );
    }
  });

  it('FAST_FORWARD_REQUEST has a note, and it is the only entry with one', () => {
    const withNotes = Object.entries(PLATFORM_CAPABILITY_LABELS).filter(
      ([, label]) => label.note !== undefined
    );
    expect(withNotes).toHaveLength(1);
    const [[key]] = withNotes;
    expect(key).toBe(PLATFORM_CAPABILITIES.FAST_FORWARD_REQUEST);
    expect(PLATFORM_CAPABILITY_LABELS[PLATFORM_CAPABILITIES.FAST_FORWARD_REQUEST].note).toBe(
      'Only works in development. Does nothing in production.'
    );
  });

  it('property: no name or note claims an override hides a page or view (N3)', () => {
    const offenders: string[] = [];
    for (const [token, label] of Object.entries(PLATFORM_CAPABILITY_LABELS)) {
      const text = `${label.name} ${label.note ?? ''}`;
      if (/\b(hide|hidden|can see|see)\b/i.test(text)) {
        offenders.push(token);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('platformCapabilityGroupMembers', () => {
  it('returns every member of a group, in the label map authored order', () => {
    const projectRequests = platformCapabilityGroupMembers('project_requests');
    expect(projectRequests).toEqual([
      PLATFORM_CAPABILITIES.CLOSE_ANY_REQUEST,
      PLATFORM_CAPABILITIES.ASSIGN_ANY_REQUEST_OWNER,
      PLATFORM_CAPABILITIES.VIEW_ANY_REQUEST_FILE,
      PLATFORM_CAPABILITIES.MANAGE_INTERNAL_NOTES,
      PLATFORM_CAPABILITIES.DELETE_ANY_INTERNAL_NOTE,
      PLATFORM_CAPABILITIES.MANAGE_ANY_REQUEST_SOURCING,
    ]);
  });

  it('every token returned actually belongs to that group', () => {
    for (const group of PLATFORM_CAPABILITY_GROUPS) {
      for (const token of platformCapabilityGroupMembers(group.key)) {
        expect(PLATFORM_CAPABILITY_LABELS[token].group).toBe(group.key);
      }
    }
  });
});

describe('platformCapabilityDisplayOrder', () => {
  it('is a permutation of the whole axis — same members, same length', () => {
    const order = platformCapabilityDisplayOrder();
    expect(order).toHaveLength(19);
    expect([...order].sort()).toEqual([...ALL_TOKENS].sort());
  });

  it('groups tokens together in PLATFORM_CAPABILITY_GROUPS order', () => {
    const order = platformCapabilityDisplayOrder();
    const groupSequence = order.map((token) => PLATFORM_CAPABILITY_LABELS[token].group);
    const expectedGroupKeys = PLATFORM_CAPABILITY_GROUPS.map((group) => group.key);
    // Collapse consecutive duplicates: the group sequence must visit each group's key once,
    // in PLATFORM_CAPABILITY_GROUPS order — proof that tokens are never interleaved across groups.
    const collapsed: string[] = [];
    for (const key of groupSequence) {
      if (collapsed[collapsed.length - 1] !== key) collapsed.push(key);
    }
    expect(collapsed).toEqual(expectedGroupKeys);
  });

  it('is exhaustive over isPlatformCapability — every returned token passes the guard', () => {
    for (const token of platformCapabilityDisplayOrder()) {
      expect(isPlatformCapability(token)).toBe(true);
    }
  });
});

describe('guards the guard', () => {
  it('platformCapabilityGroupMembers returns [] for a group with no real members would be caught', () => {
    // Every declared group has ≥1 member (asserted above); this proves the filter itself works
    // by checking a group's result is non-empty and internally consistent.
    const delivery: readonly PlatformCapability[] = platformCapabilityGroupMembers('delivery');
    expect(delivery.length).toBeGreaterThan(0);
    expect(delivery).toContain(PLATFORM_CAPABILITIES.CANCEL_ANY_MEETING);
  });
});
