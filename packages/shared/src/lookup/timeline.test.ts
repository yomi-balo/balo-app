import { describe, expect, it } from 'vitest';
// ⚠ `.js` extension deliberate — see the identical comment on this import in `./timeline.ts`.
import type { ExpertSearchabilitySource } from '../experts/checklist.js';
import { LOOKUP_ENTITY_TYPES } from './types';
import {
  AUDIT_ACTION_SENTENCES,
  EXPERT_SEARCHABILITY_SOURCE_LABEL,
  LOOKUP_AUDIT_ENTITY_TYPE,
  auditActorLabel,
  describeAuditEvent,
  humanizeActionTail,
} from './timeline';

describe('LOOKUP_AUDIT_ENTITY_TYPE', () => {
  it('is exhaustive over LOOKUP_ENTITY_TYPES', () => {
    for (const type of LOOKUP_ENTITY_TYPES) {
      expect(typeof LOOKUP_AUDIT_ENTITY_TYPE[type]).toBe('string');
    }
  });

  it('maps expert -> expert_profile (the one member that differs from its Lookup badge)', () => {
    expect(LOOKUP_AUDIT_ENTITY_TYPE.expert).toBe('expert_profile');
  });

  it('every other member maps to itself', () => {
    for (const type of LOOKUP_ENTITY_TYPES) {
      if (type === 'expert') continue;
      expect(LOOKUP_AUDIT_ENTITY_TYPE[type]).toBe(type);
    }
  });
});

describe('auditActorLabel', () => {
  it('names Balo staff with "@ Balo"', () => {
    expect(
      auditActorLabel({
        firstName: 'MJ',
        lastName: null,
        platformRole: 'admin',
        companyName: null,
        agencyName: null,
      })
    ).toBe('MJ @ Balo');
  });

  it('names a client member with "@ company"', () => {
    expect(
      auditActorLabel({
        firstName: 'Dana',
        lastName: 'Whitfield',
        platformRole: 'user',
        companyName: 'Northwind Industrial',
        agencyName: null,
      })
    ).toBe('Dana Whitfield @ Northwind Industrial');
  });

  it('names an agency expert with "@ agency"', () => {
    expect(
      auditActorLabel({
        firstName: 'Priya',
        lastName: 'Nair',
        platformRole: 'user',
        companyName: null,
        agencyName: 'CloudPeak',
      })
    ).toBe('Priya Nair @ CloudPeak');
  });

  it('an independent actor (no company, no agency) reads a bare name', () => {
    expect(
      auditActorLabel({
        firstName: 'Tom',
        lastName: 'Okafor',
        platformRole: 'user',
        companyName: null,
        agencyName: null,
      })
    ).toBe('Tom Okafor');
  });

  it('a null actor reads null, never "System"', () => {
    expect(auditActorLabel(null)).toBeNull();
  });

  it('super_admin is treated as staff too', () => {
    expect(
      auditActorLabel({
        firstName: 'Sam',
        lastName: null,
        platformRole: 'super_admin',
        companyName: 'Should be ignored',
        agencyName: null,
      })
    ).toBe('Sam @ Balo');
  });
});

describe('describeAuditEvent — mapped actions', () => {
  const cases: { action: string; metadata: Record<string, unknown>; expected: string }[] = [
    { action: 'user.workos_relinked', metadata: {}, expected: 'Sign-in identity re-linked' },
    {
      action: 'impersonation.started',
      metadata: { reason: 'Investigating a billing dispute' },
      expected: 'Impersonation started — "Investigating a billing dispute"',
    },
    {
      action: 'impersonation.stopped',
      metadata: { outcome: 'restored' },
      expected: 'Impersonation ended',
    },
    {
      action: 'impersonation.stopped',
      metadata: { outcome: 'restore_unavailable' },
      expected: 'Impersonation ended — the staff session could not be restored',
    },
    { action: 'expert_schedule.updated', metadata: {}, expected: 'Weekly schedule updated' },
    { action: 'expert_schedule.cleared', metadata: {}, expected: 'Weekly schedule cleared' },
    {
      action: 'expert_timezone.changed',
      metadata: { oldTimezone: 'Australia/Sydney', newTimezone: 'Australia/Melbourne' },
      expected: 'Timezone changed from Australia/Sydney to Australia/Melbourne',
    },
    {
      // BAL-555 fix round F2 — REAL `ExpertSearchabilitySource` members
      // (`packages/shared/src/experts/checklist.ts`), not fabricated values: the old
      // `'admin_override'`/`'checklist_incomplete'` fixtures here masked the raw-slug leak
      // because they never existed in production, so no reviewer could recognise the bug from
      // the rendered copy.
      action: 'expert_profile.searchability_granted',
      metadata: { source: 'calendar_credential_repair' },
      expected: 'Searchable again (a repaired calendar connection)',
    },
    {
      action: 'expert_profile.searchability_revoked',
      metadata: { source: 'calendar_credential_break' },
      expected: 'Removed from search (a broken calendar connection)',
    },
    {
      action: 'company.join_mode_changed',
      metadata: { from: 'invite_only', to: 'domain_auto_join' },
      expected: 'Domain join mode changed from invite_only to domain_auto_join',
    },
    {
      action: 'company.billing_email_seeded',
      metadata: { email: 'billing@northwind.com.au' },
      expected: 'Billing email set to billing@northwind.com.au',
    },
    {
      action: 'company.billing_email_changed',
      metadata: { previous_email: 'old@northwind.com.au', new_email: 'new@northwind.com.au' },
      expected: 'Billing email changed from old@northwind.com.au to new@northwind.com.au',
    },
    {
      action: 'company.promoted_to_organization',
      metadata: { domain: 'northwind.com.au' },
      expected: 'Promoted to an organization on northwind.com.au',
    },
    { action: 'agency.created', metadata: {}, expected: 'Agency created' },
    { action: 'agency.ownership_transferred', metadata: {}, expected: 'Ownership transferred' },
    {
      action: 'project_request.balo_fee_overridden',
      metadata: { previous_bps: 2500, new_bps: 2000 },
      expected: 'Balo fee overridden',
    },
    {
      action: 'project_request.owner_assigned',
      metadata: { from: null, to: 'user_1' },
      expected: 'Balo owner assigned',
    },
    {
      action: 'project_request.owner_assigned',
      metadata: { from: 'user_1', to: null },
      expected: 'Balo owner cleared',
    },
    {
      action: 'project_request.closed',
      metadata: {
        reason: 'won',
        counts: { tracksDeclined: 0, proposalsWithdrawn: 0, meetingsCancelled: 0 },
      },
      expected: 'Request closed (won)',
    },
    {
      action: 'project_request.closed',
      metadata: {
        reason: 'lost',
        counts: { tracksDeclined: 2, proposalsWithdrawn: 1, meetingsCancelled: 3 },
      },
      expected:
        'Request closed (lost), 2 tracks declined · 1 proposals withdrawn · 3 meetings cancelled',
    },
    {
      action: 'credit_session.expert_accrued',
      metadata: { connectedMinutes: 45, expertAccruedMinor: 13500 },
      expected: 'Expert accrual recorded for 45 connected minutes',
    },
    {
      action: 'credit_session.presence_settled',
      metadata: { billableMinutes: 15, floorApplied: false },
      expected: 'Settled — 15 min billed',
    },
    {
      action: 'credit_session.presence_settled',
      metadata: { billableMinutes: 15, floorApplied: true, actualMinutes: 6, floorMinutes: 15 },
      expected: 'Settled — 15 min billed, 6 min actual at the 15-minute minimum',
    },
    {
      action: 'engagement.created',
      metadata: { engagement_type: 'case' },
      expected: 'Case created',
    },
    {
      action: 'engagement.created',
      metadata: { engagement_type: 'project' },
      expected: 'Project created',
    },
    {
      action: 'engagement.milestones_snapshotted',
      metadata: {},
      expected: 'Milestones snapshotted from the accepted proposal',
    },
    {
      action: 'engagement.completion_requested',
      metadata: {},
      expected: 'Completion requested',
    },
    {
      action: 'engagement.completion_withdrawn',
      metadata: {},
      expected: 'Completion request withdrawn',
    },
    { action: 'engagement.accepted', metadata: {}, expected: 'Delivery accepted' },
    { action: 'engagement.changes_requested', metadata: {}, expected: 'Changes requested' },
    { action: 'engagement.cancelled', metadata: {}, expected: 'Engagement cancelled' },
    { action: 'engagement.case_closed', metadata: {}, expected: 'Case closed' },
    {
      action: 'engagement_milestone.reordered',
      metadata: {},
      expected: 'Milestones reordered',
    },
  ];

  it.each(cases)('$action', ({ action, metadata, expected }) => {
    expect(describeAuditEvent({ action, metadata, actorLabel: null })).toBe(expected);
  });

  it('appends the actor label with an em-dash when one is present', () => {
    expect(
      describeAuditEvent({
        action: 'agency.created',
        metadata: {},
        actorLabel: 'MJ @ Balo',
      })
    ).toBe('Agency created — MJ @ Balo');
  });
});

describe('describeAuditEvent — unmapped fallback', () => {
  it('humanizes an unmapped dotted action', () => {
    expect(
      describeAuditEvent({ action: 'party_domain.captured', metadata: {}, actorLabel: null })
    ).toBe('Domain captured');
  });

  it('humanizes an unmapped bare action', () => {
    expect(describeAuditEvent({ action: 'nonsense', metadata: {}, actorLabel: null })).toBe(
      'Nonsense'
    );
  });

  /**
   * BAL-555 fix round F5 — `AUDIT_ACTION_SENTENCES[input.action]` reaches `Object.prototype`
   * for an action string that happens to name one of its members. `'toString'` used to render
   * `"[object Undefined]"` (calling `Object.prototype.toString` with no arguments); `'constructor'`
   * used to return `Object` itself — an OBJECT from a `: string`-typed function, which React
   * throws on render. `Object.hasOwn` in `describeAuditEvent` closes both.
   */
  it('an action literally named "toString" degrades gracefully instead of reaching Object.prototype.toString', () => {
    expect(describeAuditEvent({ action: 'toString', metadata: {}, actorLabel: null })).toBe(
      'ToString'
    );
  });

  it('an action literally named "constructor" degrades gracefully instead of returning Object', () => {
    const rendered = describeAuditEvent({ action: 'constructor', metadata: {}, actorLabel: null });
    expect(typeof rendered).toBe('string');
    expect(rendered).toBe('Constructor');
  });
});

describe('humanizeActionTail', () => {
  it('party_domain.captured -> Domain captured', () => {
    expect(humanizeActionTail('party_domain.captured')).toBe('Domain captured');
  });

  it('nonsense -> Nonsense', () => {
    expect(humanizeActionTail('nonsense')).toBe('Nonsense');
  });
});

/**
 * BAL-555 fix round F2 — property test, exhaustive over the REAL `ExpertSearchabilitySource`
 * union. `EXPERT_SEARCHABILITY_SOURCE_LABEL` is typed `Record<ExpertSearchabilitySource, string>`
 * in `timeline.ts`, so `tsc` alone already refuses to compile if a member is added to the union
 * without a label here — this test iterates that TSC-enforced map's own keys (there is no
 * separate runtime array of the union to import; TypeScript types are erased) rather than a
 * second, hand-copied list that could quietly drift from the map it is meant to check.
 */
describe('property — no ExpertSearchabilitySource raw slug ever reaches the rendered sentence (F2)', () => {
  const sources = Object.keys(EXPERT_SEARCHABILITY_SOURCE_LABEL) as ExpertSearchabilitySource[];

  it('covers every real ExpertSearchabilitySource member — not zero, not a placeholder', () => {
    expect(sources.length).toBeGreaterThanOrEqual(6);
  });

  it.each(sources)('searchability_granted(%s) renders the label, never the raw slug', (source) => {
    const rendered = describeAuditEvent({
      action: 'expert_profile.searchability_granted',
      metadata: { source },
      actorLabel: null,
    });
    expect(rendered).toBe(`Searchable again (${EXPERT_SEARCHABILITY_SOURCE_LABEL[source]})`);
    expect(rendered).not.toContain(source);
  });

  it.each(sources)('searchability_revoked(%s) renders the label, never the raw slug', (source) => {
    const rendered = describeAuditEvent({
      action: 'expert_profile.searchability_revoked',
      metadata: { source },
      actorLabel: null,
    });
    expect(rendered).toBe(`Removed from search (${EXPERT_SEARCHABILITY_SOURCE_LABEL[source]})`);
    expect(rendered).not.toContain(source);
  });

  it('an unmapped/unknown source string falls back to itself rather than throwing', () => {
    const rendered = describeAuditEvent({
      action: 'expert_profile.searchability_granted',
      metadata: { source: 'some_future_source' },
      actorLabel: null,
    });
    expect(rendered).toBe('Searchable again (some_future_source)');
  });
});

const MONEY_METADATA_FIXTURE: Record<string, unknown> = {
  expertAccruedMinor: 13500,
  previous_bps: 2500,
  new_bps: 2000,
  connectedMinutes: 45,
  billableMinutes: 15,
  actualMinutes: 6,
  floorMinutes: 15,
  floorApplied: true,
  reason: 'won',
  from: 'a',
  to: 'b',
  email: 'x@y.com',
  previous_email: 'x@y.com',
  new_email: 'z@y.com',
  domain: 'y.com',
  oldTimezone: 'Australia/Sydney',
  newTimezone: 'Australia/Melbourne',
  source: 'dashboard_read',
  engagement_type: 'project',
  outcome: 'restored',
  counts: { tracksDeclined: 1, proposalsWithdrawn: 1, meetingsCancelled: 1 },
};

describe('property — no money and no fee figure, for any action, ever (C3)', () => {
  it.each(Object.keys(AUDIT_ACTION_SENTENCES))('%s renders no currency or fee figure', (action) => {
    const rendered = describeAuditEvent({
      action,
      metadata: MONEY_METADATA_FIXTURE,
      actorLabel: null,
    });
    expect(rendered).not.toContain('A$');
    expect(rendered).not.toContain('$');
    expect(rendered).not.toContain('%');
    expect(rendered).not.toContain('13500');
    expect(rendered).not.toContain('2500');
    expect(rendered).not.toContain('2000');
  });
});

const PRONOUN_WORDS = new Set(['he', 'she', 'his', 'her', 'hers', 'him']);

/** Whole-word tokens only — a naive substring check flags "the" (contains "he") as a pronoun. */
function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word.length > 0);
}

describe('property — gender-neutral by construction', () => {
  it.each(Object.keys(AUDIT_ACTION_SENTENCES))('%s contains no pronoun', (action) => {
    const rendered = describeAuditEvent({
      action,
      metadata: MONEY_METADATA_FIXTURE,
      actorLabel: 'Dana Whitfield @ Northwind Industrial',
    });
    const offenders = wordsOf(rendered).filter((word) => PRONOUN_WORDS.has(word));
    expect(offenders, `"${rendered}" contains pronoun word(s): ${offenders.join(', ')}`).toEqual(
      []
    );
  });
});
