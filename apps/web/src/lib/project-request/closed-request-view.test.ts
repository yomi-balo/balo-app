import { describe, expect, it } from 'vitest';
import type { ProjectRequestWithRelations } from '@balo/db';
import type { RequestViewerContext } from './resolve-request-lens';
import {
  deriveClosedSummary,
  deriveClosedTracks,
  type ClosedSummaryInput,
} from './closed-request-view';

type Relationship = ProjectRequestWithRelations['relationships'][number];

function relationship(overrides: Partial<Relationship> = {}): Relationship {
  return {
    id: 'rel-1',
    expertProfileId: 'expert-1',
    status: 'declined',
    invitedAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-02T00:00:00Z'),
    availabilitySharedAt: null,
    declinedAt: new Date('2025-01-05T00:00:00Z'),
    declineReason: 'request_closed',
    declinedByUserId: 'user-admin',
    expertProfile: {
      id: 'expert-1',
      ratingAverage: null,
      ratingCount: 0,
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
    status: 'closed',
    title: 'CPQ implementation',
    company: { id: 'company-1', name: 'Northwind Industrial' },
    closedAt: new Date('2026-09-05T10:00:00Z'),
    closedByUserId: 'user-admin',
    closeReason: 'unfilled',
    closeNote: 'Two of three tracks went quiet.',
    relationships: [relationship()],
    ...overrides,
  } as ProjectRequestWithRelations;
}

function ctx(overrides: Partial<RequestViewerContext> = {}): RequestViewerContext {
  return {
    lens: 'client',
    archetype: 'participant',
    isOwner: true,
    isInvitedExpert: false,
    relationshipId: null,
    canSeeContact: false,
    canSeeStaffOnly: false,
    canSeeBaloPanel: false,
    ...overrides,
  };
}

const COUNTS = { tracksEnded: 1, proposalsWithdrawn: 0, meetingsCancelled: 1 };
const INPUT: ClosedSummaryInput = { closedByName: 'Adeeb', counts: COUNTS };

describe('deriveClosedSummary', () => {
  it('returns null when the request is not closed', () => {
    expect(deriveClosedSummary(request({ status: 'requested' }), ctx(), INPUT)).toBeNull();
  });

  it('returns null when input is null (page skipped the extra reads)', () => {
    expect(deriveClosedSummary(request(), ctx(), null)).toBeNull();
  });

  it('returns null when closedAt/closeReason are missing (data anomaly guard)', () => {
    expect(deriveClosedSummary(request({ closedAt: null }), ctx(), INPUT)).toBeNull();
    expect(deriveClosedSummary(request({ closeReason: null }), ctx(), INPUT)).toBeNull();
  });

  it('closedByParty is "client" for withdrawn, "balo" for every admin reason', () => {
    const withdrawn = deriveClosedSummary(request({ closeReason: 'withdrawn' }), ctx(), INPUT);
    expect(withdrawn?.closedByParty).toBe('client');
    for (const reason of ['declined', 'unfilled', 'superseded'] as const) {
      const summary = deriveClosedSummary(request({ closeReason: reason }), ctx(), INPUT);
      expect(summary?.closedByParty).toBe('balo');
    }
  });

  it('closedByLabel names the person "@ org" — Balo for a Balo close, the company for a client close', () => {
    const balo = deriveClosedSummary(request({ closeReason: 'unfilled' }), ctx(), INPUT);
    expect(balo?.closedByLabel).toBe('Adeeb @ Balo');
    const client = deriveClosedSummary(request({ closeReason: 'withdrawn' }), ctx(), INPUT);
    expect(client?.closedByLabel).toBe('Adeeb @ Northwind Industrial');
  });

  it('D11: note is null on a lens without canSeeStaffOnly, populated when it is granted', () => {
    const noStaff = deriveClosedSummary(request(), ctx({ canSeeStaffOnly: false }), INPUT);
    expect(noStaff?.note).toBeNull();
    const staff = deriveClosedSummary(
      request(),
      ctx({ lens: 'admin', archetype: 'observer', canSeeStaffOnly: true }),
      INPUT
    );
    expect(staff?.note).toBe('Two of three tracks went quiet.');
  });

  it('D11 negative: note is null on the EXPERT lens even if closeNote is set', () => {
    const summary = deriveClosedSummary(
      request(),
      ctx({ lens: 'expert', archetype: 'participant', canSeeStaffOnly: false }),
      INPUT
    );
    expect(summary?.note).toBeNull();
  });

  it('carries the counts through unchanged', () => {
    const summary = deriveClosedSummary(request(), ctx(), INPUT);
    expect(summary?.counts).toEqual(COUNTS);
  });
});

describe('deriveClosedTracks', () => {
  it('is empty for a non-closed request', () => {
    expect(deriveClosedTracks(request({ status: 'requested' }))).toEqual([]);
  });

  // The AUDIENCE narrowing (an expert never sees a counterparty track list) moved to the
  // caller, `mapRequestToDetailView`, so this module never names a lens — see its docblock and
  // `request-detail-view.test.ts`'s "expert never sees the counterparty track list".
  it('populates on a closed request', () => {
    const tracks = deriveClosedTracks(request());
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.expertName).toBe('Priya Nair');
    expect(tracks[0]?.expertInitials).toBe('PN');
  });

  it('finalChip is ended_request_closed when declineReason is request_closed', () => {
    const tracks = deriveClosedTracks(
      request({ relationships: [relationship({ declineReason: 'request_closed' })] })
    );
    expect(tracks[0]?.finalChip).toBe('ended_request_closed');
    expect(tracks[0]?.endedLabel).toContain('closed');
  });

  it('finalChip is invite_withdrawn for a deliberate decline with no live EOI (never past a bare invite)', () => {
    for (const reason of ['client_declined', 'balo_declined'] as const) {
      const tracks = deriveClosedTracks(
        request({
          relationships: [relationship({ declineReason: reason, expressionsOfInterest: [] })],
        })
      );
      expect(tracks[0]?.finalChip).toBe('invite_withdrawn');
    }
  });

  it('finalChip is declined for a deliberate decline that had reached at least eoi_submitted', () => {
    for (const reason of ['client_declined', 'balo_declined'] as const) {
      const tracks = deriveClosedTracks(
        request({
          relationships: [
            relationship({
              declineReason: reason,
              expressionsOfInterest: [
                {
                  id: 'eoi-1',
                  submittedAt: new Date('2025-01-02T00:00:00Z'),
                  message: '<p>Hi</p>',
                },
              ],
            }),
          ],
        })
      );
      expect(tracks[0]?.finalChip).toBe('declined');
    }
  });

  it('falls back to "Invited expert" when the expert has no name', () => {
    const tracks = deriveClosedTracks(
      request({
        relationships: [
          relationship({
            expertProfile: {
              id: 'expert-2',
              ratingAverage: null,
              ratingCount: 0,
              user: { id: 'user-expert-2', firstName: null, lastName: null },
            },
          }),
        ],
      })
    );
    expect(tracks[0]?.expertName).toBe('Invited expert');
    // `initialsFor` takes the first letter of the first two WORDS of the fallback name itself
    // ("Invited expert" → "IE") — the "?" fallback is reserved for a genuinely empty string.
    expect(tracks[0]?.expertInitials).toBe('IE');
  });
});
