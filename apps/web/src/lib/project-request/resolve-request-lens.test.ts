import { describe, it, expect } from 'vitest';
import type { ProjectRequestWithRelations } from '@balo/db';
import type { SessionUser } from '@/lib/auth/session';
import {
  resolveRequestLens,
  resolveRequestDenialReason,
  requestPhase,
  BEFORE_INVITE_STATUSES,
  PHASE2_STATUSES,
} from './resolve-request-lens';

const COMPANY_ID = 'company-1';
const OTHER_COMPANY_ID = 'company-2';
const EXPERT_PROFILE_ID = 'expert-1';
const RELATIONSHIP_ID = 'rel-1';

type Relationship = ProjectRequestWithRelations['relationships'][number];

function relationship(overrides: Partial<Relationship> = {}): Relationship {
  return {
    id: RELATIONSHIP_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    status: 'invited',
    invitedAt: new Date('2025-01-01T00:00:00Z'),
    expertProfile: {
      id: EXPERT_PROFILE_ID,
      user: { id: 'user-expert', firstName: 'Priya', lastName: 'Nair' },
    },
    ...overrides,
  } as Relationship;
}

function request(
  overrides: Partial<ProjectRequestWithRelations> = {}
): ProjectRequestWithRelations {
  return {
    id: 'req-1',
    companyId: COMPANY_ID,
    expertProfileId: null,
    createdByUserId: 'user-client',
    sendTo: 'match',
    status: 'requested',
    source: 'manual',
    title: 'CPQ implementation',
    description: '<p>Brief</p>',
    budgetMinCents: null,
    budgetMaxCents: null,
    budgetCurrency: 'aud',
    timeline: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    company: { id: COMPANY_ID, name: 'Northwind Industrial' },
    createdByUser: {
      id: 'user-client',
      firstName: 'Dana',
      lastName: 'Whitfield',
      email: 'dana@northwind.test',
    },
    tags: [],
    products: [],
    documents: [],
    relationships: [],
    ...overrides,
  } as ProjectRequestWithRelations;
}

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-x',
    email: 'x@example.com',
    firstName: 'X',
    lastName: 'Y',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'user',
    companyId: OTHER_COMPANY_ID,
    companyName: 'Stranger Co',
    companyRole: 'owner',
    ...overrides,
  };
}

describe('resolveRequestLens', () => {
  it('resolves the owner company to the client participant lens', () => {
    const ctx = resolveRequestLens(user({ companyId: COMPANY_ID }), request());
    expect(ctx).not.toBeNull();
    expect(ctx?.lens).toBe('client');
    expect(ctx?.archetype).toBe('participant');
    expect(ctx?.isOwner).toBe(true);
    expect(ctx?.relationshipId).toBeNull();
    expect(ctx?.canSeeContact).toBe(false);
  });

  it('resolves an invited expert (live relationship) to the expert lens with relationshipId', () => {
    const ctx = resolveRequestLens(
      user({ companyId: OTHER_COMPANY_ID, expertProfileId: EXPERT_PROFILE_ID }),
      request({ relationships: [relationship()] })
    );
    expect(ctx?.lens).toBe('expert');
    expect(ctx?.archetype).toBe('participant');
    expect(ctx?.isInvitedExpert).toBe(true);
    expect(ctx?.relationshipId).toBe(RELATIONSHIP_ID);
    expect(ctx?.canSeeContact).toBe(true);
  });

  it('resolves a platform admin to the observer lens', () => {
    const ctx = resolveRequestLens(user({ platformRole: 'admin' }), request());
    expect(ctx?.lens).toBe('admin');
    expect(ctx?.archetype).toBe('observer');
    expect(ctx?.relationshipId).toBeNull();
    expect(ctx?.canSeeContact).toBe(true);
  });

  it('resolves a super_admin to the observer lens', () => {
    const ctx = resolveRequestLens(user({ platformRole: 'super_admin' }), request());
    expect(ctx?.lens).toBe('admin');
  });

  it('gives admin precedence over ownership (admin who also owns → observer)', () => {
    const ctx = resolveRequestLens(
      user({ platformRole: 'admin', companyId: COMPANY_ID }),
      request()
    );
    expect(ctx?.lens).toBe('admin');
    expect(ctx?.archetype).toBe('observer');
    // isOwner still reflects the company match for downstream use.
    expect(ctx?.isOwner).toBe(true);
  });

  it('returns null for a stranger (no company, no invite, not admin)', () => {
    const ctx = resolveRequestLens(user(), request());
    expect(ctx).toBeNull();
  });

  it('does not treat an expert with no matching relationship as invited', () => {
    const ctx = resolveRequestLens(
      user({ expertProfileId: 'some-other-expert' }),
      request({ relationships: [relationship()] })
    );
    expect(ctx).toBeNull();
  });

  it('does not treat an expert as invited when they have no expertProfileId', () => {
    const ctx = resolveRequestLens(
      user({ expertProfileId: undefined }),
      request({ relationships: [relationship()] })
    );
    expect(ctx).toBeNull();
  });

  it('only considers live relationships (soft-deleted excluded by the repo query)', () => {
    // The repo filters deletedAt IS NULL, so a removed expert is simply absent
    // from `relationships` — modelled here as an empty list.
    const ctx = resolveRequestLens(
      user({ expertProfileId: EXPERT_PROFILE_ID }),
      request({ relationships: [] })
    );
    expect(ctx).toBeNull();
  });

  it('gates a declined expert fully — a declined relationship grants no access', () => {
    // `declined` stays live (deletedAt IS NULL, declinedAt stamped) but the
    // dropped expert is no longer a participant → notFound() at the page.
    const ctx = resolveRequestLens(
      user({ companyId: OTHER_COMPANY_ID, expertProfileId: EXPERT_PROFILE_ID }),
      request({
        status: 'proposal_submitted',
        relationships: [relationship({ status: 'declined' })],
      })
    );
    expect(ctx).toBeNull();
  });

  it('still resolves an expert with an active (non-declined) relationship at a late status', () => {
    const ctx = resolveRequestLens(
      user({ companyId: OTHER_COMPANY_ID, expertProfileId: EXPERT_PROFILE_ID }),
      request({
        status: 'proposal_submitted',
        relationships: [relationship({ status: 'proposal_submitted' })],
      })
    );
    expect(ctx?.lens).toBe('expert');
    expect(ctx?.isInvitedExpert).toBe(true);
    expect(ctx?.relationshipId).toBe(RELATIONSHIP_ID);
  });

  it('at acceptance: the accepted expert keeps access, a losing finalist (declined) is gated', () => {
    // When the client accepts one expert, losing finalists move to `declined`.
    const acceptedCtx = resolveRequestLens(
      user({ companyId: OTHER_COMPANY_ID, expertProfileId: EXPERT_PROFILE_ID }),
      request({ status: 'accepted', relationships: [relationship({ status: 'accepted' })] })
    );
    expect(acceptedCtx?.lens).toBe('expert');

    const declinedCtx = resolveRequestLens(
      user({ companyId: OTHER_COMPANY_ID, expertProfileId: EXPERT_PROFILE_ID }),
      request({ status: 'accepted', relationships: [relationship({ status: 'declined' })] })
    );
    expect(declinedCtx).toBeNull();
  });

  it('is activeMode-agnostic: an invited expert in client mode still resolves to the expert lens', () => {
    // Authorization derives from the live relationship, not the viewer's UI mode.
    const ctx = resolveRequestLens(
      user({
        companyId: OTHER_COMPANY_ID,
        expertProfileId: EXPERT_PROFILE_ID,
        activeMode: 'client',
      }),
      request({ relationships: [relationship()] })
    );
    expect(ctx?.lens).toBe('expert');
    expect(ctx?.archetype).toBe('participant');
    expect(ctx?.isInvitedExpert).toBe(true);
    expect(ctx?.canSeeContact).toBe(true);
  });

  it('gives owner precedence: a user who both owns the company AND is an invited expert resolves to client', () => {
    // Owner company match (step 2) is checked before the expert relationship
    // (step 3), regardless of activeMode — the owning company always wins.
    const ctx = resolveRequestLens(
      user({
        companyId: COMPANY_ID,
        expertProfileId: EXPERT_PROFILE_ID,
        activeMode: 'expert',
      }),
      request({ relationships: [relationship()] })
    );
    expect(ctx?.lens).toBe('client');
    expect(ctx?.archetype).toBe('participant');
    expect(ctx?.isOwner).toBe(true);
    expect(ctx?.isInvitedExpert).toBe(false);
    expect(ctx?.canSeeContact).toBe(false);
  });

  it('gates contact visibility per lens (client hidden, expert + admin shown)', () => {
    const clientCtx = resolveRequestLens(user({ companyId: COMPANY_ID }), request());
    const expertCtx = resolveRequestLens(
      user({ companyId: OTHER_COMPANY_ID, expertProfileId: EXPERT_PROFILE_ID }),
      request({ relationships: [relationship()] })
    );
    const adminCtx = resolveRequestLens(user({ platformRole: 'admin' }), request());
    expect(clientCtx?.canSeeContact).toBe(false);
    expect(expertCtx?.canSeeContact).toBe(true);
    expect(adminCtx?.canSeeContact).toBe(true);
  });
});

describe('resolveRequestDenialReason', () => {
  it('classifies a declined expert as declined_relationship across post-invite request statuses', () => {
    // The relationship is `declined`; only the surrounding REQUEST status varies
    // — a dropped/declined expert hitting the wall at any phase of the request.
    for (const requestStatus of [
      'experts_invited',
      'eoi_submitted',
      'proposal_submitted',
      'accepted',
    ] as const) {
      const reason = resolveRequestDenialReason(
        user({ companyId: OTHER_COMPANY_ID, expertProfileId: EXPERT_PROFILE_ID }),
        request({
          status: requestStatus,
          relationships: [relationship({ status: 'declined' })],
        })
      );
      expect(reason).toBe('declined_relationship');
    }
  });

  it('returns null for a plain stranger (no event for strangers)', () => {
    expect(resolveRequestDenialReason(user(), request())).toBeNull();
  });

  it('returns null for a live (non-declined) expert — they resolve to the expert lens', () => {
    const reason = resolveRequestDenialReason(
      user({ companyId: OTHER_COMPANY_ID, expertProfileId: EXPERT_PROFILE_ID }),
      request({ relationships: [relationship({ status: 'invited' })] })
    );
    expect(reason).toBeNull();
  });

  it('returns null for the owner (resolves to the client lens, not a denial)', () => {
    expect(resolveRequestDenialReason(user({ companyId: COMPANY_ID }), request())).toBeNull();
  });

  it('returns null for an owner who is ALSO a declined expert (owner-precedence wins)', () => {
    // The companyId match short-circuits before the expert-relationship filter,
    // mirroring resolveRequestLens's owner precedence — so the owner resolves to
    // the client lens, never the declined wall. Locks that ordering against a
    // future reorder that would wrongly emit a declined_relationship event.
    expect(
      resolveRequestDenialReason(
        user({ companyId: COMPANY_ID, expertProfileId: EXPERT_PROFILE_ID }),
        request({ relationships: [relationship({ status: 'declined' })] })
      )
    ).toBeNull();
  });

  it('returns null for a platform admin (observer, never denied)', () => {
    expect(resolveRequestDenialReason(user({ platformRole: 'admin' }), request())).toBeNull();
    expect(resolveRequestDenialReason(user({ platformRole: 'super_admin' }), request())).toBeNull();
  });

  it('returns null for an expert with no matching relationship (a stranger, not declined)', () => {
    const reason = resolveRequestDenialReason(
      user({ companyId: OTHER_COMPANY_ID, expertProfileId: 'some-other-expert' }),
      request({ relationships: [relationship({ status: 'declined' })] })
    );
    expect(reason).toBeNull();
  });

  it('returns null for an expert with no expertProfileId (cannot match any relationship)', () => {
    const reason = resolveRequestDenialReason(
      user({ companyId: OTHER_COMPANY_ID, expertProfileId: undefined }),
      request({ relationships: [relationship({ status: 'declined' })] })
    );
    expect(reason).toBeNull();
  });

  it('returns null when the expert has BOTH a live and a declined matching relationship', () => {
    // A live match anywhere → they still resolve to the expert lens → not denied.
    const reason = resolveRequestDenialReason(
      user({ companyId: OTHER_COMPANY_ID, expertProfileId: EXPERT_PROFILE_ID }),
      request({
        relationships: [
          relationship({ id: 'rel-declined', status: 'declined' }),
          relationship({ id: 'rel-live', status: 'invited' }),
        ],
      })
    );
    expect(reason).toBeNull();
  });
});

describe('requestPhase', () => {
  it('returns phase1 for every before-invite + experts_invited status', () => {
    for (const status of [...BEFORE_INVITE_STATUSES, 'experts_invited'] as const) {
      expect(requestPhase(status)).toBe('phase1');
    }
  });

  it('returns phase2 from eoi_submitted onward', () => {
    for (const status of PHASE2_STATUSES) {
      expect(requestPhase(status)).toBe('phase2');
    }
  });

  it('flips to phase2 exactly at eoi_submitted', () => {
    expect(requestPhase('experts_invited')).toBe('phase1');
    expect(requestPhase('eoi_submitted')).toBe('phase2');
  });
});
