import { describe, expect, it } from 'vitest';
import type { ProjectRequestWithRelations } from '@balo/db';
import type { SessionUser } from '@/lib/auth/session';
import { resolveEndedTrackView } from './resolve-ended-track-view';

type Relationship = ProjectRequestWithRelations['relationships'][number];

function relationship(overrides: Partial<Relationship> = {}): Relationship {
  return {
    id: 'rel-1',
    expertProfileId: 'expert-1',
    status: 'declined',
    invitedAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-05T00:00:00Z'),
    declinedAt: new Date('2025-01-05T00:00:00Z'),
    declineReason: 'client_declined',
    declinedByUserId: 'user-client',
    expertProfile: {
      id: 'expert-1',
      user: { id: 'user-expert', firstName: 'Priya', lastName: 'Nair' },
    },
    expressionsOfInterest: [],
    proposals: [],
    ...overrides,
  } as Relationship;
}

function request(
  overrides: Partial<ProjectRequestWithRelations> = {}
): ProjectRequestWithRelations {
  return {
    id: 'req-1',
    title: 'CPQ implementation',
    company: { id: 'company-1', name: 'Northwind Industrial' },
    relationships: [relationship()],
    ...overrides,
  } as ProjectRequestWithRelations;
}

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-expert',
    email: 'priya@cloudpeak.test',
    firstName: 'Priya',
    lastName: 'Nair',
    avatarUrl: null,
    activeMode: 'expert',
    onboardingCompleted: true,
    platformRole: 'user',
    companyId: 'company-x',
    companyName: 'Stranger Co',
    companyRole: 'owner',
    expertProfileId: 'expert-1',
    ...overrides,
  } as SessionUser;
}

describe('resolveEndedTrackView', () => {
  it('returns null when the user has no expertProfileId', () => {
    expect(resolveEndedTrackView(user({ expertProfileId: undefined }), request())).toBeNull();
  });

  it('returns null when there is no matching relationship for this expert', () => {
    expect(resolveEndedTrackView(user({ expertProfileId: 'someone-else' }), request())).toBeNull();
  });

  it('returns null when the matching relationship is not declined (still live)', () => {
    const view = resolveEndedTrackView(
      user(),
      request({ relationships: [relationship({ status: 'eoi_submitted' })] })
    );
    expect(view).toBeNull();
  });

  it('returns null when declinedAt/declineReason are missing (data anomaly guard)', () => {
    expect(
      resolveEndedTrackView(
        user(),
        request({ relationships: [relationship({ declinedAt: null })] })
      )
    ).toBeNull();
    expect(
      resolveEndedTrackView(
        user(),
        request({ relationships: [relationship({ declineReason: null })] })
      )
    ).toBeNull();
  });

  it('mode is "request_closed" when declineReason is request_closed', () => {
    const view = resolveEndedTrackView(
      user(),
      request({ relationships: [relationship({ declineReason: 'request_closed' })] })
    );
    expect(view?.mode).toBe('request_closed');
  });

  it('mode is "declined" for a deliberate per-track decline by either actor', () => {
    for (const reason of ['client_declined', 'balo_declined'] as const) {
      const view = resolveEndedTrackView(
        user(),
        request({ relationships: [relationship({ declineReason: reason })] })
      );
      expect(view?.mode).toBe('declined');
    }
  });

  it('carries the title, company name, relationshipId and endedAtIso', () => {
    const view = resolveEndedTrackView(user(), request());
    expect(view).toEqual({
      mode: 'declined',
      relationshipId: 'rel-1',
      title: 'CPQ implementation',
      companyName: 'Northwind Industrial',
      endedAtIso: '2025-01-05T00:00:00.000Z',
      hadProposal: false,
    });
  });

  it('hadProposal is true when the track ever had a proposal row', () => {
    const view = resolveEndedTrackView(
      user(),
      request({ relationships: [relationship({ proposals: [{ id: 'prop-1' }] })] })
    );
    expect(view?.hadProposal).toBe(true);
  });
});
