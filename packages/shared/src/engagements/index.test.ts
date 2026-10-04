import { describe, it, expect } from 'vitest';
import {
  CASE_INACTIVITY_DAYS,
  caseInactivityAnchor,
  isCaseInactive,
  type CaseInactivityInput,
} from './index';

const NOW = new Date('2026-08-04T00:00:00.000Z');
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);
const daysAhead = (n: number): Date => new Date(NOW.getTime() + n * 86_400_000);

describe('CASE_INACTIVITY_DAYS', () => {
  it('is 30', () => {
    expect(CASE_INACTIVITY_DAYS).toBe(30);
  });
});

/** Every optional anchor absent — spread first, then override the one under test. */
const NO_OPTIONAL_ANCHORS = {
  lastCompletedConsultationAt: null,
  lastSchedulingActivityAt: null,
  lastChatActivityAt: null,
  lastActionItemActivityAt: null,
};

/** {@link NO_OPTIONAL_ANCHORS} plus nothing booked ahead, for `isCaseInactive` inputs. */
const NO_ACTIVITY = { ...NO_OPTIONAL_ANCHORS, nextScheduledConsultationAt: null };

interface InactivityCase {
  name: string;
  input: CaseInactivityInput;
  expected: boolean;
}

/** One `it` per row: `isCaseInactive(input)` must equal `expected`. */
function itDecides(cases: readonly InactivityCase[]): void {
  for (const { name, input, expected } of cases) {
    it(name, () => {
      expect(isCaseInactive(input)).toBe(expected);
    });
  }
}

describe('caseInactivityAnchor', () => {
  it('returns the last completed consultation when there is one', () => {
    const last = daysAgo(5);
    expect(
      caseInactivityAnchor({
        caseCreatedAt: daysAgo(90),
        lastCompletedConsultationAt: last,
        lastSchedulingActivityAt: null,
        lastChatActivityAt: null,
        lastActionItemActivityAt: null,
      }).getTime()
    ).toBe(last.getTime());
  });

  it('falls back to the case creation when every other anchor is null', () => {
    const created = daysAgo(90);
    expect(
      caseInactivityAnchor({
        caseCreatedAt: created,
        lastCompletedConsultationAt: null,
        lastSchedulingActivityAt: null,
        lastChatActivityAt: null,
        lastActionItemActivityAt: null,
      }).getTime()
    ).toBe(created.getTime());
  });

  it('chat NEWER than the last consultation → the chat activity', () => {
    const chat = daysAgo(3);
    expect(
      caseInactivityAnchor({
        ...NO_OPTIONAL_ANCHORS,
        caseCreatedAt: daysAgo(90),
        lastCompletedConsultationAt: daysAgo(20),
        lastChatActivityAt: chat,
        lastActionItemActivityAt: null,
      }).getTime()
    ).toBe(chat.getTime());
  });

  it('chat OLDER than the last consultation → the consultation (the newest anchor wins)', () => {
    const consultation = daysAgo(3);
    expect(
      caseInactivityAnchor({
        ...NO_OPTIONAL_ANCHORS,
        caseCreatedAt: daysAgo(90),
        lastCompletedConsultationAt: consultation,
        lastChatActivityAt: daysAgo(20),
        lastActionItemActivityAt: null,
      }).getTime()
    ).toBe(consultation.getTime());
  });

  it('chat only → the chat activity', () => {
    const chat = daysAgo(12);
    expect(
      caseInactivityAnchor({
        ...NO_OPTIONAL_ANCHORS,
        caseCreatedAt: daysAgo(90),
        lastChatActivityAt: chat,
        lastActionItemActivityAt: null,
      }).getTime()
    ).toBe(chat.getTime());
  });

  it('scheduling only → the scheduling activity', () => {
    const scheduling = daysAgo(12);
    expect(
      caseInactivityAnchor({
        ...NO_OPTIONAL_ANCHORS,
        caseCreatedAt: daysAgo(90),
        lastSchedulingActivityAt: scheduling,
      }).getTime()
    ).toBe(scheduling.getTime());
  });

  it('scheduling NEWER than both the consultation and the chat → the scheduling activity', () => {
    const scheduling = daysAgo(2);
    expect(
      caseInactivityAnchor({
        caseCreatedAt: daysAgo(90),
        lastCompletedConsultationAt: daysAgo(20),
        lastSchedulingActivityAt: scheduling,
        lastChatActivityAt: daysAgo(10),
        lastActionItemActivityAt: null,
      }).getTime()
    ).toBe(scheduling.getTime());
  });

  it('action-item activity only → the action-item activity', () => {
    const toggled = daysAgo(12);
    expect(
      caseInactivityAnchor({
        ...NO_OPTIONAL_ANCHORS,
        caseCreatedAt: daysAgo(90),
        lastActionItemActivityAt: toggled,
      }).getTime()
    ).toBe(toggled.getTime());
  });

  it('action-item activity NEWER than every other anchor → the action-item activity', () => {
    const toggled = daysAgo(1);
    expect(
      caseInactivityAnchor({
        caseCreatedAt: daysAgo(90),
        lastCompletedConsultationAt: daysAgo(20),
        lastSchedulingActivityAt: daysAgo(15),
        lastChatActivityAt: daysAgo(10),
        lastActionItemActivityAt: toggled,
      }).getTime()
    ).toBe(toggled.getTime());
  });

  it.each([
    'lastCompletedConsultationAt',
    'lastSchedulingActivityAt',
    'lastChatActivityAt',
    'lastActionItemActivityAt',
  ] as const)('%s OLDER than the case creation → the creation (creation is the floor)', (key) => {
    const created = daysAgo(10);
    expect(
      caseInactivityAnchor({
        ...NO_OPTIONAL_ANCHORS,
        caseCreatedAt: created,
        [key]: daysAgo(40),
      }).getTime()
    ).toBe(created.getTime());
  });
});

describe('isCaseInactive', () => {
  itDecides([
    {
      name: 'no consultation ever, case created 31 days ago → inactive (creation fallback)',
      input: {
        now: NOW,
        caseCreatedAt: daysAgo(31),
        lastCompletedConsultationAt: null,
        lastSchedulingActivityAt: null,
        lastChatActivityAt: null,
        lastActionItemActivityAt: null,
        nextScheduledConsultationAt: null,
      },
      expected: true,
    },
    {
      name: 'no consultation ever, case created 29 days ago → active',
      input: {
        now: NOW,
        caseCreatedAt: daysAgo(29),
        lastCompletedConsultationAt: null,
        lastSchedulingActivityAt: null,
        lastChatActivityAt: null,
        lastActionItemActivityAt: null,
        nextScheduledConsultationAt: null,
      },
      expected: false,
    },
    {
      name: 'last completed 31 days ago, created 90 days ago → inactive (anchor is the consultation)',
      input: {
        now: NOW,
        caseCreatedAt: daysAgo(90),
        lastCompletedConsultationAt: daysAgo(31),
        lastSchedulingActivityAt: null,
        lastChatActivityAt: null,
        lastActionItemActivityAt: null,
        nextScheduledConsultationAt: null,
      },
      expected: true,
    },
    {
      name: 'last completed 5 days ago, created 90 days ago → active (a recent consultation resets the clock)',
      input: {
        now: NOW,
        caseCreatedAt: daysAgo(90),
        lastCompletedConsultationAt: daysAgo(5),
        lastSchedulingActivityAt: null,
        lastChatActivityAt: null,
        lastActionItemActivityAt: null,
        nextScheduledConsultationAt: null,
      },
      expected: false,
    },
    {
      name: 'last completed 40 days ago BUT one scheduled tomorrow → active (the skip rule wins)',
      input: {
        now: NOW,
        caseCreatedAt: daysAgo(90),
        lastCompletedConsultationAt: daysAgo(40),
        lastSchedulingActivityAt: null,
        lastChatActivityAt: null,
        lastActionItemActivityAt: null,
        nextScheduledConsultationAt: daysAhead(1),
      },
      expected: false,
    },
    {
      name: 'a consultation scheduled in the PAST does not skip → inactive (only UPCOMING skips)',
      input: {
        now: NOW,
        caseCreatedAt: daysAgo(90),
        lastCompletedConsultationAt: daysAgo(40),
        lastSchedulingActivityAt: null,
        lastChatActivityAt: null,
        lastActionItemActivityAt: null,
        nextScheduledConsultationAt: daysAgo(2),
      },
      expected: true,
    },
    {
      name: 'exactly 30 days elapsed → inactive (INCLUSIVE >=, matching the sweep cutoff convention)',
      input: {
        now: NOW,
        caseCreatedAt: daysAgo(30),
        lastCompletedConsultationAt: null,
        lastSchedulingActivityAt: null,
        lastChatActivityAt: null,
        lastActionItemActivityAt: null,
        nextScheduledConsultationAt: null,
      },
      expected: true,
    },
    {
      name: 'custom thresholdDays honoured — 8 days elapsed against a 7-day threshold → inactive',
      input: {
        now: NOW,
        caseCreatedAt: daysAgo(8),
        lastCompletedConsultationAt: null,
        lastSchedulingActivityAt: null,
        lastChatActivityAt: null,
        lastActionItemActivityAt: null,
        nextScheduledConsultationAt: null,
        thresholdDays: 7,
      },
      expected: true,
    },
    {
      name: 'custom thresholdDays honoured — 6 days elapsed against a 7-day threshold → active',
      input: {
        now: NOW,
        caseCreatedAt: daysAgo(6),
        lastCompletedConsultationAt: null,
        lastSchedulingActivityAt: null,
        lastChatActivityAt: null,
        lastActionItemActivityAt: null,
        nextScheduledConsultationAt: null,
        thresholdDays: 7,
      },
      expected: false,
    },
  ]);
});

describe('isCaseInactive — action-item activity (marking done or reopening)', () => {
  itDecides([
    {
      name: 'consultation 40 days ago, an item ticked 5 days ago → active',
      input: {
        ...NO_ACTIVITY,
        now: NOW,
        caseCreatedAt: daysAgo(90),
        lastCompletedConsultationAt: daysAgo(40),
        lastActionItemActivityAt: daysAgo(5),
      },
      expected: false,
    },
    {
      name: 'consultation 40 days ago, an item ticked 31 days ago → inactive',
      input: {
        ...NO_ACTIVITY,
        now: NOW,
        caseCreatedAt: daysAgo(90),
        lastCompletedConsultationAt: daysAgo(40),
        lastActionItemActivityAt: daysAgo(31),
      },
      expected: true,
    },
    {
      name: 'an item ticked exactly 30 days ago → inactive (INCLUSIVE >=)',
      input: {
        ...NO_ACTIVITY,
        now: NOW,
        caseCreatedAt: daysAgo(90),
        lastActionItemActivityAt: daysAgo(30),
      },
      expected: true,
    },
  ]);
});

describe('isCaseInactive — chat activity (messages, files and in-call uploads)', () => {
  itDecides([
    {
      name: 'created 90 days ago, never consulted, chat 5 days ago → active',
      input: {
        ...NO_ACTIVITY,
        now: NOW,
        caseCreatedAt: daysAgo(90),
        lastChatActivityAt: daysAgo(5),
        lastActionItemActivityAt: null,
      },
      expected: false,
    },
    {
      name: 'consultation 40 days ago + chat 31 days ago → inactive',
      input: {
        ...NO_ACTIVITY,
        now: NOW,
        caseCreatedAt: daysAgo(90),
        lastCompletedConsultationAt: daysAgo(40),
        lastChatActivityAt: daysAgo(31),
        lastActionItemActivityAt: null,
      },
      expected: true,
    },
    {
      name: 'consultation 5 days ago + chat 40 days ago → active (the newer consultation wins)',
      input: {
        ...NO_ACTIVITY,
        now: NOW,
        caseCreatedAt: daysAgo(90),
        lastCompletedConsultationAt: daysAgo(5),
        lastChatActivityAt: daysAgo(40),
        lastActionItemActivityAt: null,
      },
      expected: false,
    },
    {
      name: 'chat exactly 30 days ago → inactive (INCLUSIVE >=)',
      input: {
        ...NO_ACTIVITY,
        now: NOW,
        caseCreatedAt: daysAgo(90),
        lastChatActivityAt: daysAgo(30),
        lastActionItemActivityAt: null,
      },
      expected: true,
    },
    {
      name: 'chat AFTER now → active (a negative elapsed time never closes)',
      input: {
        ...NO_ACTIVITY,
        now: NOW,
        caseCreatedAt: daysAgo(90),
        lastChatActivityAt: daysAhead(1),
        lastActionItemActivityAt: null,
      },
      expected: false,
    },
    {
      name: 'chat 40 days ago + a consultation booked tomorrow → active (the skip rule wins)',
      input: {
        ...NO_ACTIVITY,
        now: NOW,
        caseCreatedAt: daysAgo(90),
        lastChatActivityAt: daysAgo(40),
        lastActionItemActivityAt: null,
        nextScheduledConsultationAt: daysAhead(1),
      },
      expected: false,
    },
    {
      name: 'chat 5 days ago against a 3-day threshold → inactive (thresholdDays applies to chat)',
      input: {
        ...NO_ACTIVITY,
        now: NOW,
        caseCreatedAt: daysAgo(90),
        lastChatActivityAt: daysAgo(5),
        lastActionItemActivityAt: null,
        thresholdDays: 3,
      },
      expected: true,
    },
  ]);
});

describe('isCaseInactive — scheduling activity (booking, reschedule, cancellation)', () => {
  itDecides([
    {
      name: 'created 45 days ago, scheduling 1 day ago, nothing upcoming → active',
      input: {
        ...NO_ACTIVITY,
        now: NOW,
        caseCreatedAt: daysAgo(45),
        lastSchedulingActivityAt: daysAgo(1),
      },
      expected: false,
    },
    {
      name: 'created 45 days ago, scheduling 31 days ago → inactive',
      input: {
        ...NO_ACTIVITY,
        now: NOW,
        caseCreatedAt: daysAgo(45),
        lastSchedulingActivityAt: daysAgo(31),
      },
      expected: true,
    },
    {
      name: 'scheduling exactly 30 days ago → inactive (INCLUSIVE >=)',
      input: {
        ...NO_ACTIVITY,
        now: NOW,
        caseCreatedAt: daysAgo(45),
        lastSchedulingActivityAt: daysAgo(30),
      },
      expected: true,
    },
    {
      name: 'scheduling 40 days ago + chat 5 days ago → active (the newer chat wins)',
      input: {
        ...NO_ACTIVITY,
        now: NOW,
        caseCreatedAt: daysAgo(90),
        lastSchedulingActivityAt: daysAgo(40),
        lastChatActivityAt: daysAgo(5),
        lastActionItemActivityAt: null,
      },
      expected: false,
    },
    {
      name: 'scheduling 5 days ago + chat 40 days ago → active (the newer scheduling wins)',
      input: {
        ...NO_ACTIVITY,
        now: NOW,
        caseCreatedAt: daysAgo(90),
        lastSchedulingActivityAt: daysAgo(5),
        lastChatActivityAt: daysAgo(40),
        lastActionItemActivityAt: null,
      },
      expected: false,
    },
  ]);
});
