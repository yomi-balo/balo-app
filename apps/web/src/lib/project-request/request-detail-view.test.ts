import { describe, it, expect } from 'vitest';
import type { ProjectRequestWithRelations } from '@balo/db';
import {
  mapRequestToDetailView,
  formatPostedRelative,
  QUIET_THRESHOLD_DAYS,
} from './request-detail-view';
import type { RequestViewerContext } from './resolve-request-lens';

const NOW = new Date('2025-01-10T00:00:00Z');

type Relationship = ProjectRequestWithRelations['relationships'][number];

/** Loosened override shape — lets tests pass a raw status string. */
type RelOverrides = Omit<Partial<Relationship>, 'status'> & { status?: string };

/** Build a single hydrated relationship row with the A2 last-activity fields. */
function rel(overrides: RelOverrides = {}): Relationship {
  return {
    id: 'rel-1',
    expertProfileId: 'expert-1',
    status: 'eoi_submitted',
    invitedAt: new Date('2025-01-08T00:00:00Z'),
    updatedAt: new Date('2025-01-08T00:00:00Z'),
    expertProfile: {
      id: 'expert-1',
      user: { id: 'user-expert', firstName: 'Priya', lastName: 'Nair' },
    },
    expressionsOfInterest: [],
    conversationMessages: [],
    ...overrides,
  } as Relationship;
}

function request(
  overrides: Partial<ProjectRequestWithRelations> = {}
): ProjectRequestWithRelations {
  return {
    id: 'req-1',
    companyId: 'company-1',
    expertProfileId: null,
    createdByUserId: 'user-client',
    sendTo: 'match',
    status: 'requested',
    source: 'manual',
    title: 'CPQ implementation',
    description: '<p>Brief</p>',
    budgetMinCents: 4500000,
    budgetMaxCents: 7000000,
    budgetCurrency: 'aud',
    timeline: 'Target go-live: end of Q3',
    createdAt: new Date('2025-01-07T00:00:00Z'),
    updatedAt: new Date('2025-01-07T00:00:00Z'),
    company: { id: 'company-1', name: 'Northwind Industrial' },
    createdByUser: {
      id: 'user-client',
      firstName: 'Dana',
      lastName: 'Whitfield',
      email: 'dana@northwind.test',
    },
    tags: [
      { projectTag: { id: 'tag-1', name: 'Implementation' } },
    ] as ProjectRequestWithRelations['tags'],
    products: [
      { product: { id: 'prod-1', name: 'Revenue Cloud (CPQ)' } },
    ] as ProjectRequestWithRelations['products'],
    documents: [
      { id: 'doc-1', fileName: 'brief.pdf', sizeBytes: 1024, contentType: 'application/pdf' },
    ],
    relationships: [rel()],
    ...overrides,
  } as ProjectRequestWithRelations;
}

function ctx(overrides: Partial<RequestViewerContext> = {}): RequestViewerContext {
  return {
    lens: 'expert',
    archetype: 'participant',
    isOwner: false,
    isInvitedExpert: true,
    relationshipId: 'rel-1',
    canSeeContact: true,
    ...overrides,
  };
}

describe('mapRequestToDetailView', () => {
  it('maps the core fields to a serializable view-model', () => {
    const view = mapRequestToDetailView(request(), ctx(), NOW);
    expect(view.id).toBe('req-1');
    expect(view.title).toBe('CPQ implementation');
    expect(view.descriptionHtml).toBe('<p>Brief</p>');
    expect(view.products).toEqual([{ name: 'Revenue Cloud (CPQ)' }]);
    expect(view.tags).toEqual([{ name: 'Implementation' }]);
    expect(view.companyName).toBe('Northwind Industrial');
    expect(view.documents).toEqual([
      { id: 'doc-1', fileName: 'brief.pdf', sizeBytes: 1024, contentType: 'application/pdf' },
    ]);
  });

  it('formats the budget range and passes the timeline through', () => {
    const view = mapRequestToDetailView(request(), ctx(), NOW);
    expect(view.budget).toBe('A$45,000 – A$70,000');
    expect(view.timeline).toBe('Target go-live: end of Q3');
  });

  it('returns null budget + timeline when none captured', () => {
    const view = mapRequestToDetailView(
      request({ budgetMinCents: null, budgetMaxCents: null, timeline: null }),
      ctx(),
      NOW
    );
    expect(view.budget).toBeNull();
    expect(view.timeline).toBeNull();
  });

  it('includes the contact name when contact is visible', () => {
    const view = mapRequestToDetailView(request(), ctx({ canSeeContact: true }), NOW);
    expect(view.contact).toEqual({ name: 'Dana Whitfield' });
  });

  it('drops the contact entirely when gated (client lens)', () => {
    const view = mapRequestToDetailView(
      request(),
      ctx({ lens: 'client', canSeeContact: false }),
      NOW
    );
    expect(view.contact).toBeNull();
    // The name must NOT be embedded anywhere in the serialized payload.
    expect(JSON.stringify(view)).not.toContain('Dana');
  });

  it('falls back to the email local-part when the contact has no name', () => {
    const view = mapRequestToDetailView(
      request({
        createdByUser: {
          id: 'u',
          firstName: null,
          lastName: null,
          email: 'dana@northwind.test',
        },
      }),
      ctx({ canSeeContact: true }),
      NOW
    );
    expect(view.contact).toEqual({ name: 'dana' });
  });

  it('projects relationships only for the observer (admin) lens', () => {
    const observerView = mapRequestToDetailView(
      request(),
      ctx({ lens: 'admin', archetype: 'observer' }),
      NOW
    );
    expect(observerView.relationships).toEqual([
      {
        id: 'rel-1',
        expertName: 'Priya Nair',
        status: 'eoi_submitted',
        state: 'eoi_in',
        isQuiet: false,
        quietDays: expect.any(Number),
        removable: false,
      },
    ]);
  });

  it('omits the relationships projection for participants', () => {
    const view = mapRequestToDetailView(request(), ctx({ archetype: 'participant' }), NOW);
    expect(view.relationships).toEqual([]);
  });
});

describe('mapRequestToDetailView — viewerEoi (expert lens)', () => {
  const liveEoi = [
    { id: 'eoi-1', submittedAt: new Date('2025-01-09T00:00:00Z'), message: '<p>My pitch</p>' },
  ] as Relationship['expressionsOfInterest'];

  it('returns hasLiveEoi:true + the message HTML when the viewer-expert has a live EOI', () => {
    const view = mapRequestToDetailView(
      request({ relationships: [rel({ expressionsOfInterest: liveEoi })] }),
      ctx({ lens: 'expert', relationshipId: 'rel-1' }),
      NOW
    );
    expect(view.viewerEoi).toEqual({ hasLiveEoi: true, messageHtml: '<p>My pitch</p>' });
  });

  it('returns hasLiveEoi:false + null message when the viewer-expert has no live EOI', () => {
    const view = mapRequestToDetailView(
      request({ relationships: [rel({ expressionsOfInterest: [] })] }),
      ctx({ lens: 'expert', relationshipId: 'rel-1' }),
      NOW
    );
    expect(view.viewerEoi).toEqual({ hasLiveEoi: false, messageHtml: null });
  });

  it('is null for the client lens (no EOI HTML crosses the boundary)', () => {
    const view = mapRequestToDetailView(
      request({ relationships: [rel({ expressionsOfInterest: liveEoi })] }),
      ctx({ lens: 'client', relationshipId: null }),
      NOW
    );
    expect(view.viewerEoi).toBeNull();
    expect(JSON.stringify(view)).not.toContain('My pitch');
  });

  it('is null for the admin (observer) lens', () => {
    const view = mapRequestToDetailView(
      request({ relationships: [rel({ expressionsOfInterest: liveEoi })] }),
      ctx({ lens: 'admin', archetype: 'observer', relationshipId: null }),
      NOW
    );
    expect(view.viewerEoi).toBeNull();
  });

  it('is null when the expert lens has no resolved relationshipId', () => {
    const view = mapRequestToDetailView(
      request(),
      ctx({ lens: 'expert', relationshipId: null }),
      NOW
    );
    expect(view.viewerEoi).toBeNull();
  });
});

describe('mapRequestToDetailView — viewerRelationshipStatus (BAL-272)', () => {
  it("returns the viewer-expert's OWN relationship status for the expert lens", () => {
    const view = mapRequestToDetailView(
      request({ relationships: [rel({ status: 'proposal_requested' })] }),
      ctx({ lens: 'expert', relationshipId: 'rel-1' }),
      NOW
    );
    expect(view.viewerRelationshipStatus).toBe('proposal_requested');
  });

  it("returns the VIEWER'S status even when another relationship has progressed further", () => {
    const view = mapRequestToDetailView(
      request({
        status: 'proposal_requested',
        relationships: [
          rel({ status: 'eoi_submitted' }),
          rel({ id: 'rel-2', expertProfileId: 'expert-2', status: 'proposal_requested' }),
        ],
      }),
      ctx({ lens: 'expert', relationshipId: 'rel-1' }),
      NOW
    );
    expect(view.viewerRelationshipStatus).toBe('eoi_submitted');
  });

  it('is null for the client lens', () => {
    const view = mapRequestToDetailView(
      request(),
      ctx({ lens: 'client', relationshipId: null }),
      NOW
    );
    expect(view.viewerRelationshipStatus).toBeNull();
  });

  it('is null for the admin (observer) lens', () => {
    const view = mapRequestToDetailView(
      request(),
      ctx({ lens: 'admin', archetype: 'observer', relationshipId: null }),
      NOW
    );
    expect(view.viewerRelationshipStatus).toBeNull();
  });

  it('is null when the expert lens has no resolved relationshipId', () => {
    const view = mapRequestToDetailView(
      request(),
      ctx({ lens: 'expert', relationshipId: null }),
      NOW
    );
    expect(view.viewerRelationshipStatus).toBeNull();
  });
});

describe('mapRequestToDetailView — per-expert derived state (observer lens)', () => {
  const observerCtx = ctx({ lens: 'admin', archetype: 'observer' });

  function deriveOne(r: RelOverrides, now = NOW) {
    const view = mapRequestToDetailView(request({ relationships: [rel(r)] }), observerCtx, now);
    const [first] = view.relationships;
    if (first === undefined) throw new Error('expected one relationship');
    return first;
  }

  it('maps each raw status to its display state', () => {
    const cases: Array<[string, string]> = [
      ['invited', 'invited'],
      ['eoi_submitted', 'eoi_in'],
      ['proposal_requested', 'proposal_requested'],
      ['proposal_submitted', 'proposal_in'],
      ['accepted', 'accepted'],
      ['declined', 'declined'],
    ];
    for (const [status, state] of cases) {
      expect(deriveOne({ status }).state).toBe(state);
    }
  });

  it('marks a row removable only while invited', () => {
    expect(deriveOne({ status: 'invited' }).removable).toBe(true);
    expect(deriveOne({ status: 'eoi_submitted' }).removable).toBe(false);
    expect(deriveOne({ status: 'declined' }).removable).toBe(false);
  });

  it('uses the most recent activity timestamp for quietDays', () => {
    // invitedAt 9 days ago, but a message 1 day ago → quietDays = 1, not quiet.
    const result = deriveOne({
      status: 'invited',
      invitedAt: new Date('2025-01-01T00:00:00Z'),
      updatedAt: new Date('2025-01-01T00:00:00Z'),
      conversationMessages: [
        { id: 'm-1', createdAt: new Date('2025-01-09T00:00:00Z') },
      ] as Relationship['conversationMessages'],
    });
    expect(result.quietDays).toBe(1);
    expect(result.isQuiet).toBe(false);
  });

  it('flags an invited row quiet at exactly the threshold (N days)', () => {
    const invitedAt = new Date(NOW.getTime() - QUIET_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);
    const result = deriveOne({ status: 'invited', invitedAt, updatedAt: invitedAt });
    expect(result.quietDays).toBe(QUIET_THRESHOLD_DAYS);
    expect(result.isQuiet).toBe(true);
  });

  it('does NOT flag quiet just below the threshold (N-1 days)', () => {
    const invitedAt = new Date(NOW.getTime() - (QUIET_THRESHOLD_DAYS - 1) * 24 * 60 * 60 * 1000);
    const result = deriveOne({ status: 'invited', invitedAt, updatedAt: invitedAt });
    expect(result.quietDays).toBe(QUIET_THRESHOLD_DAYS - 1);
    expect(result.isQuiet).toBe(false);
  });

  it('never flags a non-invited row quiet, even when stale', () => {
    const old = new Date('2024-01-01T00:00:00Z');
    const result = deriveOne({ status: 'eoi_submitted', invitedAt: old, updatedAt: old });
    expect(result.quietDays).toBeGreaterThan(QUIET_THRESHOLD_DAYS);
    expect(result.isQuiet).toBe(false);
  });

  it('prefers the latest EOI submittedAt as a recency signal', () => {
    const result = deriveOne({
      status: 'invited',
      invitedAt: new Date('2025-01-01T00:00:00Z'),
      updatedAt: new Date('2025-01-01T00:00:00Z'),
      expressionsOfInterest: [
        { id: 'eoi-1', submittedAt: new Date('2025-01-10T00:00:00Z') },
      ] as Relationship['expressionsOfInterest'],
    });
    expect(result.quietDays).toBe(0);
    expect(result.isQuiet).toBe(false);
  });
});

describe('formatPostedRelative', () => {
  const base = new Date('2025-06-10T12:00:00Z');
  it('returns "today" for the same day', () => {
    expect(formatPostedRelative(new Date('2025-06-10T06:00:00Z'), base)).toBe('today');
  });
  it('returns "yesterday" for one day prior', () => {
    expect(formatPostedRelative(new Date('2025-06-09T06:00:00Z'), base)).toBe('yesterday');
  });
  it('returns "N days ago" within a week', () => {
    expect(formatPostedRelative(new Date('2025-06-07T06:00:00Z'), base)).toBe('3 days ago');
  });
  it('returns weeks for multi-week spans', () => {
    // 2025-05-27 → 2025-06-10 is 14 days = 2 weeks.
    expect(formatPostedRelative(new Date('2025-05-27T06:00:00Z'), base)).toBe('2 weeks ago');
  });
  it('returns months for multi-month spans', () => {
    expect(formatPostedRelative(new Date('2025-03-01T06:00:00Z'), base)).toBe('3 months ago');
  });
  it('returns years for spans over a year', () => {
    expect(formatPostedRelative(new Date('2023-06-10T06:00:00Z'), base)).toBe('2 years ago');
  });
});
