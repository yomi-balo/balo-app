import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockMeetingFindById,
  mockListByMeeting,
  mockListAdminUserIds,
  mockScheduleNotification,
  mockTrackServer,
  mockWarn,
} = vi.hoisted(() => ({
  mockMeetingFindById: vi.fn(),
  mockListByMeeting: vi.fn(),
  mockListAdminUserIds: vi.fn(),
  mockScheduleNotification: vi.fn(),
  mockTrackServer: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockWarn, error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  meetingsRepository: { findById: mockMeetingFindById },
  meetingPresenceRepository: { listByMeeting: mockListByMeeting },
  partyMembershipsRepository: { listAdminUserIds: mockListAdminUserIds },
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  MEETING_SERVER_EVENTS: { MEETING_EXPERT_ABSENT_ALERT: 'meeting_expert_absent_alert' },
}));
vi.mock('./schedule.js', () => ({ scheduleNotification: mockScheduleNotification }));
// ⚠ `@balo/shared/meetings` is NOT mocked — `summarisePresence` is the shared reduction both
// guards read, and mocking it would make this file assert its own fixtures.

import { DEFAULT_MEETING_TIMERS } from '@balo/shared/meetings';
import {
  clientAbsentKey,
  expertAbsentKey,
  meetingClientAbsentRecheck,
  meetingExpertAbsentRecheck,
  scheduleClientAbsentNudge,
  scheduleExpertAbsentAlert,
  MEETING_CLIENT_ABSENT_RECHECK,
  MEETING_EXPERT_ABSENT_RECHECK,
} from './meeting-absence.js';
import type { ScheduledNotification } from '@balo/db';

const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
const START = new Date('2026-08-14T10:00:00.000Z');
const CORRELATION_ID = 'c0000000-0000-4000-8000-000000000000';

/**
 * ⚠ `attempts: 1` IS THE DEFAULT BECAUSE `claim` STAMPS `attempts + 1` IN THE SAME STATEMENT
 * THAT HANDS THE ROW TO A GUARD — so a guard never sees `0`, and `1` means "this is the first
 * time anyone has tried to send this promise".
 */
function row(payload: Record<string, unknown> = {}, attempts = 1): ScheduledNotification {
  return {
    id: 'row-1',
    attempts,
    payload: { correlationId: CORRELATION_ID, meetingId: MEETING_ID, ...payload },
  } as unknown as ScheduledNotification;
}

function meeting(status = 'waiting_for_participants') {
  return { id: MEETING_ID, status, scheduledStart: START };
}

describe('the dedupe keys', () => {
  /** ⚠ THIS EXACT SHAPE IS THE DOCUMENTED EXAMPLE on `scheduled_notifications.dedupe_key`. */
  it('are one pending promise per meeting, per kind', () => {
    expect(expertAbsentKey(MEETING_ID)).toBe(`meeting_expert_absent:${MEETING_ID}`);
    expect(clientAbsentKey(MEETING_ID)).toBe(`meeting_client_absent:${MEETING_ID}`);
    expect(expertAbsentKey(MEETING_ID)).not.toBe(clientAbsentKey(MEETING_ID));
  });
});

describe('meetingExpertAbsentRecheck (BAL-134 §6.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMeetingFindById.mockResolvedValue(meeting());
    mockListByMeeting.mockResolvedValue([]);
  });

  it('PUBLISHES when the expert still has not joined', async () => {
    const result = await meetingExpertAbsentRecheck(row({ minutesPastStart: 5 }));

    expect(result.publish).toBe(true);
    expect(mockTrackServer).toHaveBeenCalledWith('meeting_expert_absent_alert', {
      meeting_id: MEETING_ID,
      minutes_past_start: 5,
      // ⚠ THE MEETING ID — no acting human on an alert about an absence.
      distinct_id: MEETING_ID,
    });
  });

  /**
   * ⚠⚠ `correlationId` MUST SURVIVE THE REBUILD. The dispatch tick terminally FAILS a payload
   * without one, because `publisher.publish` derives the BullMQ jobId from it — build fresh and
   * every promise of the event collapses into the single job `event--undefined`.
   */
  it('⚠⚠ SPREADS the stored payload so `correlationId` survives', async () => {
    const result = await meetingExpertAbsentRecheck(row({ minutesPastStart: 5 }));

    expect(result.publish && result.payload.correlationId).toBe(CORRELATION_ID);
  });

  /**
   * ⚠ "EVER JOINED", NOT "IS HERE NOW". An expert who joined and dropped out has been reached —
   * Balo's operational commitment is discharged by their arrival, and paging ops for a network
   * blip is how a load-bearing alert gets muted by its recipients.
   */
  it('⚠ SKIPS when the expert joined at ANY point, even if they have since left', async () => {
    mockListByMeeting.mockResolvedValue([
      { party: 'expert', joinedAt: START, leftAt: new Date(START.getTime() + 60_000) },
    ]);

    await expect(meetingExpertAbsentRecheck(row())).resolves.toEqual({
      publish: false,
      reason: 'expert_joined_before_alert',
    });
    expect(mockTrackServer).not.toHaveBeenCalled();
  });

  it.each(['ended', 'cancelled'])('SKIPS a %s meeting', async (status) => {
    mockMeetingFindById.mockResolvedValue(meeting(status));

    await expect(meetingExpertAbsentRecheck(row())).resolves.toEqual({
      publish: false,
      reason: 'meeting_terminal',
    });
  });

  it('SKIPS a meeting that is gone', async () => {
    mockMeetingFindById.mockResolvedValue(undefined);

    await expect(meetingExpertAbsentRecheck(row())).resolves.toEqual({
      publish: false,
      reason: 'meeting_missing',
    });
  });

  /** A row written by an older build, or hand-edited. SKIPPED — never published blind. */
  it('SKIPS a malformed payload', async () => {
    await expect(
      meetingExpertAbsentRecheck({ id: 'row-1', payload: {} } as unknown as ScheduledNotification)
    ).resolves.toEqual({ publish: false, reason: 'malformed_payload' });
  });

  /**
   * ⚠⚠ W4 — ONE PROMISE, AT MOST ONE ANALYTICS EVENT.
   *
   * The guard runs BEFORE the publish, so a throw in `publishStoredEvent` / `markPublished`
   * leaves the row `claimed`; it is re-claimed once the claim TTL lapses and this guard runs
   * again. Emitting unconditionally reported N alerts for ONE absence — contradicting
   * `packages/analytics/src/events/meeting.ts`'s own "one per meeting" statement and inflating
   * the metric ops sizes its staffing on. `claim` stamps `attempts + 1` in the statement that
   * returns the row, so `attempts > 1` is a RETRY, as a fact about this row rather than a guess.
   */
  it('⚠⚠ W4 — a RETRY still publishes but does NOT emit a second analytics event', async () => {
    const first = await meetingExpertAbsentRecheck(row({ minutesPastStart: 5 }, 1));
    expect(first.publish).toBe(true);
    expect(mockTrackServer).toHaveBeenCalledTimes(1);

    const retry = await meetingExpertAbsentRecheck(row({ minutesPastStart: 5 }, 2));

    // ⚠ THE ALERT IS STILL OWED — the skip is on the METRIC, never on the delivery.
    expect(retry.publish).toBe(true);
    expect(mockTrackServer).toHaveBeenCalledTimes(1);
  });

  it('degrades a non-numeric minutesPastStart to 0 rather than emitting NaN', async () => {
    await meetingExpertAbsentRecheck(row({ minutesPastStart: 'soon' }));

    expect(mockTrackServer).toHaveBeenCalledWith(
      'meeting_expert_absent_alert',
      expect.objectContaining({ minutes_past_start: 0 })
    );
  });
});

describe('meetingClientAbsentRecheck (BAL-134 §6.3)', () => {
  const EXPERT_WAITING = [{ party: 'expert', joinedAt: START, leftAt: null }];

  beforeEach(() => {
    vi.clearAllMocks();
    mockMeetingFindById.mockResolvedValue(meeting());
    mockListByMeeting.mockResolvedValue(EXPERT_WAITING);
    mockListAdminUserIds.mockResolvedValue(['user-a', 'user-b']);
  });

  it('PUBLISHES when the expert is still waiting alone', async () => {
    const result = await meetingClientAbsentRecheck(row({ companyId: COMPANY_ID }));

    expect(result.publish).toBe(true);
    expect(result.publish && result.payload.correlationId).toBe(CORRELATION_ID);
  });

  /**
   * ⚠ THE RECIPIENT LIST IS **REBUILT** FROM LIVE MEMBERSHIP, never inherited. A member who left
   * the company between schedule and fire must not be nudged, and one who joined should be.
   */
  it('⚠ REBUILDS recipientUserIds from live membership, discarding the stored value', async () => {
    const result = await meetingClientAbsentRecheck(
      row({ companyId: COMPANY_ID, recipientUserIds: ['stale-user'] })
    );

    expect(result.publish && result.payload.recipientUserIds).toEqual(['user-a', 'user-b']);
    expect(mockListAdminUserIds).toHaveBeenCalledWith('company', COMPANY_ID);
  });

  it('SKIPS when a client-side participant arrived', async () => {
    mockListByMeeting.mockResolvedValue([
      ...EXPERT_WAITING,
      { party: 'client', joinedAt: START, leftAt: null },
    ]);

    await expect(meetingClientAbsentRecheck(row({ companyId: COMPANY_ID }))).resolves.toEqual({
      publish: false,
      reason: 'client_joined_before_nudge',
    });
  });

  /**
   * ⚠⚠ THE CASE CANCELLATION ALONE CANNOT COVER. Nothing about the EXPERT leaving triggers a
   * cancel of the CLIENT's nudge — and nudging somebody to join a room with nobody in it would
   * be worse than silence. Only a fire-time recheck can see this.
   */
  it('⚠⚠ SKIPS when the EXPERT has left — nothing cancels this, only the recheck sees it', async () => {
    mockListByMeeting.mockResolvedValue([
      { party: 'expert', joinedAt: START, leftAt: new Date(START.getTime() + 120_000) },
    ]);

    await expect(meetingClientAbsentRecheck(row({ companyId: COMPANY_ID }))).resolves.toEqual({
      publish: false,
      reason: 'expert_left_before_nudge',
    });
  });

  it('SKIPS a terminal meeting and a missing one', async () => {
    mockMeetingFindById.mockResolvedValue(meeting('ended'));
    await expect(meetingClientAbsentRecheck(row({ companyId: COMPANY_ID }))).resolves.toEqual({
      publish: false,
      reason: 'meeting_terminal',
    });

    mockMeetingFindById.mockResolvedValue(undefined);
    await expect(meetingClientAbsentRecheck(row({ companyId: COMPANY_ID }))).resolves.toEqual({
      publish: false,
      reason: 'meeting_missing',
    });
  });

  it('SKIPS a malformed payload', async () => {
    await expect(
      meetingClientAbsentRecheck({ id: 'r', payload: {} } as unknown as ScheduledNotification)
    ).resolves.toEqual({ publish: false, reason: 'malformed_payload' });
  });

  /**
   * ⚠⚠ RE-DECIDED (W5). This row used to assert `publish: true` with an EMPTY recipient list —
   * i.e. the guard logged "publishing the client nudge", delivered NOTHING (both channels fan
   * out from `recipientUserIds`), and the dispatch tick then marked the row terminal
   * `published`. A promise recorded as KEPT that reached nobody is the worst possible shape: it
   * is silent, and in the one table anybody would check it is indistinguishable from a nudge
   * that actually arrived. The same function already `markSkipped`s a missing `meetingId`; a
   * missing `companyId` is the same class of defect and now gets the same treatment.
   */
  it('⚠⚠ RE-DECIDED — a payload with NO company is `malformed_payload`, not an empty publish', async () => {
    await expect(meetingClientAbsentRecheck(row())).resolves.toEqual({
      publish: false,
      reason: 'malformed_payload',
    });
    expect(mockListAdminUserIds).not.toHaveBeenCalled();
  });

  it('⚠ a BLANK company id is treated the same as a missing one', async () => {
    await expect(meetingClientAbsentRecheck(row({ companyId: '' }))).resolves.toEqual({
      publish: false,
      reason: 'malformed_payload',
    });
  });

  /** ⚠ SAME REASONING ONE STEP LATER: a resolved list of nobody is a skip, not a send. */
  it('⚠ SKIPS when the owning company has no live recipient', async () => {
    mockListAdminUserIds.mockResolvedValue([]);

    await expect(meetingClientAbsentRecheck(row({ companyId: COMPANY_ID }))).resolves.toEqual({
      publish: false,
      reason: 'no_recipients',
    });
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, companyId: COMPANY_ID }),
      expect.stringContaining('reached nobody')
    );
  });
});

describe('the two schedulers (§6.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockScheduleNotification.mockResolvedValue({ outcome: 'scheduled' });
  });

  it('arms the ops alert at scheduled_start + EXPERT_ABSENT_ALERT_MS, with its recheck', async () => {
    await scheduleExpertAbsentAlert({
      meetingId: MEETING_ID,
      scheduledStart: START,
      contextType: 'case',
      timers: DEFAULT_MEETING_TIMERS,
    });

    const [event, payload, options] = mockScheduleNotification.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(event).toBe('meeting.expert_absent');
    expect(payload).toMatchObject({
      meetingId: MEETING_ID,
      minutesPastStart: 5,
      contextType: 'case',
    });
    expect(options).toEqual({
      key: expertAbsentKey(MEETING_ID),
      at: new Date(START.getTime() + DEFAULT_MEETING_TIMERS.expertAbsentAlertMs),
      mode: 'first_wins',
      recheck: MEETING_EXPERT_ABSENT_RECHECK,
    });
  });

  /**
   * ⚠ ANCHORED ON THE EXPERT-PRESENT CLOCK START, NOT ON `scheduled_start`. An expert who joins
   * at 10:05 has been waiting five minutes at 10:10, not ten — which is the whole reason
   * `CLIENT_ABSENT_NUDGE_MS` is a separate constant despite sharing a default.
   */
  it('⚠ arms the client nudge on the EXPERT-PRESENT clock start, not the scheduled start', async () => {
    const clockStart = new Date(START.getTime() + 5 * 60_000);

    await scheduleClientAbsentNudge({
      meetingId: MEETING_ID,
      companyId: COMPANY_ID,
      scheduledStart: START,
      clockStart,
      waitingPartyName: 'CloudPeak',
      timers: DEFAULT_MEETING_TIMERS,
    });

    const [event, payload, options] = mockScheduleNotification.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(event).toBe('meeting.client_absent');
    expect(payload).toMatchObject({ companyId: COMPANY_ID, waitingPartyName: 'CloudPeak' });
    // ⚠ THE ANCHOR: 10:05 + 5min = 10:10, NOT 10:05.
    expect(options.at).toEqual(new Date(clockStart.getTime() + 300_000));
    expect(options.recheck).toBe(MEETING_CLIENT_ABSENT_RECHECK);
  });

  /**
   * ⚠⚠ A FRESH uuid PER PROMISE, NEVER THE MEETING ID. `publisher.publish` mints
   * `jobId = ${event}--${correlationId}` and the shared queue retains completed jobs
   * `{ count: 100 }`, so a value stable per meeting forever would silently collide with its own
   * earlier send while the row is still marked `published`. That is BAL-424's documented defect.
   */
  it('⚠⚠ mints a FRESH correlationId per promise — never the meeting id', async () => {
    await scheduleExpertAbsentAlert({
      meetingId: MEETING_ID,
      scheduledStart: START,
      contextType: 'case',
      timers: DEFAULT_MEETING_TIMERS,
    });
    await scheduleExpertAbsentAlert({
      meetingId: MEETING_ID,
      scheduledStart: START,
      contextType: 'case',
      timers: DEFAULT_MEETING_TIMERS,
    });

    const first = (mockScheduleNotification.mock.calls[0]?.[1] as Record<string, unknown>)
      .correlationId;
    const second = (mockScheduleNotification.mock.calls[1]?.[1] as Record<string, unknown>)
      .correlationId;

    expect(first).not.toBe(MEETING_ID);
    expect(first).not.toBe(second);
  });

  /** The client nudge seeds an EMPTY recipient list — the guard rebuilds it at fire time. */
  it('seeds recipientUserIds empty — the stored value never sends', async () => {
    await scheduleClientAbsentNudge({
      meetingId: MEETING_ID,
      companyId: COMPANY_ID,
      scheduledStart: START,
      clockStart: START,
      waitingPartyName: null,
      timers: DEFAULT_MEETING_TIMERS,
    });

    const payload = mockScheduleNotification.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.recipientUserIds).toEqual([]);
  });

  /**
   * ⚠ `first_wins` IS WHAT MAKES A PER-MINUTE SWEEP CHEAP. The second tick's call answers
   * `already_pending` and writes nothing; `replace_pending` would push the fire time out on
   * every tick and the alert would never fire at all.
   */
  it('⚠ both promises use `first_wins`, so repeated ticks are a no-op', async () => {
    await scheduleExpertAbsentAlert({
      meetingId: MEETING_ID,
      scheduledStart: START,
      contextType: 'case',
      timers: DEFAULT_MEETING_TIMERS,
    });
    await scheduleClientAbsentNudge({
      meetingId: MEETING_ID,
      companyId: COMPANY_ID,
      scheduledStart: START,
      clockStart: START,
      waitingPartyName: null,
      timers: DEFAULT_MEETING_TIMERS,
    });

    for (const call of mockScheduleNotification.mock.calls) {
      expect((call[2] as Record<string, unknown>).mode).toBe('first_wins');
    }
  });
});

/**
 * ⚠⚠ BAL-410 (orchestrator D3) — CANCELLING A MEETING CANCELS NOTHING IN THE QUEUE, AND IT DOES
 * NOT HAVE TO. THIS IS THE WHOLE DELIVERABLE FOR FAN-OUT STEP 6.
 *
 * The ticket lists "cancel queued BullMQ reminder jobs" as a cancellation step. D3 re-scoped it
 * to a TEST rather than a call, for three independent reasons, and this block is that test:
 *
 *   1. ADR-1047 Decision 11 is explicit that the scheduled-notification cancel seam "never gets
 *      an HTTP route, ever" — pinned by `scheduled-notifications-api-only.test.ts`. BAL-410's
 *      cancel is an HTTP route, so it structurally cannot reach one.
 *   2. Nothing is ARMED on a merely-booked meeting. Both absence promises are armed by the
 *      lifecycle sweep once the meeting is live, so a meeting cancelled while `scheduled` has no
 *      pending row to void in the first place.
 *   3. For the case that CAN arise — armed while live, then cancelled — the fire-time recheck
 *      already self-skips on a terminal meeting. That is what these two cases pin: NOT that a
 *      cancel call happened, but that no promise fires for a cancelled meeting.
 *
 * `reschedule-proposal.test.ts` pins the equivalent for the proposal reminder; this is the same
 * property for the two absence promises. ⚠ Deliberately NO assertion that any queue removal or
 * `notificationEvents.cancel` was invoked — adding one would be asserting a call this design
 * says must never exist.
 */
describe('BAL-410 D3 — an armed promise self-skips once its meeting is CANCELLED', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListByMeeting.mockResolvedValue([]);
    mockListAdminUserIds.mockResolvedValue(['user-a']);
  });

  it('the EXPERT-absent alert, armed on a LIVE meeting, skips once it is cancelled at fire time', async () => {
    // Arm-time reality: the meeting was live and the expert had not joined, so the promise was
    // legitimately armed and is sitting in `scheduled_notifications`.
    mockMeetingFindById.mockResolvedValue(meeting('waiting_for_participants'));
    const armed = await meetingExpertAbsentRecheck(row({ minutesPastStart: 5 }));
    expect(armed.publish).toBe(true);

    // Fire-time reality: BAL-410 cancelled it in between. The recheck re-reads the meeting and
    // refuses — no ops page for a call nobody was waiting for.
    vi.clearAllMocks();
    mockMeetingFindById.mockResolvedValue(meeting('cancelled'));

    await expect(meetingExpertAbsentRecheck(row({ minutesPastStart: 5 }))).resolves.toEqual({
      publish: false,
      reason: 'meeting_terminal',
    });
    // …and no analytics event either: a cancelled meeting is not an absence.
    expect(mockTrackServer).not.toHaveBeenCalled();
  });

  it('the CLIENT-absent nudge, armed on a LIVE meeting, skips once it is cancelled at fire time', async () => {
    mockMeetingFindById.mockResolvedValue(meeting('waiting_for_participants'));
    mockListByMeeting.mockResolvedValue([{ party: 'expert', joinedAt: START, leftAt: null }]);
    const armed = await meetingClientAbsentRecheck(row({ companyId: COMPANY_ID }));
    expect(armed.publish).toBe(true);

    vi.clearAllMocks();
    mockMeetingFindById.mockResolvedValue(meeting('cancelled'));
    mockListByMeeting.mockResolvedValue([{ party: 'expert', joinedAt: START, leftAt: null }]);

    await expect(meetingClientAbsentRecheck(row({ companyId: COMPANY_ID }))).resolves.toEqual({
      publish: false,
      reason: 'meeting_terminal',
    });
    // ⚠ AND THE MEMBERSHIP READ NEVER RUNS — the terminal check short-circuits before it, so a
    // cancelled meeting costs no recipient resolution at all.
    expect(mockListAdminUserIds).not.toHaveBeenCalled();
  });
});
