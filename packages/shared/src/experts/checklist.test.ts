import { describe, it, expect } from 'vitest';
import {
  EXPERT_CHECKLIST_ITEM_KEYS,
  deriveExpertChecklist,
  hasLiveCalendarConnection,
  withCredentialStatusOverride,
  searchabilityTriggerFor,
  buildSearchabilityAnalyticsProperties,
  type ExpertChecklistInputs,
  type ExpertCalendarConnectionState,
} from './checklist';

// ── Helpers ──────────────────────────────────────────────────────

/** A complete set of inputs — every one of the six items satisfied. */
function completeInputs(overrides: Partial<ExpertChecklistInputs> = {}): ExpertChecklistInputs {
  return {
    headline: 'Salesforce Architect',
    bio: 'Ten years building on the platform.',
    avatarUrl: 'https://cdn.example.com/avatar.png',
    phoneVerifiedAt: new Date('2026-01-01T00:00:00Z'),
    rateCents: 313,
    calendarConnections: [{ id: 'conn-1', credentialStatus: 'ACTIVE' }],
    hasActiveAvailabilityRules: true,
    hasPayoutDetails: true,
    ...overrides,
  };
}

function connection(id: string, credentialStatus: string): ExpertCalendarConnectionState {
  return { id, credentialStatus };
}

// ── T1.1 / T1.2 — hasLiveCalendarConnection (D4 ANY-ACTIVE) ────────

describe('hasLiveCalendarConnection', () => {
  it('is false for EXPIRED, REVOKED, SYNC_PENDING, and no connections at all', () => {
    expect(hasLiveCalendarConnection([connection('g', 'EXPIRED')])).toBe(false);
    expect(hasLiveCalendarConnection([connection('g', 'REVOKED')])).toBe(false);
    expect(hasLiveCalendarConnection([connection('g', 'SYNC_PENDING')])).toBe(false);
    expect(hasLiveCalendarConnection([])).toBe(false);
  });

  it('is true when ANY connection in the set is ACTIVE (D4)', () => {
    expect(hasLiveCalendarConnection([connection('g', 'EXPIRED'), connection('m', 'ACTIVE')])).toBe(
      true
    );
  });
});

describe('deriveExpertChecklist — the calendar item', () => {
  it('D4: an expired Google (oldest) + a healthy Microsoft → calendar true, allComplete true', () => {
    const derivation = deriveExpertChecklist(
      completeInputs({
        calendarConnections: [connection('g', 'EXPIRED'), connection('m', 'ACTIVE')],
      })
    );
    expect(derivation.items.calendar).toBe(true);
    expect(derivation.allComplete).toBe(true);
  });

  it('marks calendar incomplete for a non-ACTIVE credential status (EXPIRED)', () => {
    const derivation = deriveExpertChecklist(
      completeInputs({ calendarConnections: [connection('g', 'EXPIRED')] })
    );
    expect(derivation.items.calendar).toBe(false);
    expect(derivation.failingItems).toContain('calendar');
  });

  it('marks calendar incomplete when there are no connections', () => {
    const derivation = deriveExpertChecklist(completeInputs({ calendarConnections: [] }));
    expect(derivation.items.calendar).toBe(false);
  });
});

// ── T1.3 — each item regressing individually ────────────────────

describe('deriveExpertChecklist — each item regressing knocks out allComplete', () => {
  const cases: Array<{
    key: (typeof EXPERT_CHECKLIST_ITEM_KEYS)[number];
    overrides: Partial<ExpertChecklistInputs>;
  }> = [
    { key: 'profile', overrides: { headline: null } },
    { key: 'profile', overrides: { bio: '   ' } },
    { key: 'profile', overrides: { avatarUrl: null } },
    { key: 'phone', overrides: { phoneVerifiedAt: null } },
    { key: 'rate', overrides: { rateCents: null } },
    { key: 'rate', overrides: { rateCents: 0 } },
    { key: 'calendar', overrides: { calendarConnections: [] } },
    { key: 'availability', overrides: { hasActiveAvailabilityRules: false } },
    { key: 'payouts', overrides: { hasPayoutDetails: false } },
  ];

  it.each(cases)(
    'knocking out $key leaves exactly that key in failingItems',
    ({ key, overrides }) => {
      const derivation = deriveExpertChecklist(completeInputs(overrides));
      expect(derivation.items[key]).toBe(false);
      expect(derivation.allComplete).toBe(false);
      expect(derivation.failingItems).toEqual([key]);
      expect(derivation.completedCount).toBe(EXPERT_CHECKLIST_ITEM_KEYS.length - 1);
    }
  );

  it('is allComplete with completedCount 6 and an empty failingItems array when every item passes', () => {
    const derivation = deriveExpertChecklist(completeInputs());
    expect(derivation.allComplete).toBe(true);
    expect(derivation.completedCount).toBe(6);
    expect(derivation.failingItems).toEqual([]);
  });

  it('does not require the number 6 to be hardcoded — derives from EXPERT_CHECKLIST_ITEM_KEYS', () => {
    expect(EXPERT_CHECKLIST_ITEM_KEYS).toHaveLength(6);
  });
});

// ── S1 (fix round 1) — a soft-deleted user forces allComplete false ─

describe('deriveExpertChecklist — S1, a soft-deleted user', () => {
  it('is allComplete: false when every checklist item passes but the user is soft-deleted', () => {
    const derivation = deriveExpertChecklist(
      completeInputs({ userDeletedAt: new Date('2026-08-01T00:00:00Z') })
    );
    expect(derivation.allComplete).toBe(false);
    // The six-item vocabulary is unaffected — this is not a seventh checklist item the
    // expert can "fix" from their settings page.
    expect(derivation.items).toEqual({
      profile: true,
      phone: true,
      rate: true,
      calendar: true,
      availability: true,
      payouts: true,
    });
    expect(derivation.failingItems).toEqual([]);
  });

  it('is allComplete: true when userDeletedAt is null (the live default)', () => {
    const derivation = deriveExpertChecklist(completeInputs({ userDeletedAt: null }));
    expect(derivation.allComplete).toBe(true);
  });

  it('defaults to live (allComplete unaffected) when userDeletedAt is absent entirely', () => {
    const derivation = deriveExpertChecklist(completeInputs());
    expect(derivation.allComplete).toBe(true);
  });
});

// ── T1.4 — withCredentialStatusOverride ─────────────────────────

describe('withCredentialStatusOverride', () => {
  it('replaces only the named connection id, without mutating the input array', () => {
    const original = [connection('g', 'ACTIVE'), connection('m', 'ACTIVE')];
    const next = withCredentialStatusOverride(original, 'g', 'EXPIRED');

    expect(next).toEqual([connection('g', 'EXPIRED'), connection('m', 'ACTIVE')]);
    // Original untouched.
    expect(original).toEqual([connection('g', 'ACTIVE'), connection('m', 'ACTIVE')]);
    expect(next).not.toBe(original);
  });

  it('is a no-op (returns an equivalent, new array) when the id is not present', () => {
    const original = [connection('g', 'ACTIVE')];
    const next = withCredentialStatusOverride(original, 'unknown-id', 'EXPIRED');
    expect(next).toEqual(original);
    expect(next).not.toBe(original);
  });
});

// ── searchabilityTriggerFor ──────────────────────────────────────

describe('searchabilityTriggerFor', () => {
  it('derives the trigger from the NEW boolean, never a stored direction', () => {
    expect(searchabilityTriggerFor(true)).toBe('checklist_complete');
    expect(searchabilityTriggerFor(false)).toBe('checklist_regressed');
  });
});

// ── buildSearchabilityAnalyticsProperties ────────────────────────

describe('buildSearchabilityAnalyticsProperties', () => {
  it('builds the exact D7 property bag, with distinct_id set to expertProfileId', () => {
    const props = buildSearchabilityAnalyticsProperties({
      expertProfileId: 'profile-1',
      searchable: false,
      previousSearchable: true,
      failingItems: ['calendar', 'payouts'],
    });

    expect(props).toEqual({
      expert_id: 'profile-1',
      searchable: false,
      trigger: 'checklist_regressed',
      failing_items: ['calendar', 'payouts'],
      previous_state: true,
      distinct_id: 'profile-1',
    });
  });

  it('failing_items is always present and empty when searchable', () => {
    const props = buildSearchabilityAnalyticsProperties({
      expertProfileId: 'profile-1',
      searchable: true,
      previousSearchable: false,
      failingItems: [],
    });
    expect(props.failing_items).toEqual([]);
    expect(props.trigger).toBe('checklist_complete');
  });
});
