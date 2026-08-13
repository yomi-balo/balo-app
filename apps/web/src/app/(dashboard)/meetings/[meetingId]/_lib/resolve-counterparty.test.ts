import { describe, it, expect, vi, beforeEach } from 'vitest';

const EXPERT_USER_ID = 'a0000000-0000-4000-8000-000000000001';
const AGENCY_ID = 'b0000000-0000-4000-8000-000000000002';
const REQUESTER_ID = 'c0000000-0000-4000-8000-000000000003';

vi.mock('server-only', () => ({}));

const mockFindDisplayById = vi.fn();
const mockFindNamesByIds = vi.fn();
const mockGetAgency = vi.fn();

vi.mock('@balo/db', () => ({
  usersRepository: {
    findDisplayById: (...a: unknown[]) => mockFindDisplayById(...a),
    findNamesByIds: (...a: unknown[]) => mockFindNamesByIds(...a),
  },
  agenciesRepository: { getSummaryById: (...a: unknown[]) => mockGetAgency(...a) },
  // Present only so the `RecapExpertProfile` type derivation has something to hang off; no
  // production code path in this module calls it.
  expertsRepository: { findDisplayProfileById: vi.fn() },
}));

import {
  formatRequesterLabel,
  initialsOf,
  resolveCounterparty,
  resolveRequesterLabel,
} from './resolve-counterparty';

/**
 * BAL-389 — direct coverage for the module BAL-388's loader was carrying privately.
 *
 * ⚠ THE MOVE MAKES THESE LINES **NEW CODE** FOR THE PR's SonarCloud COVERAGE GATE (memory
 * `project_sonarcloud_newcode_coverage`), even though the behaviour is unchanged. That is the
 * reason this file exists as well as `load-recap.test.ts`, which continues to exercise the same
 * functions transitively and MUST stay green unchanged — if it needed edits, the move was not
 * pure and has to be redone.
 */

const AGENCY_PROFILE = {
  id: 'p1',
  userId: EXPERT_USER_ID,
  agencyId: AGENCY_ID,
  type: 'agency' as const,
  headline: 'Salesforce CPQ specialist',
  username: 'amara',
};

const FREELANCE_PROFILE = {
  id: 'p2',
  userId: EXPERT_USER_ID,
  agencyId: null,
  type: 'freelancer' as const,
  headline: null,
  username: null,
};

describe('initialsOf', () => {
  it('takes up to two initials, upper-cased', () => {
    expect(initialsOf('Amara Okafor')).toBe('AO');
    expect(initialsOf('amara okafor lee')).toBe('AO');
    expect(initialsOf('Northwind')).toBe('N');
  });

  it('collapses runs of whitespace rather than producing a blank initial', () => {
    expect(initialsOf('  Amara   Okafor  ')).toBe('AO');
  });

  it('degrades to ? rather than throwing on an empty name', () => {
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('   ')).toBe('?');
  });
});

describe('resolveCounterparty — CLIENT lens names the delivering EXPERT', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindDisplayById.mockResolvedValue({
      id: EXPERT_USER_ID,
      firstName: 'Amara',
      lastName: 'Okafor',
      avatarUrl: 'https://cdn.example/a.png',
    });
    mockGetAgency.mockResolvedValue({ id: AGENCY_ID, name: 'CloudPeak' });
  });

  it('builds the person card, the agency label and the short given name', async () => {
    const labels = await resolveCounterparty(
      'client',
      AGENCY_PROFILE,
      'Northwind Industrial',
      '3rd consultation on this case'
    );

    expect(labels.party.name).toBe('Amara Okafor');
    expect(labels.party.headline).toBe('Salesforce CPQ specialist');
    expect(labels.party.orgLabel).toBe('CloudPeak');
    expect(labels.party.initials).toBe('AO');
    expect(labels.party.ordinalLine).toBe('3rd consultation on this case');
    expect(labels.party.bookAgainHref).toBe('/experts/amara');
    expect(labels.agencyLabel).toBe('CloudPeak');
    // The bare GIVEN name — what the resolve dialog and the end-of-call duration line use.
    expect(labels.expertShortName).toBe('Amara');
    // Retrospective attribution: person @ agency on first mention (CLAUDE.md).
    expect(labels.expertPersonLabel).toBe('Amara Okafor @ CloudPeak');
    // Prospective attribution: the PARTY — an agency expert's party IS the agency.
    expect(labels.expertPartyShort).toBe('CloudPeak');
  });

  it('omits the Book again href entirely when the username is null', async () => {
    // ⚠ NEVER `/experts/null`, and never a disabled CTA.
    const labels = await resolveCounterparty('client', FREELANCE_PROFILE, 'Northwind', null);
    expect(labels.party.bookAgainHref).toBeNull();
  });

  it('keeps an INDEPENDENT expert bare — no agency read, no @ clause', async () => {
    const labels = await resolveCounterparty('client', FREELANCE_PROFILE, 'Northwind', null);
    expect(mockGetAgency).not.toHaveBeenCalled();
    expect(labels.agencyLabel).toBeNull();
    expect(labels.expertPersonLabel).toBe('Amara Okafor');
    expect(labels.expertPartyShort).toBe('Amara Okafor');
  });

  it('degrades to a neutral party name when the profile is missing entirely', async () => {
    const labels = await resolveCounterparty('client', undefined, 'Northwind', null);
    expect(mockFindDisplayById).not.toHaveBeenCalled();
    expect(labels.party.name).toBe('An expert');
    expect(labels.party.avatarUrl).toBeNull();
    expect(labels.party.bookAgainHref).toBeNull();
  });
});

describe('resolveCounterparty — EXPERT lens names the client COMPANY, never a person', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindDisplayById.mockResolvedValue({
      id: EXPERT_USER_ID,
      firstName: 'Amara',
      lastName: 'Okafor',
      avatarUrl: 'https://cdn.example/a.png',
    });
    mockGetAgency.mockResolvedValue({ id: AGENCY_ID, name: 'CloudPeak' });
  });

  it('renders the company as the party, with no headline, org label or CTA', async () => {
    // ⚠ CLAUDE.md: client-side rights sit on COMPANY membership and survive individual
    // departures, so there is no single client PERSON to name. Every expert-side CTA the
    // design listed has no live destination, so the card renders none.
    const labels = await resolveCounterparty(
      'expert',
      AGENCY_PROFILE,
      'Northwind Industrial',
      null
    );
    expect(labels.party.name).toBe('Northwind Industrial');
    expect(labels.party.headline).toBeNull();
    expect(labels.party.orgLabel).toBeNull();
    expect(labels.party.avatarUrl).toBeNull();
    expect(labels.party.initials).toBe('NI');
    expect(labels.party.bookAgainHref).toBeNull();
  });

  it('still resolves the expert labels — both lenses share that half', async () => {
    const labels = await resolveCounterparty('expert', AGENCY_PROFILE, 'Northwind', null);
    expect(labels.expertShortName).toBe('Amara');
    expect(labels.agencyLabel).toBe('CloudPeak');
  });
});

/**
 * BAL-389's UX pass split the FETCH from the FORMAT so the end-of-call loader could run the
 * requester read alongside the counterparty read instead of behind it (one fewer sequential
 * round trip on a screen built to be abandoned). The FORMATTING stayed shared — it is the
 * attribution RULE, and CLAUDE.md pins it by tense — so it gets its own direct coverage.
 */
describe('formatRequesterLabel — the shared attribution rule, with no I/O', () => {
  it('names the PERSON with @ agency on first mention', () => {
    expect(
      formatRequesterLabel(
        { id: REQUESTER_ID, firstName: 'Dana', lastName: 'Okoro' },
        'CloudPeak',
        'Amara'
      )
    ).toBe('Dana Okoro @ CloudPeak');
  });

  it('renders an INDEPENDENT expert bare — no agency clause', () => {
    expect(
      formatRequesterLabel(
        { id: REQUESTER_ID, firstName: 'Dana', lastName: 'Okoro' },
        null,
        'Amara'
      )
    ).toBe('Dana Okoro');
  });

  it('falls back to the supplied name for a missing row — never an id, never an email', () => {
    const label = formatRequesterLabel(undefined, 'CloudPeak', 'Amara');
    expect(label).toBe('Amara @ CloudPeak');
    expect(label).not.toContain(REQUESTER_ID);
  });

  it('issues no query at all', () => {
    vi.clearAllMocks();
    formatRequesterLabel({ id: REQUESTER_ID, firstName: 'Dana', lastName: null }, null, 'Amara');
    expect(mockFindNamesByIds).not.toHaveBeenCalled();
  });
});

describe('resolveRequesterLabel — RETROSPECTIVE attribution', () => {
  beforeEach(() => vi.clearAllMocks());

  it('names the PERSON with @ agency on first mention', async () => {
    mockFindNamesByIds.mockResolvedValue([
      { id: REQUESTER_ID, firstName: 'Dana', lastName: 'Okoro' },
    ]);
    await expect(resolveRequesterLabel(REQUESTER_ID, 'CloudPeak', 'Amara')).resolves.toBe(
      'Dana Okoro @ CloudPeak'
    );
    expect(mockFindNamesByIds).toHaveBeenCalledWith([REQUESTER_ID]);
  });

  it('renders an INDEPENDENT expert bare — no agency clause', async () => {
    mockFindNamesByIds.mockResolvedValue([
      { id: REQUESTER_ID, firstName: 'Dana', lastName: 'Okoro' },
    ]);
    await expect(resolveRequesterLabel(REQUESTER_ID, null, 'Amara')).resolves.toBe('Dana Okoro');
  });

  it('falls back to the supplied name when the user row has none — never an id, never an email', async () => {
    mockFindNamesByIds.mockResolvedValue([]);
    const label = await resolveRequesterLabel(REQUESTER_ID, 'CloudPeak', 'Amara');
    expect(label).toBe('Amara @ CloudPeak');
    expect(label).not.toContain(REQUESTER_ID);
    expect(label).not.toContain('@ ' + REQUESTER_ID);
  });
});
