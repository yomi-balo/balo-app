import { describe, it, expect } from 'vitest';
import type {
  ProjectEngagementWithMilestones,
  TimeEntryAuthorScope,
  TimeEntryListRow,
  TimeEntrySums,
} from '@balo/db';
import { makeMilestone, makeProject } from '@/test/change-order-fixtures';
import { mapTimeToView, type WorkspaceTimeView } from './time-view';
import type { EngagementViewerContext } from './resolve-engagement-lens';

const VIEWER = 'user-charles';
const MS = 'ms-1';

const period = { startOn: '2026-10-01', endOn: '2026-11-01', nextInvoiceOn: '2026-11-01' };

function ctx(lens: EngagementViewerContext['lens']): EngagementViewerContext {
  return { lens, archetype: 'participant' } as EngagementViewerContext;
}

function entry(over: Partial<TimeEntryListRow> = {}): TimeEntryListRow {
  return {
    id: 'te-1',
    engagementMilestoneId: MS,
    userId: VIEWER,
    authorFirstName: 'Charles',
    updatedByUserId: null,
    editorFirstName: null,
    editorLastName: null,
    workedOn: '2026-10-14',
    minutes: 90,
    note: 'Mapped the flows',
    createdAt: new Date('2026-10-14T10:00:00Z'),
    ...over,
  };
}

function sums(over: Partial<TimeEntrySums> = {}): TimeEntrySums {
  return { totalMinutes: 90, periodMinutes: 90, byMilestone: { [MS]: 90 }, ...over };
}

function project(
  milestoneOver: Partial<ProjectEngagementWithMilestones['milestones'][number]> = {},
  over: Partial<ProjectEngagementWithMilestones> = {}
): ProjectEngagementWithMilestones {
  return makeProject({
    pricingMethod: 'tm',
    cadence: 'monthly',
    rateCents: 15_000,
    milestones: [
      makeMilestone({
        id: MS,
        title: 'Build',
        status: 'in_progress',
        estimatedMinutes: 480,
        ...milestoneOver,
      }),
    ],
    ...over,
  });
}

function view(
  engagement: ProjectEngagementWithMilestones,
  over: {
    lens?: EngagementViewerContext['lens'];
    entries?: TimeEntryListRow[];
    sums?: TimeEntrySums;
    canLogTime?: boolean;
    timeEntryScope?: TimeEntryAuthorScope | null;
    period?: typeof period | null;
    notifiedMilestoneIds?: string[];
  } = {}
): WorkspaceTimeView {
  const result = mapTimeToView({
    engagement,
    ctx: ctx(over.lens ?? 'expert'),
    entries: over.entries ?? [entry()],
    sums: over.sums ?? sums(),
    period: over.period === undefined ? period : over.period,
    viewerUserId: VIEWER,
    canLogTime: over.canLogTime ?? true,
    timeEntryScope: over.timeEntryScope === undefined ? 'own' : over.timeEntryScope,
    notifiedMilestoneIds: over.notifiedMilestoneIds ?? [],
  });
  if (result === null) throw new Error('expected a time view');
  return result;
}

function milestone(v: WorkspaceTimeView) {
  const m = v.byMilestoneId[MS];
  if (m === undefined) throw new Error('missing milestone view');
  return m;
}

describe('mapTimeToView', () => {
  it('is null unless the project is time and materials', () => {
    const fixed = makeProject({ pricingMethod: 'fixed' });
    expect(
      mapTimeToView({
        engagement: fixed,
        ctx: ctx('expert'),
        entries: [],
        sums: sums(),
        period,
        viewerUserId: VIEWER,
        canLogTime: true,
        timeEntryScope: null,
        notifiedMilestoneIds: [],
      })
    ).toBeNull();
  });

  describe('milestone bar', () => {
    it.each([
      [0, 'ok', null],
      [383, 'ok', null],
      [384, 'near', '1.6 hrs left of estimate'],
      [480, 'near', '0 hrs left of estimate'],
      [481, 'over', '0.02 hrs over estimate'],
      [570, 'over', '1.5 hrs over estimate'],
    ] as const)('%i of 480 minutes is %s', (logged, tone, remaining) => {
      const v = milestone(view(project(), { sums: sums({ byMilestone: { [MS]: logged } }) }));
      expect(v.tone).toBe(tone);
      expect(v.remainingLabel).toBe(remaining);
    });

    it('labels the logged hours against the estimate and caps the fill at 100', () => {
      const v = milestone(view(project(), { sums: sums({ byMilestone: { [MS]: 570 } }) }));
      expect(v.loggedLabel).toBe('9.5 of 8 hrs logged');
      expect(v.fillPercent).toBe(100);
      const half = milestone(view(project(), { sums: sums({ byMilestone: { [MS]: 240 } }) }));
      expect(half.fillPercent).toBe(50);
    });

    it('a milestone with no estimate shows hours logged and never crosses', () => {
      const v = milestone(
        view(project({ estimatedMinutes: null }), {
          sums: sums({ byMilestone: { [MS]: 9000 } }),
        })
      );
      expect(v).toMatchObject({
        tone: 'ok',
        fillPercent: 0,
        loggedLabel: '150 hrs logged',
        remainingLabel: null,
        estimatedMinutes: null,
      });
    });

    it('a zero estimate is real: any time is over it and fills the bar', () => {
      const v = milestone(
        view(project({ estimatedMinutes: 0 }), { sums: sums({ byMilestone: { [MS]: 60 } }) })
      );
      expect(v).toMatchObject({
        tone: 'over',
        fillPercent: 100,
        remainingLabel: '1 hr over estimate',
      });
    });

    it('a milestone with nothing logged reads 0 hrs', () => {
      const v = milestone(view(project(), { entries: [], sums: sums({ byMilestone: {} }) }));
      expect(v.loggedLabel).toBe('0 of 8 hrs logged');
    });
  });

  describe('entries and permissions', () => {
    it('lists the entry with a short UTC date and hours label', () => {
      const [e] = milestone(view(project())).entries;
      expect(e).toMatchObject({
        id: 'te-1',
        workedOnLabel: '14 Oct',
        hoursLabel: '1.5 hrs',
        minutes: 90,
        note: 'Mapped the flows',
      });
    });

    it('lets the author edit and delete their own entry on an in-progress milestone', () => {
      const [e] = milestone(view(project())).entries;
      expect(e).toMatchObject({ canEdit: true, canDelete: true });
    });

    it('keeps delete but drops edit once the milestone is no longer in progress', () => {
      const [e] = milestone(view(project({ status: 'completed' }))).entries;
      expect(e).toMatchObject({ canEdit: false, canDelete: true });
    });

    it("never offers edit or delete on someone else's entry", () => {
      const [e] = milestone(
        view(project(), { entries: [entry({ userId: 'user-other' })] })
      ).entries;
      expect(e).toMatchObject({ canEdit: false, canDelete: false });
    });

    it.each([
      [null, 'own entry', VIEWER, false],
      [null, "someone else's entry", 'user-other', false],
      ['own', 'own entry', VIEWER, true],
      ['own', "someone else's entry", 'user-other', false],
      ['any', 'own entry', VIEWER, true],
      ['any', "someone else's entry", 'user-other', true],
    ] as const)('scope %s on %s: may change is %s', (scope, _name, author, expected) => {
      const [e] = milestone(
        view(project(), { entries: [entry({ userId: author })], timeEntryScope: scope })
      ).entries;
      expect(e).toMatchObject({ canEdit: expected, canDelete: expected });
    });

    it('a viewer who cannot log time still changes entries their scope reaches', () => {
      const v = milestone(
        view(project(), {
          entries: [entry({ userId: 'user-other' })],
          canLogTime: false,
          timeEntryScope: 'any',
        })
      );
      expect(v.canLog).toBe(false);
      expect(v.entries[0]).toMatchObject({ canEdit: true, canDelete: true });
    });

    it.each([
      ['another editor', 'user-dana', 'Dana', 'Edited by Dana @ CloudPeak'],
      ['the author', VIEWER, 'Charles', null],
      ['no one', null, null, null],
    ])('editedByLabel for %s', (_name, editorId, editorName, expected) => {
      const base = project();
      const engagement = {
        ...base,
        expertProfile: {
          ...base.expertProfile,
          type: 'agency',
          agency: { id: 'agency-1', name: 'CloudPeak' },
        },
      } as unknown as ProjectEngagementWithMilestones;
      const [e] = milestone(
        view(engagement, {
          entries: [
            entry({
              updatedByUserId: editorId,
              editorFirstName: editorName,
              editorLastName: null,
            }),
          ],
        })
      ).entries;
      expect(e?.editedByLabel).toBe(expected);
    });

    it('offers nothing to a viewer who cannot log time', () => {
      const v = milestone(
        view(project(), { canLogTime: false, lens: 'client', timeEntryScope: null })
      );
      expect(v.canLog).toBe(false);
      expect(v.entries[0]).toMatchObject({ canEdit: false, canDelete: false });
    });

    it('canLog needs the capability and an in-progress milestone', () => {
      expect(milestone(view(project())).canLog).toBe(true);
      expect(milestone(view(project({ status: 'pending' }))).canLog).toBe(false);
      expect(milestone(view(project({ status: 'completed' }))).canLog).toBe(false);
    });

    it('labels the toggle with the count and the authors from the viewer’s side', () => {
      const own = milestone(view(project()));
      expect(own.logToggleLabel).toBe('Time log (1)');
      expect(own.authorsLabel).toBe('Logged by you');

      const client = milestone(view(project(), { lens: 'client', canLogTime: false }));
      expect(client.authorsLabel).toBe('Logged by you');

      const other = milestone(
        view(project(), {
          lens: 'client',
          canLogTime: false,
          entries: [entry({ userId: 'u-2', authorFirstName: 'Priya' })],
        })
      );
      expect(other.authorsLabel).toBe('Logged by Priya');

      const both = milestone(
        view(project(), {
          entries: [entry(), entry({ id: 'te-2', userId: 'u-2', authorFirstName: null })],
        })
      );
      expect(both.authorsLabel).toBe('Logged by you and a teammate');
    });

    it('invites the first entry only when the viewer can log and nothing is logged', () => {
      const empty = milestone(view(project(), { entries: [], sums: sums({ byMilestone: {} }) }));
      expect(empty.emptyLabel).toBe(
        'Log time as you work — Northwind sees every entry and its note.'
      );
      expect(empty.authorsLabel).toBeNull();
      expect(milestone(view(project())).emptyLabel).toBeNull();
      expect(
        milestone(
          view(project(), { entries: [], canLogTime: false, sums: sums({ byMilestone: {} }) })
        ).emptyLabel
      ).toBeNull();
    });
  });

  describe('over-estimate notice', () => {
    it('marks a milestone whose notice was already sent at its current estimate', () => {
      expect(
        view(project(), { notifiedMilestoneIds: [MS] }).byMilestoneId[MS]?.overNoticeSent
      ).toBe(true);
      expect(view(project()).byMilestoneId[MS]?.overNoticeSent).toBe(false);
    });
  });

  describe('totals', () => {
    it('measures only time on estimated milestones against the summed estimate', () => {
      const engagement = project(
        {},
        {
          milestones: [
            makeMilestone({ id: MS, status: 'in_progress', estimatedMinutes: 300 }),
            makeMilestone({ id: 'ms-2', estimatedMinutes: 180 }),
            makeMilestone({ id: 'ms-3', estimatedMinutes: null }),
          ],
        }
      );
      const { totals } = view(engagement, {
        sums: sums({ totalMinutes: 420, byMilestone: { [MS]: 300, 'ms-2': 60, 'ms-3': 60 } }),
      });
      expect(totals).toMatchObject({
        loggedLabel: '6 of 8 hrs logged against the estimate · 7 hrs in all',
        fillPercent: 75,
        over: false,
      });
    });

    it('is not over when only time on a milestone without an estimate takes the total past it', () => {
      const engagement = project(
        {},
        {
          milestones: [
            makeMilestone({ id: MS, status: 'in_progress', estimatedMinutes: 480 }),
            makeMilestone({ id: 'ms-3', estimatedMinutes: null }),
          ],
        }
      );
      const { totals } = view(engagement, {
        sums: sums({ totalMinutes: 900, byMilestone: { [MS]: 300, 'ms-3': 600 } }),
      });
      expect(totals).toMatchObject({ over: false, fillPercent: 63 });
    });

    it('leaves out the "in all" note when every minute is on an estimated milestone', () => {
      expect(view(project()).totals.loggedLabel).toBe('1.5 of 8 hrs logged against the estimate');
    });

    it('is over once the project total passes the summed estimate', () => {
      expect(
        view(project(), { sums: sums({ totalMinutes: 500, byMilestone: { [MS]: 500 } }) }).totals
      ).toMatchObject({
        over: true,
        fillPercent: 100,
      });
    });

    it('has no track and is never over when no milestone carries an estimate', () => {
      const { totals } = view(project({ estimatedMinutes: null }), {
        sums: sums({ totalMinutes: 90 }),
      });
      expect(totals).toMatchObject({
        loggedLabel: '1.5 hrs logged',
        fillPercent: null,
        over: false,
      });
    });

    it('reads a zero total estimate with time logged as full', () => {
      expect(
        view(project({ estimatedMinutes: 0 }), {
          sums: sums({ totalMinutes: 60, byMilestone: { [MS]: 60 } }),
        }).totals
      ).toMatchObject({ fillPercent: 100, over: true });
      expect(
        view(project({ estimatedMinutes: 0 }), {
          sums: sums({ totalMinutes: 0, byMilestone: {} }),
        }).totals
      ).toMatchObject({ fillPercent: 0, over: false });
    });

    it('describes the billing period for the expert and admin', () => {
      for (const lens of ['expert', 'admin'] as const) {
        expect(view(project(), { lens }).totals.period).toEqual({
          hoursLabel: '1.5 hrs',
          detail: '1 Oct – 31 Oct · billed to Northwind on 1 Nov, whatever the review status',
        });
      }
    });

    it('describes the billing period for the client, naming the expert', () => {
      expect(view(project(), { lens: 'client', canLogTime: false }).totals.period?.detail).toBe(
        '1 Oct – 31 Oct · invoiced on 1 Nov for the time Charles has logged'
      );
    });

    it('names the agency, not the delivering expert, when several of its people may have acted', () => {
      const base = makeProject().expertProfile;
      const agencyProject = project(
        {},
        {
          expertProfile: {
            ...base,
            agencyId: 'ag-1',
            type: 'agency',
            agency: { id: 'ag-1', name: 'CloudPeak', logoUrl: null },
          },
        }
      );
      expect(view(agencyProject, { lens: 'client', canLogTime: false }).totals.period?.detail).toBe(
        '1 Oct – 31 Oct · invoiced on 1 Nov for the time CloudPeak has logged'
      );
    });

    it('omits the period when there is no billing window or no period sum', () => {
      expect(view(project(), { period: null }).totals.period).toBeNull();
      expect(view(project(), { sums: sums({ periodMinutes: null }) }).totals.period).toBeNull();
    });
  });

  describe('over-estimate banner', () => {
    const overSums = sums({ byMilestone: { [MS]: 570 }, totalMinutes: 570 });

    it('is absent while every milestone is within its estimate', () => {
      expect(view(project()).overEstimateBanner).toBeNull();
    });

    it('tells the expert the client has been notified', () => {
      expect(view(project(), { sums: overSums }).overEstimateBanner).toEqual({
        title: 'Build is over estimate.',
        body: 'Northwind sees the hours on every milestone. If the scope has grown, propose a change rather than logging on.',
      });
    });

    it('tells everyone else what the log shows and who can propose a change', () => {
      for (const lens of ['client', 'admin'] as const) {
        expect(
          view(project(), { sums: overSums, lens, canLogTime: false }).overEstimateBanner
        ).toEqual({
          title: 'Build has gone over estimate.',
          body: 'The time log on each milestone shows what the hours went on. If the scope has grown, Charles can propose a change.',
        });
      }
    });

    it('lists several milestones and agrees the verb', () => {
      const engagement = project(
        {},
        {
          milestones: [
            makeMilestone({ id: MS, title: 'Build', status: 'in_progress', estimatedMinutes: 60 }),
            makeMilestone({
              id: 'ms-2',
              title: 'Test',
              status: 'in_progress',
              estimatedMinutes: 60,
            }),
            makeMilestone({
              id: 'ms-3',
              title: 'Ship',
              status: 'in_progress',
              estimatedMinutes: 60,
            }),
          ],
        }
      );
      const v = view(engagement, {
        sums: sums({ byMilestone: { [MS]: 120, 'ms-2': 120, 'ms-3': 120 } }),
      });
      expect(v.overEstimateBanner?.title).toBe('Build, Test and Ship are over estimate.');
    });
  });

  it('shows no rate or amount in any string, in any lens', () => {
    const engagement = project();
    for (const lens of ['client', 'expert', 'admin'] as const) {
      const v = view(engagement, {
        lens,
        sums: sums({ byMilestone: { [MS]: 570 }, totalMinutes: 570 }),
      });
      expect(JSON.stringify(v)).not.toMatch(/\$|AUD|A\$|150|15000|rate/i);
    }
  });
});
