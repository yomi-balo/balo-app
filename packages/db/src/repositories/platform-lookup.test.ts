import { describe, it, expect } from 'vitest';
import { LOOKUP_ENTITY_TYPES, type LookupEntityType, type LookupResult } from '@balo/shared/lookup';
import {
  LOOKUP_ARM_LIMIT,
  LOOKUP_MIN_QUERY_LENGTH,
  LOOKUP_RESULT_CAP,
  buildAgencySub,
  buildCompanySub,
  buildCreditSessionSub,
  buildCreditSessionTitle,
  buildEngagementSub,
  buildEngagementTitle,
  buildExpertSub,
  buildProjectRequestSub,
  buildUserSub,
  escapeLikePattern,
  formatMinorAmount,
  formatShortDate,
  humanizeEnumLabel,
  isLookupUuid,
  joinNameParts,
  mergeLookupResults,
  normalizeLookupQuery,
  toContainsPattern,
} from './platform-lookup';

/**
 * Unit tests for the PURE half of `platform-lookup.ts` — the pattern escape, the query
 * normaliser, the full-uuid gate, the round-robin merge and every sub-line composer. No
 * database: the arms themselves are covered by `platform-lookup.integration.test.ts`.
 *
 * Precedent for a plain `.test.ts` beside a repository: `expert-search.filters.test.ts`,
 * `calendar.test.ts`.
 */

// The U+2212 MINUS SIGN the overdrawn wallet renders — spelled by escape so the assertion
// cannot be silently "fixed" into an ASCII hyphen by an editor.
const MINUS = '−';

describe('escapeLikePattern', () => {
  it('escapes a typed % so it is a literal, not a wildcard', () => {
    // MUTATION: delete the `%` branch in escapeLikePattern and this fails.
    expect(escapeLikePattern('50% off')).toBe('50\\% off');
  });

  it('escapes a typed _ so a PaymentIntent id does not wildcard a character', () => {
    // MUTATION: delete the `_` branch and this fails — `pi_3Nq` would then match `piX3Nq`.
    expect(escapeLikePattern('pi_3Nq')).toBe('pi\\_3Nq');
  });

  it('escapes a typed backslash before anything else can consume it', () => {
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
  });

  it('leaves an ordinary query untouched', () => {
    expect(escapeLikePattern('northwind')).toBe('northwind');
  });

  it('escapes every occurrence, not just the first', () => {
    expect(escapeLikePattern('%_%')).toBe('\\%\\_\\%');
  });
});

describe('toContainsPattern', () => {
  it('wraps the escaped value in unescaped wildcards', () => {
    expect(toContainsPattern('north')).toBe('%north%');
  });

  it('keeps the user metacharacters escaped inside the wildcards', () => {
    expect(toContainsPattern('50%')).toBe('%50\\%%');
  });
});

describe('normalizeLookupQuery', () => {
  it('trims, lowercases and collapses internal whitespace', () => {
    expect(normalizeLookupQuery('  Dana   Whitfield ')).toBe('dana whitfield');
  });

  it('collapses tabs and newlines the same as spaces', () => {
    expect(normalizeLookupQuery('dana\t\nwhit')).toBe('dana whit');
  });

  it('returns the empty string for a whitespace-only query', () => {
    expect(normalizeLookupQuery('   \t\n ')).toBe('');
  });

  it('leaves a single token unchanged apart from case', () => {
    expect(normalizeLookupQuery('NorthWind')).toBe('northwind');
  });

  it('produces a value shorter than the minimum for a one-character query', () => {
    expect(normalizeLookupQuery(' A ').length).toBeLessThan(LOOKUP_MIN_QUERY_LENGTH);
  });
});

describe('isLookupUuid', () => {
  const UUID = '3f6b1d2e-9c41-4a7b-8f10-2c5e7a9d4b63';

  it('accepts a full canonical uuid', () => {
    expect(isLookupUuid(UUID)).toBe(true);
  });

  it('accepts an uppercase uuid once it has been normalised', () => {
    expect(isLookupUuid(normalizeLookupQuery(UUID.toUpperCase()))).toBe(true);
  });

  it('rejects a TRUNCATED uuid — the no-prefix-match ruling', () => {
    expect(isLookupUuid(UUID.slice(0, 8))).toBe(false);
    expect(isLookupUuid(UUID.slice(0, 30))).toBe(false);
  });

  it('rejects the right group count with a wrong group length', () => {
    expect(isLookupUuid('3f6b1d2e-9c41-4a7b-8f10-2c5e7a9d4b6')).toBe(false);
  });

  it('rejects a non-hex character in an otherwise well-shaped value', () => {
    expect(isLookupUuid('3f6b1d2g-9c41-4a7b-8f10-2c5e7a9d4b63')).toBe(false);
  });

  it('rejects an ordinary word and an email', () => {
    expect(isLookupUuid('northwind')).toBe(false);
    expect(isLookupUuid('dana@northwind.com.au')).toBe(false);
  });
});

// ── merge ────────────────────────────────────────────────────────────────────────────

function row(type: LookupEntityType, n: number): LookupResult {
  return {
    id: `${type}-${n}`,
    type,
    title: `${type} ${n}`,
    sub: 'sub',
    publicExpertUsername: null,
    engagementType: null,
  };
}

function arm(type: LookupEntityType, size: number): readonly LookupResult[] {
  return Array.from({ length: size }, (_, i) => row(type, i));
}

describe('mergeLookupResults', () => {
  it('returns an empty, untruncated result for no arms', () => {
    expect(mergeLookupResults(new Map(), LOOKUP_RESULT_CAP)).toEqual({
      results: [],
      truncated: false,
    });
  });

  it('interleaves the arms in LOOKUP_ENTITY_TYPES order, one row each per round', () => {
    const merged = mergeLookupResults(
      new Map([
        ['company', arm('company', 2)],
        ['user', arm('user', 2)],
      ]),
      LOOKUP_RESULT_CAP
    );
    expect(merged.results.map((r) => r.id)).toEqual(['user-0', 'company-0', 'user-1', 'company-1']);
  });

  it('lets a single credit session through past a full company arm — the whole point', () => {
    // MUTATION: replace the round-robin with concat-and-slice and this fails; 20 companies
    // would fill the cap and the one session a support person is hunting would vanish.
    const merged = mergeLookupResults(
      new Map([
        ['company', arm('company', LOOKUP_ARM_LIMIT)],
        ['credit_session', arm('credit_session', 1)],
      ]),
      LOOKUP_RESULT_CAP
    );
    expect(merged.results).toHaveLength(LOOKUP_RESULT_CAP);
    expect(merged.results.some((r) => r.type === 'credit_session')).toBe(true);
  });

  it('caps the merged list and flags truncated when the arms held more than the cap', () => {
    const merged = mergeLookupResults(
      new Map([
        ['company', arm('company', LOOKUP_ARM_LIMIT)],
        ['user', arm('user', 5)],
      ]),
      LOOKUP_RESULT_CAP
    );
    expect(merged.results).toHaveLength(LOOKUP_RESULT_CAP);
    expect(merged.truncated).toBe(true);
  });

  it('does not flag truncated when everything fitted', () => {
    const merged = mergeLookupResults(new Map([['user', arm('user', 3)]]), LOOKUP_RESULT_CAP);
    expect(merged.results).toHaveLength(3);
    expect(merged.truncated).toBe(false);
  });

  it('drains a deeper arm in later rounds once the shallow arms are exhausted', () => {
    const merged = mergeLookupResults(
      new Map([
        ['user', arm('user', 1)],
        ['agency', arm('agency', 3)],
      ]),
      LOOKUP_RESULT_CAP
    );
    expect(merged.results.map((r) => r.id)).toEqual(['user-0', 'agency-0', 'agency-1', 'agency-2']);
  });

  it('walks every shipped entity type, so a new type cannot be silently unmerged', () => {
    const everyType = new Map<LookupEntityType, readonly LookupResult[]>(
      LOOKUP_ENTITY_TYPES.map((type) => [type, arm(type, 1)])
    );
    const merged = mergeLookupResults(everyType, LOOKUP_RESULT_CAP);
    expect(merged.results.map((r) => r.type)).toEqual([...LOOKUP_ENTITY_TYPES]);
  });
});

// ── formatting primitives ────────────────────────────────────────────────────────────

describe('formatShortDate', () => {
  it('formats in UTC regardless of the host timezone', () => {
    expect(formatShortDate(new Date('2026-06-12T00:30:00.000Z'))).toBe('12 Jun');
  });

  it('does not roll the day backwards for a late-UTC instant', () => {
    expect(formatShortDate(new Date('2026-08-12T23:45:00.000Z'))).toBe('12 Aug');
  });
});

describe('formatMinorAmount', () => {
  it('renders AUD minor units with the A$ symbol', () => {
    expect(formatMinorAmount(6240, 'AUD')).toBe('A$62.40');
  });

  it('pads the cents', () => {
    expect(formatMinorAmount(6205, 'AUD')).toBe('A$62.05');
  });

  it('groups thousands', () => {
    expect(formatMinorAmount(123_456_789, 'AUD')).toBe('A$1,234,567.89');
  });

  it('renders zero as A$0.00 — a real balance, not an absent wallet', () => {
    expect(formatMinorAmount(0, 'AUD')).toBe('A$0.00');
  });

  it('uses a MINUS SIGN, never a hyphen that reads as a separating dash', () => {
    expect(formatMinorAmount(-6240, 'AUD')).toBe(`${MINUS}A$62.40`);
  });

  it('degrades to a labelled amount rather than mislabelling a non-AUD currency', () => {
    expect(formatMinorAmount(1234, 'EUR')).toBe('EUR 12.34');
  });
});

describe('humanizeEnumLabel', () => {
  it('turns a snake_case enum value into words', () => {
    expect(humanizeEnumLabel('proposal_submitted')).toBe('proposal submitted');
    expect(humanizeEnumLabel('not_required')).toBe('not required');
  });

  it('leaves a single-word value alone', () => {
    expect(humanizeEnumLabel('ended')).toBe('ended');
  });
});

describe('joinNameParts', () => {
  it('joins both halves', () => {
    expect(joinNameParts('Dana', 'Whitfield')).toBe('Dana Whitfield');
  });

  it('tolerates one null half', () => {
    expect(joinNameParts('Dana', null)).toBe('Dana');
    expect(joinNameParts(null, 'Whitfield')).toBe('Whitfield');
  });

  it('returns null when both halves are absent, so the caller can fall back to email', () => {
    expect(joinNameParts(null, null)).toBeNull();
  });
});

// ── sub-line composers ───────────────────────────────────────────────────────────────

describe('buildUserSub', () => {
  it('names the role and company of the single live membership', () => {
    expect(
      buildUserSub('client', { role: 'owner', companyName: 'Northwind', liveMembershipCount: 1 })
    ).toBe('Owner @ Northwind · client mode');
  });

  it('adds "+N more" for additional live memberships', () => {
    expect(
      buildUserSub('client', { role: 'admin', companyName: 'Northwind', liveMembershipCount: 3 })
    ).toBe('Admin @ Northwind +2 more · client mode');
  });

  it('states the absence of a membership rather than emitting a dangling separator', () => {
    expect(buildUserSub('expert', undefined)).toBe('No company membership · expert mode');
  });
});

describe('buildCompanySub', () => {
  const base = {
    isPersonal: false,
    memberCount: 6,
    domain: 'northwind.com.au',
    walletBalanceMinor: 6240,
    walletCurrency: 'AUD',
  };

  it('composes kind, members, domain and wallet', () => {
    expect(buildCompanySub(base)).toBe(
      'Client company · 6 members · northwind.com.au · wallet A$62.40'
    );
  });

  it('labels a personal workspace as such', () => {
    expect(buildCompanySub({ ...base, isPersonal: true })).toContain('Personal workspace');
  });

  it('drops the domain segment entirely when there is no domain — no dangling separator', () => {
    expect(buildCompanySub({ ...base, domain: null })).toBe(
      'Client company · 6 members · wallet A$62.40'
    );
  });

  it('distinguishes "no wallet yet" from a zero balance — they are different facts', () => {
    expect(buildCompanySub({ ...base, walletBalanceMinor: null, walletCurrency: null })).toContain(
      'no wallet yet'
    );
    expect(buildCompanySub({ ...base, walletBalanceMinor: 0 })).toContain('wallet A$0.00');
  });

  it('marks a negative balance as overdrawn with a minus sign', () => {
    expect(buildCompanySub({ ...base, walletBalanceMinor: -6240 })).toBe(
      `Client company · 6 members · northwind.com.au · wallet ${MINUS}A$62.40 (overdrawn)`
    );
  });

  it('singularises one member and states zero as a fact', () => {
    expect(buildCompanySub({ ...base, memberCount: 1 })).toContain('1 member ·');
    expect(buildCompanySub({ ...base, memberCount: 0 })).toContain('no members yet');
  });
});

describe('buildAgencySub', () => {
  it('composes the expert count and primary domain', () => {
    expect(buildAgencySub({ expertCount: 4, domain: 'cloudpeak.io' })).toBe(
      'Agency · 4 experts · cloudpeak.io'
    );
  });

  it('drops the domain segment when the agency has registered none', () => {
    expect(buildAgencySub({ expertCount: 4, domain: null })).toBe('Agency · 4 experts');
  });

  it('states an empty agency as a fact about the record', () => {
    expect(buildAgencySub({ expertCount: 0, domain: null })).toBe('Agency · no experts yet');
  });

  it('singularises one expert', () => {
    expect(buildAgencySub({ expertCount: 1, domain: null })).toBe('Agency · 1 expert');
  });
});

describe('buildExpertSub', () => {
  const approved = {
    agencyName: 'CloudPeak',
    username: 'priya',
    approvedAt: new Date('2026-05-01T00:00:00.000Z'),
    applicationStatus: 'approved',
    searchable: true,
  };

  it('composes agency, handle, approval and searchability', () => {
    expect(buildExpertSub(approved)).toBe('Expert @ CloudPeak · @priya · approved · searchable');
  });

  it('calls an agency-less expert independent', () => {
    expect(buildExpertSub({ ...approved, agencyName: null })).toContain('Independent expert');
  });

  it('drops the handle segment for a username-less expert', () => {
    expect(buildExpertSub({ ...approved, username: null })).toBe(
      'Expert @ CloudPeak · approved · searchable'
    );
  });

  it('reports an unapproved, unsearchable expert accurately — Lookup exists to find them', () => {
    expect(
      buildExpertSub({
        ...approved,
        approvedAt: null,
        applicationStatus: 'submitted',
        searchable: false,
      })
    ).toBe('Expert @ CloudPeak · @priya · awaiting approval · not searchable');
  });

  it('sharpens the unapproved wording from applicationStatus', () => {
    expect(buildExpertSub({ ...approved, approvedAt: null, applicationStatus: 'draft' })).toContain(
      'draft application'
    );
    expect(
      buildExpertSub({ ...approved, approvedAt: null, applicationStatus: 'rejected' })
    ).toContain('application rejected');
  });
});

describe('buildProjectRequestSub', () => {
  it('composes the buyer, the humanised status and the creation date', () => {
    expect(
      buildProjectRequestSub({
        companyName: 'Northwind Industrial',
        status: 'proposal_submitted',
        createdAt: new Date('2026-06-12T09:00:00.000Z'),
      })
    ).toBe('Project request · Northwind Industrial · proposal submitted · created 12 Jun');
  });
});

describe('buildCreditSessionTitle', () => {
  const base = {
    status: 'ended',
    connectedMinutes: 45,
    connectedAt: new Date('2026-08-12T01:00:00.000Z'),
    endedAt: new Date('2026-08-12T01:45:00.000Z'),
    createdAt: new Date('2026-08-11T23:00:00.000Z'),
  };

  it('prefers endedAt for the date', () => {
    expect(buildCreditSessionTitle(base)).toBe('Consultation · 12 Aug · 45 min');
  });

  it('falls back to connectedAt, then createdAt', () => {
    expect(buildCreditSessionTitle({ ...base, endedAt: null })).toBe(
      'Consultation · 12 Aug · 45 min'
    );
    expect(buildCreditSessionTitle({ ...base, endedAt: null, connectedAt: null })).toBe(
      'Consultation · 11 Aug · 45 min'
    );
  });

  it('renders an em-dash for a pending session — 0 minutes would be a lie', () => {
    expect(
      buildCreditSessionTitle({
        ...base,
        status: 'pending',
        connectedMinutes: 0,
        connectedAt: null,
        endedAt: null,
      })
    ).toBe('Consultation · 11 Aug · — min');
  });
});

describe('buildCreditSessionSub', () => {
  it('names both parties and both statuses', () => {
    expect(
      buildCreditSessionSub({
        companyName: 'Northwind Industrial',
        expertFirstName: 'Tom',
        expertLastName: 'Okafor',
        status: 'ended',
        settlementStatus: 'settled',
      })
    ).toBe('Northwind Industrial × Tom Okafor · ended · settled');
  });

  it('says the expert is unavailable rather than dropping the session', () => {
    expect(
      buildCreditSessionSub({
        companyName: 'Northwind Industrial',
        expertFirstName: null,
        expertLastName: null,
        status: 'ended',
        settlementStatus: 'not_required',
      })
    ).toBe('Northwind Industrial × expert unavailable · ended · not required');
  });
});

describe('buildEngagementTitle', () => {
  it('prefers the case title', () => {
    expect(
      buildEngagementTitle({
        engagementType: 'case',
        caseTitle: 'Fix the CPQ bug',
        requestTitle: null,
      })
    ).toBe('Fix the CPQ bug');
  });

  it('falls back to the originating request title for a project', () => {
    expect(
      buildEngagementTitle({
        engagementType: 'project',
        caseTitle: null,
        requestTitle: 'CPQ implementation — replace legacy quoting tool',
      })
    ).toBe('CPQ implementation — replace legacy quoting tool');
  });

  it('a case with neither title reads "Untitled case"', () => {
    expect(
      buildEngagementTitle({ engagementType: 'case', caseTitle: null, requestTitle: null })
    ).toBe('Untitled case');
  });

  it('a project with neither title reads "Untitled project"', () => {
    expect(
      buildEngagementTitle({ engagementType: 'project', caseTitle: null, requestTitle: null })
    ).toBe('Untitled project');
  });

  it('a package/retainer with neither title also reads "Untitled project" (the non-case default)', () => {
    expect(
      buildEngagementTitle({ engagementType: 'package', caseTitle: null, requestTitle: null })
    ).toBe('Untitled project');
  });
});

describe('buildEngagementSub', () => {
  const BASE = {
    engagementType: 'project',
    companyName: 'Northwind Industrial',
    expertFirstName: 'Priya',
    expertLastName: 'Nair',
    status: 'active',
    createdAt: new Date('2026-06-12T00:00:00.000Z'),
  };

  it('names the type, both parties, status and start date', () => {
    expect(buildEngagementSub(BASE)).toBe(
      'Project · Northwind Industrial × Priya Nair · active · started 12 Jun'
    );
  });

  it('capitalises the case type too', () => {
    expect(buildEngagementSub({ ...BASE, engagementType: 'case' })).toBe(
      'Case · Northwind Industrial × Priya Nair · active · started 12 Jun'
    );
  });

  it('says the expert is unavailable rather than dropping the row', () => {
    expect(buildEngagementSub({ ...BASE, expertFirstName: null, expertLastName: null })).toBe(
      'Project · Northwind Industrial × expert unavailable · active · started 12 Jun'
    );
  });

  it('humanizes a multi-word status (a synthetic value — the real enum is single-word today)', () => {
    expect(buildEngagementSub({ ...BASE, status: 'on_hold' })).toBe(
      'Project · Northwind Industrial × Priya Nair · on hold · started 12 Jun'
    );
  });
});

describe('the shipped constants', () => {
  it('fetches one PROBE row past the cap, so a single overflowing arm can report truncation', () => {
    // MUTATION: set LOOKUP_ARM_LIMIT back to LOOKUP_RESULT_CAP and 30 matching companies
    // report `truncated: false` — the commonest overflow case would claim completeness.
    expect(LOOKUP_ARM_LIMIT).toBe(LOOKUP_RESULT_CAP + 1);
  });

  it('refuses a one-character query', () => {
    expect(LOOKUP_MIN_QUERY_LENGTH).toBe(2);
  });
});
