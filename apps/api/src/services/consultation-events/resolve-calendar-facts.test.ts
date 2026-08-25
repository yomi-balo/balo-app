import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

const {
  mockFindCaseByEngagementId,
  mockFindCompanyById,
  mockFindEngagementById,
  mockFindProjectRequestById,
  mockFindRelationshipById,
} = vi.hoisted(() => ({
  mockFindCaseByEngagementId: vi.fn(),
  mockFindCompanyById: vi.fn(),
  mockFindEngagementById: vi.fn(),
  mockFindProjectRequestById: vi.fn(),
  mockFindRelationshipById: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  caseEngagementsRepository: { findByEngagementId: mockFindCaseByEngagementId },
  companiesRepository: { findById: mockFindCompanyById },
  engagementsRepository: { findById: mockFindEngagementById },
  projectRequestsRepository: { findById: mockFindProjectRequestById },
  requestExpertRelationshipsRepository: { findById: mockFindRelationshipById },
}));

// ⚠ `@balo/shared/meetings` IS DELIBERATELY NOT MOCKED. `resolveContextOwner` is the ONE
// sanctioned "which party owns this context" rule, including its axis discipline (the EXPERT
// from the relationship, the COMPANY from the request). A stubbed resolver would let the two
// be swapped and every assertion below would still pass.
import { resolveExpertCalendarFacts, titleOr } from './resolve-calendar-facts.js';

function fakeLog(): FastifyBaseLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

const ENGAGEMENT_ID = 'engagement-1';
const REQUEST_ID = 'request-1';
const RELATIONSHIP_ID = 'relationship-1';
const COMPANY = { id: 'company-1', name: 'Northwind Industrial' };

beforeEach(() => {
  vi.clearAllMocks();
  mockFindCompanyById.mockResolvedValue(COMPANY);
});

/** The engagement-grain happy graph: `engagements` names both parties on itself. */
function wireEngagement(): void {
  mockFindEngagementById.mockResolvedValue({
    id: ENGAGEMENT_ID,
    companyId: COMPANY.id,
    expertProfileId: 'expert-1',
  });
}

/** The request-grain happy graph. */
function wireRequest(title: string | null = 'Salesforce CPQ rollout'): void {
  mockFindProjectRequestById.mockResolvedValue({
    id: REQUEST_ID,
    companyId: COMPANY.id,
    expertProfileId: 'expert-1',
    title,
  });
}

describe('resolveExpertCalendarFacts — one arm per bookable context', () => {
  it('case → reads the SUBTYPE for the title, the supertype for the company', async () => {
    // ⚠ TWO DIFFERENT ROWS. `resolveContextOwner` resolves `engagements.company_id` (the
    // supertype); the title lives on `case_engagements` and no injected read of that rule
    // touches it — hence the second, deliberate read.
    wireEngagement();
    mockFindCaseByEngagementId.mockResolvedValue({ title: 'CPQ rollout' });

    const facts = await resolveExpertCalendarFacts('case', ENGAGEMENT_ID, fakeLog());

    expect(facts).toEqual({
      clientCompanyName: 'Northwind Industrial',
      title: 'CPQ rollout',
      eventLabel: 'Consultation',
    });
    expect(mockFindCaseByEngagementId).toHaveBeenCalledWith(ENGAGEMENT_ID);
    expect(mockFindCompanyById).toHaveBeenCalledWith(COMPANY.id);
    // ⚠ REGRESSION PIN (carried over from the pre-BAL-433 suite): the case arm reads the case
    // and the company AND NOTHING ELSE. A request-grain read appearing here is the axis
    // confusion ADR-1029 forbids, and it would be silent — the facts above would still match.
    expect(mockFindProjectRequestById).not.toHaveBeenCalled();
  });

  it('project_discovery → the request title, captured from the injected read', async () => {
    wireRequest();

    const facts = await resolveExpertCalendarFacts('project_discovery', REQUEST_ID, fakeLog());

    expect(facts).toEqual({
      clientCompanyName: 'Northwind Industrial',
      title: 'Salesforce CPQ rollout',
      eventLabel: 'Discovery call',
    });
    expect(mockFindCaseByEngagementId).not.toHaveBeenCalled();
  });

  it('request_interaction → the two-hop, company off the REQUEST and title off the same row', async () => {
    mockFindRelationshipById.mockResolvedValue({
      id: RELATIONSHIP_ID,
      projectRequestId: REQUEST_ID,
      expertProfileId: 'expert-1',
    });
    wireRequest();

    const facts = await resolveExpertCalendarFacts(
      'request_interaction',
      RELATIONSHIP_ID,
      fakeLog()
    );

    expect(facts).toEqual({
      clientCompanyName: 'Northwind Industrial',
      title: 'Salesforce CPQ rollout',
      eventLabel: 'Intro call',
    });
    expect(mockFindRelationshipById).toHaveBeenCalledWith(RELATIONSHIP_ID);
    expect(mockFindProjectRequestById).toHaveBeenCalledWith(REQUEST_ID);
  });

  /**
   * ⚠⚠ THE REQUEST ROW IS READ ONCE, AND THAT IS A CORRECTNESS RULE, NOT AN OPTIMISATION.
   * A second `findById` could observe a row that CHANGED between the two reads, so the title
   * and the company id would describe different states. `loadSubject` states this verbatim;
   * this is the assertion that keeps it true after a refactor.
   */
  it('⚠ reads the project request EXACTLY ONCE on the two-hop arm', async () => {
    mockFindRelationshipById.mockResolvedValue({
      id: RELATIONSHIP_ID,
      projectRequestId: REQUEST_ID,
      expertProfileId: 'expert-1',
    });
    wireRequest();

    await resolveExpertCalendarFacts('request_interaction', RELATIONSHIP_ID, fakeLog());

    expect(mockFindProjectRequestById).toHaveBeenCalledTimes(1);
  });

  /**
   * BAL-433 D3 — NO TITLE COLUMN EXISTS for these two, so the registry's own LABEL is the
   * subject. Not "omit the subject": that would make the event body a bare URL for two of the
   * five contexts, which reads as unfinished.
   */
  it.each([
    ['project_kickoff', 'Project kickoff'],
    ['package_session', 'Package session'],
  ] as const)(
    '%s → title falls back to the label "%s", and reads no title table',
    async (contextType, label) => {
      wireEngagement();

      const facts = await resolveExpertCalendarFacts(contextType, ENGAGEMENT_ID, fakeLog());

      expect(facts).toEqual({
        clientCompanyName: 'Northwind Industrial',
        title: label,
        eventLabel: label,
      });
      expect(mockFindCaseByEngagementId).not.toHaveBeenCalled();
      expect(mockFindProjectRequestById).not.toHaveBeenCalled();
    }
  );
});

describe('resolveExpertCalendarFacts — blank titles never reach a calendar', () => {
  it.each([null, '', '   ', '\n\t '])('a %j case title degrades to the label', async (title) => {
    wireEngagement();
    mockFindCaseByEngagementId.mockResolvedValue({ title });

    const facts = await resolveExpertCalendarFacts('case', ENGAGEMENT_ID, fakeLog());

    expect(facts?.title).toBe('Consultation');
  });

  it('a blank REQUEST title degrades to the label — BAL-283 behaviour, byte for byte', async () => {
    wireRequest('   ');

    const facts = await resolveExpertCalendarFacts('project_discovery', REQUEST_ID, fakeLog());

    expect(facts?.title).toBe('Discovery call');
  });

  /**
   * ⚠ THE SAME PIN ON THE ARM BAL-283 ACTUALLY SHIPPED IT. `request_title` is one code path,
   * so the case above already covers it in substance — but the behaviour that shipped, and
   * that this slice promised to keep byte-identical, was `request_interaction` resolving a
   * blank request title to 'Intro call' (old `provision-meeting.test.ts`). Pinned HERE so the
   * promise sits on the label it was made about.
   */
  it('a blank REQUEST title on the TWO-HOP arm degrades to "Intro call"', async () => {
    mockFindRelationshipById.mockResolvedValue({
      id: RELATIONSHIP_ID,
      projectRequestId: REQUEST_ID,
      expertProfileId: 'expert-1',
    });
    wireRequest('   ');

    const facts = await resolveExpertCalendarFacts(
      'request_interaction',
      RELATIONSHIP_ID,
      fakeLog()
    );

    expect(facts?.title).toBe('Intro call');
    expect(facts?.eventLabel).toBe('Intro call');
  });

  it('a case with no live subtype row still resolves — the label carries it', async () => {
    // The supertype resolved, so the booking is real; only the title is unavailable. Refusing
    // to project here would withhold a calendar entry from a meeting that exists.
    wireEngagement();
    mockFindCaseByEngagementId.mockResolvedValue(undefined);

    const facts = await resolveExpertCalendarFacts('case', ENGAGEMENT_ID, fakeLog());

    expect(facts?.title).toBe('Consultation');
  });
});

describe('resolveExpertCalendarFacts — the not-found paths', () => {
  it('an unresolved context → undefined + one log.info, no error', async () => {
    mockFindEngagementById.mockResolvedValue(undefined);
    const log = fakeLog();

    await expect(
      resolveExpertCalendarFacts('project_kickoff', ENGAGEMENT_ID, log)
    ).resolves.toBeUndefined();

    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      { contextType: 'project_kickoff', contextId: ENGAGEMENT_ID },
      'No live context for this booking — skipping the calendar projection'
    );
    expect(vi.mocked(log.error)).not.toHaveBeenCalled();
  });

  it.each([
    ['the relationship', () => mockFindRelationshipById.mockResolvedValue(undefined)],
    ['the request', () => mockFindProjectRequestById.mockResolvedValue(undefined)],
  ])('a missing %s on the two-hop → undefined, no throw', async (_label, breakRow) => {
    mockFindRelationshipById.mockResolvedValue({
      id: RELATIONSHIP_ID,
      projectRequestId: REQUEST_ID,
      expertProfileId: 'expert-1',
    });
    wireRequest();
    breakRow();

    await expect(
      resolveExpertCalendarFacts('request_interaction', RELATIONSHIP_ID, fakeLog())
    ).resolves.toBeUndefined();
  });

  it('a missing company → undefined + its own log.info', async () => {
    wireEngagement();
    mockFindCompanyById.mockResolvedValue(undefined);
    const log = fakeLog();

    await expect(
      resolveExpertCalendarFacts('package_session', ENGAGEMENT_ID, log)
    ).resolves.toBeUndefined();

    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      { contextType: 'package_session', contextId: ENGAGEMENT_ID },
      'No live company for this context — skipping the calendar projection'
    );
  });
});

describe('resolveExpertCalendarFacts — it NEVER throws', () => {
  it.each([
    ['the owner read', () => mockFindEngagementById.mockRejectedValue(new Error('db unavailable'))],
    ['the company read', () => mockFindCompanyById.mockRejectedValue(new Error('db unavailable'))],
    [
      'the subtype title read',
      () => mockFindCaseByEngagementId.mockRejectedValue(new Error('db unavailable')),
    ],
  ])('a throwing %s degrades to undefined + one log.error', async (_label, breakRead) => {
    // The booking has ALREADY COMMITTED by the time this runs — a repository wobble must
    // degrade to a logged no-op, never to a rejected promise.
    wireEngagement();
    mockFindCaseByEngagementId.mockResolvedValue({ title: 'CPQ rollout' });
    breakRead();
    const log = fakeLog();

    await expect(resolveExpertCalendarFacts('case', ENGAGEMENT_ID, log)).resolves.toBeUndefined();

    expect(vi.mocked(log.error)).toHaveBeenCalledTimes(1);
    const [[meta, message]] = vi.mocked(log.error).mock.calls;
    expect(meta).toMatchObject({ contextType: 'case', contextId: ENGAGEMENT_ID });
    expect(message).toBe('Failed to resolve display facts for the expert calendar projection');
  });

  it('⚠ the error log carries the ids and the stack — never a title or a company name', async () => {
    wireEngagement();
    mockFindCaseByEngagementId.mockRejectedValue(new Error('db unavailable'));
    const log = fakeLog();

    await resolveExpertCalendarFacts('case', ENGAGEMENT_ID, log);

    const [[meta]] = vi.mocked(log.error).mock.calls;
    expect(Object.keys(meta as object).sort()).toEqual([
      'contextId',
      'contextType',
      'error',
      'stack',
    ]);
  });
});

describe('titleOr', () => {
  it('trims, and falls back only on a genuinely empty subject', () => {
    expect(titleOr('  CPQ rollout  ', 'Consultation')).toBe('CPQ rollout');
    expect(titleOr('', 'Consultation')).toBe('Consultation');
    expect(titleOr('   ', 'Consultation')).toBe('Consultation');
    expect(titleOr(null, 'Consultation')).toBe('Consultation');
    expect(titleOr(undefined, 'Consultation')).toBe('Consultation');
  });
});
