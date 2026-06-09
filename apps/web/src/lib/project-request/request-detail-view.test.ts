import { describe, it, expect } from 'vitest';
import type { ProjectRequestWithRelations } from '@balo/db';
import { mapRequestToDetailView, formatPostedRelative } from './request-detail-view';
import type { RequestViewerContext } from './resolve-request-lens';

const NOW = new Date('2025-01-10T00:00:00Z');

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
    relationships: [
      {
        id: 'rel-1',
        expertProfileId: 'expert-1',
        status: 'eoi_submitted',
        invitedAt: new Date('2025-01-08T00:00:00Z'),
        expertProfile: {
          id: 'expert-1',
          user: { id: 'user-expert', firstName: 'Priya', lastName: 'Nair' },
        },
      },
    ] as ProjectRequestWithRelations['relationships'],
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
      { id: 'rel-1', expertName: 'Priya Nair', status: 'eoi_submitted' },
    ]);
  });

  it('omits the relationships projection for participants', () => {
    const view = mapRequestToDetailView(request(), ctx({ archetype: 'participant' }), NOW);
    expect(view.relationships).toEqual([]);
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
