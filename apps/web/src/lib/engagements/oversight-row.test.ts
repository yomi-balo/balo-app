import { describe, it, expect } from 'vitest';

import type { AdminEngagementListItem } from '@balo/db';
import type { PlatformRole } from '@balo/shared/parties';
import {
  deriveOversightCounts,
  deriveOversightRow,
  isEngagementStalled,
  oversightRowMatchesFilter,
  type EngagementOversightRow,
} from './oversight-row';

const NOW = new Date('2026-06-16T12:00:00.000Z');
const AUTO_ACCEPT_DAYS = 7;
const OPTS = { autoAcceptDays: AUTO_ACCEPT_DAYS };

/** `NOW` minus `n` whole days. */
const day = (n: number): Date => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

interface ItemOpts {
  status?: AdminEngagementListItem['status'];
  companyName?: string;
  expertFirstName?: string | null;
  expertLastName?: string | null;
  agencyName?: string | null;
  projectTitle?: string | null;
  pricingMethod?: 'fixed' | 'tm';
  priceCents?: number;
  rateCents?: number | null;
  currency?: string;
  activatedAt?: Date | null;
  createdAt?: Date;
  lastActivityAt?: Date | null;
  completedMilestones?: number;
  totalMilestones?: number;
  completionRequestedAt?: Date | null;
  acceptanceMethod?: 'client' | 'auto' | null;
  acceptedBy?: ActorOpt | null;
  acceptedAt?: Date | null;
  cancelledBy?: ActorOpt | null;
  cancelledAt?: Date | null;
  cancellationReason?: string | null;
}

/** An accept/cancel actor: name parts + optional id (defaults non-expert) + role. */
interface ActorOpt {
  id?: string;
  firstName: string | null;
  lastName: string | null;
  platformRole?: PlatformRole;
}

function buildItem(opts: ItemOpts = {}): AdminEngagementListItem {
  const {
    status = 'active',
    companyName = 'Northwind',
    expertFirstName = 'Sam',
    expertLastName = 'Expert',
    agencyName = null,
    projectTitle = 'CPQ rollout',
    pricingMethod = 'fixed',
    priceCents = 4_000_000,
    rateCents = null,
    currency = 'aud',
    activatedAt = day(20),
    createdAt = day(25),
    lastActivityAt = day(2),
    completedMilestones = 2,
    totalMilestones = 5,
    completionRequestedAt = null,
    acceptanceMethod = null,
    acceptedBy = null,
    acceptedAt = null,
    cancelledBy = null,
    cancelledAt = null,
    cancellationReason = null,
  } = opts;

  const item = {
    id: 'eng-1',
    status,
    pricingMethod,
    priceCents,
    rateCents,
    currency,
    activatedAt,
    createdAt,
    completionRequestedAt,
    acceptanceMethod,
    acceptedAt,
    cancelledAt,
    cancellationReason,
    company: { id: 'company-1', name: companyName },
    expertProfile: {
      id: 'ep-1',
      agencyId: agencyName === null ? null : 'agency-1',
      type: agencyName === null ? 'freelancer' : 'agency',
      headline: null,
      user: { id: 'u-1', firstName: expertFirstName, lastName: expertLastName, avatarUrl: null },
      agency: agencyName === null ? null : { id: 'agency-1', name: agencyName, logoUrl: null },
    },
    projectRequest: projectTitle === null ? null : { id: 'req-1', title: projectTitle },
    acceptedBy: acceptedBy === null ? null : { id: 'acc-1', platformRole: 'user', ...acceptedBy },
    cancelledBy:
      cancelledBy === null ? null : { id: 'can-1', platformRole: 'user', ...cancelledBy },
    totalMilestones,
    completedMilestones,
    inProgressMilestones: 0,
    lastActivityAt,
  };

  return item as unknown as AdminEngagementListItem;
}

describe('isEngagementStalled', () => {
  it('is not stalled 13 days quiet (below the boundary)', () => {
    expect(isEngagementStalled(buildItem({ lastActivityAt: day(13) }), NOW)).toBe(false);
  });

  it('is stalled exactly at the 14-day boundary', () => {
    expect(isEngagementStalled(buildItem({ lastActivityAt: day(14) }), NOW)).toBe(true);
  });

  it('is not stalled for a fresh kickoff (activity today)', () => {
    expect(isEngagementStalled(buildItem({ lastActivityAt: day(0) }), NOW)).toBe(false);
  });

  it('flags a quiet pending_acceptance engagement (in-review eligible)', () => {
    const item = buildItem({ status: 'pending_acceptance', lastActivityAt: day(20) });
    expect(isEngagementStalled(item, NOW)).toBe(true);
  });

  it('is never stalled for completed or cancelled, however quiet', () => {
    expect(
      isEngagementStalled(buildItem({ status: 'completed', lastActivityAt: day(60) }), NOW)
    ).toBe(false);
    expect(
      isEngagementStalled(buildItem({ status: 'cancelled', lastActivityAt: day(60) }), NOW)
    ).toBe(false);
  });

  it('is not stalled when there is no activity signal', () => {
    expect(isEngagementStalled(buildItem({ lastActivityAt: null }), NOW)).toBe(false);
  });
});

describe('deriveOversightRow — core fields', () => {
  it('builds the href, status, progress and stalled/quietDays', () => {
    const row = deriveOversightRow(buildItem({ lastActivityAt: day(14) }), NOW, OPTS);
    expect(row.id).toBe('eng-1');
    expect(row.href).toBe('/engagements/eng-1');
    expect(row.status).toBe('active');
    expect(row.progress).toEqual({ done: 2, total: 5 });
    expect(row.stalled).toBe(true);
    expect(row.quietDays).toBe(14);
    expect(row.kickoffIso).toBe(day(20).toISOString());
    expect(row.lastActivityIso).toBe(day(14).toISOString());
  });

  it('uses createdAt and quietDays 0 when there is no activity signal', () => {
    const created = day(9);
    const row = deriveOversightRow(
      buildItem({ lastActivityAt: null, createdAt: created }),
      NOW,
      OPTS
    );
    expect(row.quietDays).toBe(0);
    expect(row.stalled).toBe(false);
    expect(row.lastActivityIso).toBe(created.toISOString());
  });

  it('clamps quietDays to 0 when last activity is (skewed) ahead of now', () => {
    const row = deriveOversightRow(buildItem({ lastActivityAt: day(-1) }), NOW, OPTS);
    expect(row.quietDays).toBe(0);
    expect(row.stalled).toBe(false);
  });
});

describe('deriveOversightRow — title fallback', () => {
  it('uses the project request title when present', () => {
    expect(deriveOversightRow(buildItem({ projectTitle: 'Data migration' }), NOW, OPTS).title).toBe(
      'Data migration'
    );
  });

  it('falls back to "{company} engagement" for a provenance-less engagement', () => {
    const row = deriveOversightRow(
      buildItem({ projectTitle: null, companyName: 'Acme' }),
      NOW,
      OPTS
    );
    expect(row.title).toBe('Acme engagement');
  });
});

describe('deriveOversightRow — expert attribution', () => {
  it('appends the agency for an agency expert', () => {
    const row = deriveOversightRow(
      buildItem({ expertFirstName: 'Sam', expertLastName: 'Expert', agencyName: 'Acme' }),
      NOW,
      OPTS
    );
    expect(row.expertLabel).toBe('Sam Expert @ Acme');
  });

  it('shows the person only for an independent expert', () => {
    const row = deriveOversightRow(
      buildItem({ expertFirstName: 'Sam', expertLastName: 'Expert', agencyName: null }),
      NOW,
      OPTS
    );
    expect(row.expertLabel).toBe('Sam Expert');
  });
});

describe('deriveOversightRow — pricing', () => {
  it('formats a fixed-price engagement (AUD)', () => {
    const row = deriveOversightRow(
      buildItem({ pricingMethod: 'fixed', priceCents: 4_000_000, currency: 'aud' }),
      NOW,
      OPTS
    );
    expect(row.pricingLabel).toBe('Fixed · A$40,000');
  });

  it('formats a time-and-materials engagement (rate + cap)', () => {
    const row = deriveOversightRow(
      buildItem({ pricingMethod: 'tm', rateCents: 22_000, priceCents: 4_000_000, currency: 'aud' }),
      NOW,
      OPTS
    );
    expect(row.pricingLabel).toBe('T&M · A$220/hr · cap A$40,000');
  });

  it('keeps cents on a non-whole-dollar T&M rate', () => {
    const row = deriveOversightRow(
      buildItem({ pricingMethod: 'tm', rateCents: 18_750, priceCents: 4_000_000, currency: 'aud' }),
      NOW,
      OPTS
    );
    expect(row.pricingLabel).toBe('T&M · A$187.50/hr · cap A$40,000');
  });

  it('uses the uppercased code for a non-AUD currency', () => {
    const row = deriveOversightRow(
      buildItem({ pricingMethod: 'fixed', priceCents: 4_000_000, currency: 'usd' }),
      NOW,
      OPTS
    );
    expect(row.pricingLabel).toBe('Fixed · USD 40,000');
  });
});

describe('deriveOversightRow — in-review auto-accept fact', () => {
  it('states the auto-accept date (completionRequestedAt + AUTO_ACCEPT_DAYS)', () => {
    const row = deriveOversightRow(
      buildItem({
        status: 'pending_acceptance',
        completionRequestedAt: new Date('2026-06-10T00:00:00.000Z'),
      }),
      NOW,
      OPTS
    );
    expect(row.autoAcceptIso).toBe('2026-06-17T00:00:00.000Z');
  });

  it('omits the fact when completionRequestedAt is null', () => {
    const row = deriveOversightRow(
      buildItem({ status: 'pending_acceptance', completionRequestedAt: null }),
      NOW,
      OPTS
    );
    expect(row.autoAcceptIso).toBeUndefined();
  });
});

describe('deriveOversightRow — completed acceptance attribution', () => {
  it('names the client accepter @ company', () => {
    const row = deriveOversightRow(
      buildItem({
        status: 'completed',
        acceptanceMethod: 'client',
        acceptedBy: { firstName: 'Cleo', lastName: 'Client' },
        acceptedAt: new Date('2026-06-03T00:00:00.000Z'),
        companyName: 'Northwind',
      }),
      NOW,
      OPTS
    );
    expect(row.acceptance).toEqual({
      method: 'client',
      byLabel: 'Cleo Client @ Northwind',
      onIso: '2026-06-03T00:00:00.000Z',
    });
  });

  it('carries a null byLabel on the auto-accept path', () => {
    const row = deriveOversightRow(
      buildItem({
        status: 'completed',
        acceptanceMethod: 'auto',
        acceptedBy: null,
        acceptedAt: new Date('2026-06-03T00:00:00.000Z'),
      }),
      NOW,
      OPTS
    );
    expect(row.acceptance).toEqual({
      method: 'auto',
      byLabel: null,
      onIso: '2026-06-03T00:00:00.000Z',
    });
  });
});

describe('deriveOversightRow — cancellation attribution (derived, not hard-coded)', () => {
  it('names a Balo-staff canceller "{name} @ Balo" with the reason', () => {
    const row = deriveOversightRow(
      buildItem({
        status: 'cancelled',
        cancelledBy: { firstName: 'Ada', lastName: 'Admin', platformRole: 'admin' },
        cancelledAt: new Date('2026-05-28T00:00:00.000Z'),
        cancellationReason: 'Client paused the program',
      }),
      NOW,
      OPTS
    );
    expect(row.cancellation).toEqual({
      byLabel: 'Ada Admin @ Balo',
      onIso: '2026-05-28T00:00:00.000Z',
      reason: 'Client paused the program',
    });
  });

  it('names a client-member canceller "{name} @ company"', () => {
    const row = deriveOversightRow(
      buildItem({
        status: 'cancelled',
        companyName: 'Northwind',
        cancelledBy: {
          id: 'client-7',
          firstName: 'Cleo',
          lastName: 'Client',
          platformRole: 'user',
        },
        cancelledAt: new Date('2026-05-28T00:00:00.000Z'),
      }),
      NOW,
      OPTS
    );
    expect(row.cancellation?.byLabel).toBe('Cleo Client @ Northwind');
  });

  it('names the engagement expert canceller by the expert label (@ agency)', () => {
    const row = deriveOversightRow(
      buildItem({
        status: 'cancelled',
        agencyName: 'Northstar',
        // actor.id matches the seeded expert user id ('u-1') → the expert-party branch.
        cancelledBy: { id: 'u-1', firstName: 'Sam', lastName: 'Expert', platformRole: 'user' },
        cancelledAt: new Date('2026-05-28T00:00:00.000Z'),
      }),
      NOW,
      OPTS
    );
    expect(row.cancellation?.byLabel).toBe('Sam Expert @ Northstar');
  });

  it('carries a null byLabel and empty reason when neither is set', () => {
    const row = deriveOversightRow(
      buildItem({
        status: 'cancelled',
        cancelledBy: null,
        cancelledAt: new Date('2026-05-28T00:00:00.000Z'),
        cancellationReason: null,
      }),
      NOW,
      OPTS
    );
    expect(row.cancellation).toEqual({
      byLabel: null,
      onIso: '2026-05-28T00:00:00.000Z',
      reason: '',
    });
  });
});

describe('oversightRowMatchesFilter', () => {
  const activeRow = deriveOversightRow(
    buildItem({ status: 'active', lastActivityAt: day(1) }),
    NOW,
    OPTS
  );
  const inReviewFresh = deriveOversightRow(
    buildItem({ status: 'pending_acceptance', lastActivityAt: day(1) }),
    NOW,
    OPTS
  );
  const inReviewStalled = deriveOversightRow(
    buildItem({ status: 'pending_acceptance', lastActivityAt: day(30) }),
    NOW,
    OPTS
  );
  const completedRow = deriveOversightRow(buildItem({ status: 'completed' }), NOW, OPTS);
  const cancelledRow = deriveOversightRow(buildItem({ status: 'cancelled' }), NOW, OPTS);

  it('in_flight matches active and pending_acceptance only', () => {
    expect(oversightRowMatchesFilter(activeRow, 'in_flight')).toBe(true);
    expect(oversightRowMatchesFilter(inReviewFresh, 'in_flight')).toBe(true);
    expect(oversightRowMatchesFilter(completedRow, 'in_flight')).toBe(false);
    expect(oversightRowMatchesFilter(cancelledRow, 'in_flight')).toBe(false);
  });

  it('active / in_review / completed / cancelled match their exact status', () => {
    expect(oversightRowMatchesFilter(activeRow, 'active')).toBe(true);
    expect(oversightRowMatchesFilter(inReviewFresh, 'in_review')).toBe(true);
    expect(oversightRowMatchesFilter(completedRow, 'completed')).toBe(true);
    expect(oversightRowMatchesFilter(cancelledRow, 'cancelled')).toBe(true);
    expect(oversightRowMatchesFilter(activeRow, 'in_review')).toBe(false);
  });

  it('stalled matches the cross-cutting flag — an in-review stalled row appears under both', () => {
    expect(inReviewStalled.stalled).toBe(true);
    expect(oversightRowMatchesFilter(inReviewStalled, 'stalled')).toBe(true);
    expect(oversightRowMatchesFilter(inReviewStalled, 'in_review')).toBe(true);
    expect(oversightRowMatchesFilter(inReviewFresh, 'stalled')).toBe(false);
  });
});

describe('deriveOversightCounts', () => {
  it('counts each status plus the cross-cutting stalled slice', () => {
    const rows: EngagementOversightRow[] = [
      deriveOversightRow(buildItem({ status: 'active', lastActivityAt: day(1) }), NOW, OPTS),
      deriveOversightRow(buildItem({ status: 'active', lastActivityAt: day(30) }), NOW, OPTS),
      deriveOversightRow(
        buildItem({ status: 'pending_acceptance', lastActivityAt: day(30) }),
        NOW,
        OPTS
      ),
      deriveOversightRow(buildItem({ status: 'completed' }), NOW, OPTS),
      deriveOversightRow(buildItem({ status: 'cancelled' }), NOW, OPTS),
    ];

    expect(deriveOversightCounts(rows)).toEqual({
      active: 2,
      inReview: 1,
      stalled: 2,
      completed: 1,
      cancelled: 1,
    });
  });

  it('is all-zero for an empty list', () => {
    expect(deriveOversightCounts([])).toEqual({
      active: 0,
      inReview: 0,
      stalled: 0,
      completed: 0,
      cancelled: 0,
    });
  });
});
