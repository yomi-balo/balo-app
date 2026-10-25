import { describe, it, expect, vi } from 'vitest';
import type { ProjectEngagementWithMilestones } from '@balo/db';

vi.mock('server-only', () => ({}));

import {
  completionModalBody,
  deriveChangeRequestBanner,
  deriveChangeRequestState,
  deriveLastRequest,
  deriveMilestoneFeedback,
  deriveReviewPill,
  deriveSegments,
} from './change-request-view';
import { deriveEngagementParties, type EngagementParties } from './engagement-parties';
import type { EngagementLens } from './resolve-engagement-lens';

type Engagement = ProjectEngagementWithMilestones;
type Milestone = Engagement['milestones'][number];
type Round = NonNullable<Engagement['latestChangeRequest']>;

const DANA = { id: 'u-dana', firstName: 'Dana', lastName: 'Lee' };

function milestone(id: string, status: Milestone['status'], title = id): Milestone {
  return { id, title, status } as Milestone;
}

function round(over: Partial<Round> = {}): Round {
  return {
    id: 'cr-2',
    note: 'The export is missing Q3.',
    requestedAt: new Date('2026-07-06T09:00:00.000Z'),
    requestedBy: DANA,
    taggedMilestoneIds: [],
    ...over,
  };
}

function engagement(over: Partial<Engagement> & { latest?: Round | null } = {}): Engagement {
  const { latest = null, ...rest } = over;
  return {
    id: 'eng-1',
    status: 'active',
    acceptedAt: null,
    milestones: [],
    latestChangeRequest: latest,
    changeRequestRounds: latest === null ? [] : [latest],
    changeRequestRoundCount: latest === null ? 0 : 1,
    company: { id: 'c-1', name: 'Northwind Industrial' },
    expertProfile: {
      type: 'freelancer',
      headline: null,
      agency: null,
      user: { firstName: 'Priya', lastName: 'Sharma' },
    },
    ...rest,
  } as unknown as Engagement;
}

function agencyEngagement(over: Parameters<typeof engagement>[0] = {}): Engagement {
  const base = engagement(over);
  return {
    ...base,
    expertProfile: {
      ...base.expertProfile,
      type: 'agency',
      agency: { id: 'ag-1', name: 'CloudPeak Consulting' },
    },
  } as unknown as Engagement;
}

function parties(e: Engagement): EngagementParties {
  return deriveEngagementParties(e);
}

function banner(e: Engagement, lens: EngagementLens) {
  const p = parties(e);
  return deriveChangeRequestBanner(e, lens, p, deriveChangeRequestState(e, p));
}

const TAGGED_REOPENED = engagement({
  latest: round({ taggedMilestoneIds: ['m2'] }),
  milestones: [
    milestone('m1', 'completed', 'Discovery'),
    milestone('m2', 'in_progress', 'Build'),
    milestone('m3', 'pending', 'Launch'),
  ],
});

const CHANGES_MADE = engagement({
  latest: round({ taggedMilestoneIds: ['m2'] }),
  milestones: [milestone('m1', 'completed', 'Discovery'), milestone('m2', 'completed', 'Build')],
});

const UNTAGGED_ALL_DONE = engagement({
  latest: round(),
  milestones: [milestone('m1', 'completed', 'Discovery'), milestone('m2', 'completed', 'Build')],
});

describe('deriveChangeRequestState', () => {
  it('is not outstanding before any round', () => {
    const e = engagement({ milestones: [milestone('m1', 'completed')] });
    const state = deriveChangeRequestState(e, parties(e));
    expect(state).toMatchObject({ latest: null, outstanding: false, changesMade: false });
  });

  it('uses the LAST round only: an earlier round that tagged other milestones is ignored', () => {
    const earlier = round({ id: 'cr-1', taggedMilestoneIds: ['m1'], note: 'old' });
    const latest = round({ taggedMilestoneIds: ['m2'] });
    const e = engagement({
      latest,
      changeRequestRounds: [earlier, latest],
      changeRequestRoundCount: 2,
      milestones: [milestone('m1', 'in_progress'), milestone('m2', 'in_progress')],
    });
    const state = deriveChangeRequestState(e, parties(e));
    expect(state.taggedLive.map((m) => m.id)).toEqual(['m2']);
    expect(state.attribution).toBe('Dana @ Northwind Industrial');
    expect(state.requesterShort).toBe('Dana');
    expect(state.dateLabel).toBe('6 Jul');
  });

  it('a round is outstanding only while the project is active', () => {
    const inReview = { ...TAGGED_REOPENED, status: 'pending_acceptance' } as Engagement;
    expect(deriveChangeRequestState(inReview, parties(inReview)).outstanding).toBe(false);
    expect(deriveChangeRequestState(TAGGED_REOPENED, parties(TAGGED_REOPENED)).outstanding).toBe(
      true
    );
  });

  it('a tag on a soft-deleted (absent) milestone is ignored', () => {
    const e = engagement({
      latest: round({ taggedMilestoneIds: ['gone'] }),
      milestones: [milestone('m1', 'completed')],
    });
    const state = deriveChangeRequestState(e, parties(e));
    expect(state.taggedLive).toEqual([]);
    expect(state.changesMade).toBe(false);
  });

  it('changesMade needs a tagged milestone, none reopened and the whole plan complete', () => {
    expect(deriveChangeRequestState(CHANGES_MADE, parties(CHANGES_MADE)).changesMade).toBe(true);
    expect(deriveChangeRequestState(TAGGED_REOPENED, parties(TAGGED_REOPENED)).changesMade).toBe(
      false
    );
    // An untagged round never turns violet, even with everything complete.
    expect(
      deriveChangeRequestState(UNTAGGED_ALL_DONE, parties(UNTAGGED_ALL_DONE)).changesMade
    ).toBe(false);
    // Tagged milestone done again but another milestone (added since) is still open.
    const extra = engagement({
      latest: round({ taggedMilestoneIds: ['m1'] }),
      milestones: [milestone('m1', 'completed'), milestone('m2', 'in_progress')],
    });
    expect(deriveChangeRequestState(extra, parties(extra)).changesMade).toBe(false);
  });
});

describe('deriveChangeRequestBanner', () => {
  it('is null when nothing is outstanding', () => {
    const e = engagement();
    expect(banner(e, 'expert')).toBeNull();
    expect(banner(e, 'client')).toBeNull();
    expect(
      banner({ ...TAGGED_REOPENED, status: 'pending_acceptance' } as Engagement, 'expert')
    ).toBeNull();
  });

  it('expert · tagged and reopened: names the milestones and says what to do', () => {
    expect(banner(TAGGED_REOPENED, 'expert')).toEqual({
      variant: 'work_outstanding',
      headline: 'Dana @ Northwind Industrial requested changes on Build.',
      quote: 'The export is missing Q3.',
      guidance: 'Build is back in progress. Complete it, then mark the project ready again.',
    });
  });

  it('expert · several reopened: plural guidance', () => {
    const e = engagement({
      latest: round({ taggedMilestoneIds: ['m1', 'm2', 'm3'] }),
      milestones: [
        milestone('m1', 'in_progress', 'Discovery'),
        milestone('m2', 'in_progress', 'Build'),
        milestone('m3', 'completed', 'Launch'),
      ],
    });
    expect(banner(e, 'expert')).toMatchObject({
      headline: 'Dana @ Northwind Industrial requested changes on Discovery, Build and Launch.',
      guidance:
        'Discovery and Build are back in progress. Complete them, then mark the project ready again.',
    });
  });

  it('expert · tagged milestones all done but the plan is not: finish the rest', () => {
    const e = engagement({
      latest: round({ taggedMilestoneIds: ['m1'] }),
      milestones: [milestone('m1', 'completed', 'Discovery'), milestone('m2', 'pending', 'Build')],
    });
    expect(banner(e, 'expert')).toMatchObject({
      variant: 'work_outstanding',
      guidance:
        'Your changes are in. Finish the remaining milestones, then mark the project ready again.',
    });
  });

  it('expert · untagged round: no "on …" and the reopen-whatever guidance, never changes_made', () => {
    expect(banner(UNTAGGED_ALL_DONE, 'expert')).toEqual({
      variant: 'work_outstanding',
      headline: 'Dana @ Northwind Industrial requested changes.',
      quote: 'The export is missing Q3.',
      guidance:
        'No milestones were tagged, so reopen whatever needs work, then mark the project ready again.',
    });
  });

  it('expert · changes made: violet variant with the one CTA and the shared modal body', () => {
    expect(banner(CHANGES_MADE, 'expert')).toEqual({
      variant: 'changes_made',
      headline: 'Changes made. Ready to send back to Northwind Industrial?',
      reminder: 'Dana @ Northwind Industrial asked: “The export is missing Q3.”',
      ctaLabel: 'Mark project ready again',
      modalBody: completionModalBody(2, 'Northwind Industrial'),
    });
  });

  it('admin · outstanding: same facts, no guidance, never the CTA variant', () => {
    expect(banner(CHANGES_MADE, 'admin')).toMatchObject({
      variant: 'work_outstanding',
      guidance: null,
    });
    expect(banner(TAGGED_REOPENED, 'admin')).toMatchObject({ guidance: null });
  });

  it('client · names the expert party: the agency when there is one, else the person', () => {
    expect(banner(TAGGED_REOPENED, 'client')).toEqual({
      variant: 'client_waiting',
      body: "You requested changes on Build. Priya is working on them, and you'll be told when the project is ready again.",
    });
    const agency = agencyEngagement({
      latest: round({ taggedMilestoneIds: ['m2'] }),
      milestones: [milestone('m2', 'in_progress', 'Build')],
    });
    expect(banner(agency, 'client')).toMatchObject({
      body: expect.stringContaining('CloudPeak Consulting is working on them'),
    });
  });

  it('client · untagged round omits the "on …" clause', () => {
    expect(banner(UNTAGGED_ALL_DONE, 'client')).toMatchObject({
      body: expect.stringMatching(/^You requested changes\. Priya is working/),
    });
  });
});

describe('deriveReviewPill', () => {
  function pill(e: Engagement, lens: EngagementLens) {
    const p = parties(e);
    return deriveReviewPill(e, lens, p, deriveChangeRequestState(e, p));
  }

  it('an outstanding round beats every other state, and never reads as success', () => {
    expect(pill(UNTAGGED_ALL_DONE, 'expert')).toEqual({
      label: 'Changes requested',
      tone: 'warning',
    });
    expect(pill(UNTAGGED_ALL_DONE, 'client')?.tone).not.toBe('success');
  });

  it('pending_acceptance: the client is asked, everyone else is waiting on the client', () => {
    const e = engagement({ status: 'pending_acceptance' });
    expect(pill(e, 'client')).toEqual({ label: 'Ready for your review', tone: 'violet' });
    expect(pill(e, 'expert')).toEqual({ label: 'Waiting on Northwind Industrial', tone: 'violet' });
    expect(pill(e, 'admin')?.label).toBe('Waiting on Northwind Industrial');
  });

  it('completed: carries the accepted date, or plain "Accepted" without one', () => {
    expect(
      pill(
        engagement({ status: 'completed', acceptedAt: new Date('2026-07-30T00:00:00Z') }),
        'client'
      )
    ).toEqual({ label: 'Accepted 30 Jul', tone: 'success' });
    expect(pill(engagement({ status: 'completed' }), 'client')?.label).toBe('Accepted');
  });

  it('is null for an ordinary active project and for a cancelled one', () => {
    expect(pill(engagement(), 'expert')).toBeNull();
    expect(pill(engagement({ status: 'cancelled' }), 'expert')).toBeNull();
  });
});

describe('deriveSegments', () => {
  function segments(e: Engagement) {
    return deriveSegments(e, deriveChangeRequestState(e, parties(e)));
  }

  it('maps status to tone and labels each segment with its milestone', () => {
    const e = engagement({
      milestones: [
        milestone('m1', 'completed', 'Discovery'),
        milestone('m2', 'in_progress', 'Build'),
        milestone('m3', 'pending', 'Launch'),
      ],
    });
    expect(segments(e)).toEqual([
      { id: 'm1', tone: 'completed', label: 'Discovery: Completed' },
      { id: 'm2', tone: 'in_progress', label: 'Build: In progress' },
      { id: 'm3', tone: 'pending', label: 'Launch: Not started' },
    ]);
  });

  it('a tagged, not-yet-complete milestone reads reopened; a tagged complete one reads completed', () => {
    const e = engagement({
      latest: round({ taggedMilestoneIds: ['m1', 'm2'] }),
      milestones: [
        milestone('m1', 'completed', 'Discovery'),
        milestone('m2', 'in_progress', 'Build'),
      ],
    });
    expect(segments(e)).toEqual([
      { id: 'm1', tone: 'completed', label: 'Discovery: Completed' },
      { id: 'm2', tone: 'reopened', label: 'Build: Changes requested' },
    ]);
  });

  it('nothing reads reopened once the project is no longer active', () => {
    const e = { ...TAGGED_REOPENED, status: 'completed' } as Engagement;
    expect(segments(e).some((segment) => segment.tone === 'reopened')).toBe(false);
  });
});

describe('deriveMilestoneFeedback', () => {
  function feedback(e: Engagement, id: string, lens: EngagementLens) {
    return deriveMilestoneFeedback(e, deriveChangeRequestState(e, parties(e)), id, lens);
  }

  it('client lens: first-person heading and "Updated after your feedback"', () => {
    expect(feedback(TAGGED_REOPENED, 'm2', 'client')).toEqual({
      calloutHeading: 'Your feedback · 6 Jul',
      note: 'The export is missing Q3.',
      addressedLabel: 'Updated after your feedback',
    });
  });

  it('expert and admin lenses: the bare first name (the banner made the first mention)', () => {
    for (const lens of ['expert', 'admin'] as const) {
      expect(feedback(TAGGED_REOPENED, 'm2', lens)).toMatchObject({
        calloutHeading: 'Dana requested changes · 6 Jul',
        addressedLabel: 'Feedback addressed',
      });
    }
  });

  it('is null for an untagged milestone, before any round, and on terminal projects', () => {
    expect(feedback(TAGGED_REOPENED, 'm1', 'expert')).toBeNull();
    expect(
      feedback(engagement({ milestones: [milestone('m1', 'pending')] }), 'm1', 'expert')
    ).toBeNull();
    expect(
      feedback({ ...TAGGED_REOPENED, status: 'completed' } as Engagement, 'm2', 'expert')
    ).toBeNull();
    expect(
      feedback({ ...TAGGED_REOPENED, status: 'cancelled' } as Engagement, 'm2', 'expert')
    ).toBeNull();
  });

  it('stays on while the resubmitted project is in review (the addressed chip needs it)', () => {
    const inReview = { ...CHANGES_MADE, status: 'pending_acceptance' } as Engagement;
    expect(feedback(inReview, 'm2', 'client')).not.toBeNull();
  });
});

describe('deriveLastRequest', () => {
  it('is null before any round and quotes the latest round after one', () => {
    expect(deriveLastRequest(engagement())).toBeNull();
    expect(deriveLastRequest(engagement({ latest: round() }))).toEqual({
      heading: 'Your last request · 6 Jul',
      note: 'The export is missing Q3.',
    });
  });
});

describe('completionModalBody', () => {
  it.each([
    [0, "This project has no milestones, so there's nothing blocking completion"],
    [1, 'The milestone is delivered. Northwind reviews the whole project'],
    [3, 'All 3 milestones are delivered. Northwind reviews the whole project'],
  ])('opens correctly for %i milestones', (total, opening) => {
    expect(completionModalBody(total, 'Northwind')).toContain(opening);
  });

  it('states the window, the plan lock and the invoice', () => {
    const body = completionModalBody(2, 'Northwind');
    expect(body).toContain('within 7 days');
    expect(body).toContain('The delivery plan is locked while the project is in review');
    expect(body).toContain('Balo raises the final invoice once accepted');
  });
});
