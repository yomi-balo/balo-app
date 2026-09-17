import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

const {
  mockListConnections,
  mockWriteConsultationEvent,
  mockRecordIcsDelivery,
  mockRecordProviderEvent,
  mockReconcileByTag,
} = vi.hoisted(() => ({
  mockListConnections: vi.fn(),
  mockWriteConsultationEvent: vi.fn(),
  mockRecordIcsDelivery: vi.fn(),
  mockRecordProviderEvent: vi.fn(),
  mockReconcileByTag: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  calendarRepository: { listConnectionsByExpertProfileId: mockListConnections },
  meetingCalendarEventsRepository: {
    recordIcsDelivery: mockRecordIcsDelivery,
    recordProviderEvent: mockRecordProviderEvent,
  },
}));

vi.mock('./write-consultation-event.js', () => ({
  writeConsultationEvent: (...args: unknown[]) => mockWriteConsultationEvent(...args),
}));

vi.mock('./reconcile-by-tag.js', () => ({
  reconcileByTag: mockReconcileByTag,
}));

import { projectBookingToExpertCalendar } from './project-booking-to-calendar.js';

function fakeLog(): FastifyBaseLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

const BASE_INPUT = {
  meetingId: 'meeting-1',
  // ⚠ LOGGING ONLY. Nothing in the module under test may branch on it — the assertions in
  // this file are what say so: the title, the subject line and the write target are all
  // unchanged by it, and only the two log lines name it.
  contextType: 'case' as const,
  expertProfileId: 'expert-1',
  clientCompanyName: 'Northwind Industrial',
  caseTitle: 'Salesforce CPQ rollout',
  startAt: new Date('2026-09-01T04:00:00.000Z'),
  endAt: new Date('2026-09-01T04:30:00.000Z'),
  joinUrl: 'https://balo.expert/join/m/meeting-1',
};

function connection(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'conn-1',
    expertProfileId: 'expert-1',
    endUserAccountId: 'eua-1',
    provider: 'google',
    providerEmail: null,
    credentialStatus: 'ACTIVE',
    credentialCheckedAt: null,
    reconnectNotifiedAt: null,
    lastSyncedAt: null,
    targetCalendarId: 'calendar-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

describe('projectBookingToExpertCalendar (BAL-400 D2)', () => {
  beforeEach(() => {
    mockListConnections.mockReset();
    mockWriteConsultationEvent.mockReset();
    mockRecordIcsDelivery.mockReset();
    mockRecordIcsDelivery.mockResolvedValue({ id: 'row-ics-1' });
  });

  it('two live connections → the first (oldest-live-first-ordered) one wins', async () => {
    mockListConnections.mockResolvedValue([
      connection({ id: 'conn-oldest', targetCalendarId: 'calendar-oldest' }),
      connection({ id: 'conn-newer', targetCalendarId: 'calendar-newer' }),
    ]);
    mockWriteConsultationEvent.mockResolvedValue({});
    const log = fakeLog();

    await projectBookingToExpertCalendar(BASE_INPUT, log);

    expect(mockWriteConsultationEvent).toHaveBeenCalledTimes(1);
    const [call] = mockWriteConsultationEvent.mock.calls;
    expect(call?.[0]).toMatchObject({ connectionId: 'conn-oldest', calendarId: 'calendar-oldest' });
  });

  it('writes the event with baloBookingId === meetingId and the case title above the join URL', async () => {
    mockListConnections.mockResolvedValue([connection()]);
    mockWriteConsultationEvent.mockResolvedValue({});
    const log = fakeLog();

    await projectBookingToExpertCalendar(BASE_INPUT, log);

    const [call] = mockWriteConsultationEvent.mock.calls;
    const writeInput = call?.[0] as {
      meetingId: string;
      baloBookingId: string;
      event: { description?: string; title?: string; privateExtendedProperties?: unknown };
    };
    expect(writeInput.meetingId).toBe('meeting-1');
    expect(writeInput.baloBookingId).toBe('meeting-1');
    expect(writeInput.event.title).toBe('Consultation with Northwind Industrial');
    expect(writeInput.event.description).toBe(`Salesforce CPQ rollout\n\n${BASE_INPUT.joinUrl}`);
    expect(writeInput.event.privateExtendedProperties).toEqual({ baloBookingId: 'meeting-1' });
  });

  it("the writable path reports 'provider_event' and records NO ics row", async () => {
    mockListConnections.mockResolvedValue([connection()]);
    mockWriteConsultationEvent.mockResolvedValue({});

    await expect(projectBookingToExpertCalendar(BASE_INPUT, fakeLog())).resolves.toBe(
      'provider_event'
    );

    // ⚠ THE OTHER HALF OF "NEVER BOTH" AT THE UNIT LEVEL. The structural guarantee is the
    // partial unique on `(meeting_id, party)`; this proves the code never even tries.
    expect(mockRecordIcsDelivery).not.toHaveBeenCalled();
  });

  it('a listConnections throw resolves to an error-logged no-op, never rethrown', async () => {
    mockListConnections.mockRejectedValue(new Error('db unavailable'));
    const log = fakeLog();

    await expect(projectBookingToExpertCalendar(BASE_INPUT, log)).resolves.toBe('failed');
    expect(vi.mocked(log.error)).toHaveBeenCalledTimes(1);
  });

  it('a vendor throw from writeConsultationEvent resolves to an error-logged no-op, never rethrown', async () => {
    mockListConnections.mockResolvedValue([connection()]);
    // A PLAIN Error (the id-substitution assertion's shape) — U3 must NOT record a fallback
    // for this arm, because it fires AFTER a real vendor event already exists.
    mockWriteConsultationEvent.mockRejectedValue(new Error('Apiroc events.create failed'));
    const log = fakeLog();

    await expect(projectBookingToExpertCalendar(BASE_INPUT, log)).resolves.toBe('failed');
    expect(vi.mocked(log.error)).toHaveBeenCalledTimes(1);
    const [[meta]] = vi.mocked(log.error).mock.calls;
    expect(meta).toMatchObject({
      meetingId: 'meeting-1',
      party: 'expert',
      contextType: 'case',
      expertProfileId: 'expert-1',
      providerCreateFailed: false,
    });
    // The failure line is the one an operator reads in Sentry — it must still carry the cause.
    // ⚠ BAL-475 (U3) adds `providerCreateFailed` to this key set.
    expect(Object.keys(meta as object).sort()).toEqual([
      'contextType',
      'error',
      'expertProfileId',
      'meetingId',
      'party',
      'providerCreateFailed',
      'stack',
    ]);
    expect(mockRecordIcsDelivery).not.toHaveBeenCalled();
  });
});

/**
 * BAL-475 (U3) — ADR-1044 Ruling 1's SECOND amendment: an expert who HAS a writable connection
 * falls back to the expert-party ICS when the VENDOR CREATE ITSELF fails, not only when there
 * is no connection to write through.
 */
describe('projectBookingToExpertCalendar — U3: the failed provider-write fallback (BAL-475)', () => {
  beforeEach(() => {
    mockListConnections.mockReset();
    mockWriteConsultationEvent.mockReset();
    mockRecordIcsDelivery.mockReset();
    mockRecordProviderEvent.mockReset();
    mockReconcileByTag.mockReset();
    mockRecordIcsDelivery.mockResolvedValue({ id: 'row-ics-1' });
    mockRecordProviderEvent.mockResolvedValue({ id: 'row-provider-1' });
    mockListConnections.mockResolvedValue([connection()]);
  });

  it('a DEFINITIVE ApirocError (validation) from writeConsultationEvent ⇒ records the expert-party ICS fallback immediately, returns "failed"', async () => {
    // Import the REAL class so `instanceof` matches inside the module under test.
    const { ApirocError: RealApirocError } = await import('../../lib/apiroc/errors.js');
    mockWriteConsultationEvent.mockRejectedValue(
      new RealApirocError({ kind: 'validation', operation: 'events.create' })
    );
    const log = fakeLog();

    await expect(projectBookingToExpertCalendar(BASE_INPUT, log)).resolves.toBe('failed');

    expect(mockRecordIcsDelivery).toHaveBeenCalledWith({ meetingId: 'meeting-1', party: 'expert' });
    expect(mockReconcileByTag).not.toHaveBeenCalled();
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.objectContaining({ providerCreateFailed: true }),
      'Expert calendar projection failed'
    );
  });

  it('an ApirocConfigError (before any call) ⇒ records the expert-party ICS fallback', async () => {
    const { ApirocConfigError: RealApirocConfigError } = await import('../../lib/apiroc/errors.js');
    mockWriteConsultationEvent.mockRejectedValue(
      new RealApirocConfigError('APIROC_API_KEY is not set')
    );
    const log = fakeLog();

    await expect(projectBookingToExpertCalendar(BASE_INPUT, log)).resolves.toBe('failed');

    expect(mockRecordIcsDelivery).toHaveBeenCalledWith({ meetingId: 'meeting-1', party: 'expert' });
  });

  it('a plain Error (the id-substitution assertion, AFTER a real vendor event) ⇒ NOT called', async () => {
    mockWriteConsultationEvent.mockRejectedValue(new Error('id mismatch'));
    const log = fakeLog();

    await expect(projectBookingToExpertCalendar(BASE_INPUT, log)).resolves.toBe('failed');

    expect(mockRecordIcsDelivery).not.toHaveBeenCalled();
  });

  it('F21 (fix round 1, R21) — listConnectionsByExpertProfileId throwing an ApirocConfigError (no target ever selected) ⇒ NOT called, pinning the target !== undefined guard specifically', async () => {
    // A PLAIN Error here would already fail `isVendorCreateFailure` on its own, leaving the
    // `target !== undefined` guard's own contribution unpinned (R21). An `ApirocConfigError`
    // makes `isVendorCreateFailure` TRUE, so the ONLY thing stopping the fallback is that
    // `target` was never assigned — deleting the guard would make this test fail.
    const { ApirocConfigError: RealApirocConfigError } = await import('../../lib/apiroc/errors.js');
    mockListConnections.mockRejectedValue(new RealApirocConfigError('APIROC_API_KEY is not set'));
    const log = fakeLog();

    await expect(projectBookingToExpertCalendar(BASE_INPUT, log)).resolves.toBe('failed');

    expect(mockRecordIcsDelivery).not.toHaveBeenCalled();
    expect(mockReconcileByTag).not.toHaveBeenCalled();
  });

  it('a DEFINITIVE kind whose fallback recordIcsDelivery itself throws ⇒ log.error, still "failed", never rejects', async () => {
    const { ApirocError: RealApirocError } = await import('../../lib/apiroc/errors.js');
    mockWriteConsultationEvent.mockRejectedValue(
      new RealApirocError({ kind: 'validation', operation: 'events.create' })
    );
    mockRecordIcsDelivery.mockRejectedValue(new Error('db unavailable'));
    const log = fakeLog();

    await expect(projectBookingToExpertCalendar(BASE_INPUT, log)).resolves.toBe('failed');
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: 'meeting-1', party: 'expert' }),
      'Failed to record the expert-party ICS fallback after a failed vendor create'
    );
  });
});

/**
 * F17 (fix round 1, R16/S7) — the orchestrator's refinement of U3: a DEFINITIVE client-side
 * refusal falls back to ICS immediately (already covered above); an AMBIGUOUS outcome
 * (`server_error`, `network`, `unknown`) reconciles by the `baloBookingId` tag FIRST.
 */
describe('projectBookingToExpertCalendar — F17: ambiguous vendor-create outcomes reconcile before falling back', () => {
  beforeEach(() => {
    mockListConnections.mockReset();
    mockWriteConsultationEvent.mockReset();
    mockRecordIcsDelivery.mockReset();
    mockRecordProviderEvent.mockReset();
    mockReconcileByTag.mockReset();
    mockRecordIcsDelivery.mockResolvedValue({ id: 'row-ics-1' });
    mockRecordProviderEvent.mockResolvedValue({ id: 'row-provider-1' });
    mockListConnections.mockResolvedValue([connection()]);
  });

  it.each(['server_error', 'network', 'unknown'] as const)(
    'ambiguous kind %s calls reconcileByTag with the SAME endUserAccountId/calendarId/baloBookingId writeConsultationEvent would have used',
    async (kind) => {
      const { ApirocError: RealApirocError } = await import('../../lib/apiroc/errors.js');
      mockWriteConsultationEvent.mockRejectedValue(
        new RealApirocError({ kind, operation: 'events.create' })
      );
      mockReconcileByTag.mockResolvedValue([]);
      const log = fakeLog();

      await expect(projectBookingToExpertCalendar(BASE_INPUT, log)).resolves.toBe('failed');

      expect(mockReconcileByTag).toHaveBeenCalledWith({
        endUserAccountId: 'eua-1',
        calendarId: 'calendar-1',
        baloBookingId: 'meeting-1',
      });
    }
  );

  it('ambiguous + reconcile finds EXACTLY ONE candidate ⇒ recordProviderEvent with that vendor id, NO ics', async () => {
    const { ApirocError: RealApirocError } = await import('../../lib/apiroc/errors.js');
    mockWriteConsultationEvent.mockRejectedValue(
      new RealApirocError({ kind: 'server_error', operation: 'events.create' })
    );
    mockReconcileByTag.mockResolvedValue([{ id: 'vendor-evt-reconciled' }]);
    const log = fakeLog();

    await expect(projectBookingToExpertCalendar(BASE_INPUT, log)).resolves.toBe('failed');

    expect(mockRecordProviderEvent).toHaveBeenCalledWith({
      meetingId: 'meeting-1',
      party: 'expert',
      connectionId: 'conn-1',
      calendarId: 'calendar-1',
      vendorEventId: 'vendor-evt-reconciled',
      baloBookingId: 'meeting-1',
    });
    expect(mockRecordIcsDelivery).not.toHaveBeenCalled();
  });

  it('ambiguous + reconcile finds ZERO candidates ⇒ records the ICS fallback', async () => {
    const { ApirocError: RealApirocError } = await import('../../lib/apiroc/errors.js');
    mockWriteConsultationEvent.mockRejectedValue(
      new RealApirocError({ kind: 'unknown', operation: 'events.create' })
    );
    mockReconcileByTag.mockResolvedValue([]);
    const log = fakeLog();

    await expect(projectBookingToExpertCalendar(BASE_INPUT, log)).resolves.toBe('failed');

    expect(mockRecordIcsDelivery).toHaveBeenCalledWith({ meetingId: 'meeting-1', party: 'expert' });
    expect(mockRecordProviderEvent).not.toHaveBeenCalled();
  });

  it('ambiguous + reconcile itself THROWS ⇒ records the ICS fallback and warns (accepted residual)', async () => {
    const { ApirocError: RealApirocError } = await import('../../lib/apiroc/errors.js');
    mockWriteConsultationEvent.mockRejectedValue(
      new RealApirocError({ kind: 'network', operation: 'events.create' })
    );
    mockReconcileByTag.mockRejectedValue(new Error('events.list failed'));
    const log = fakeLog();

    await expect(projectBookingToExpertCalendar(BASE_INPUT, log)).resolves.toBe('failed');

    expect(mockRecordIcsDelivery).toHaveBeenCalledWith({ meetingId: 'meeting-1', party: 'expert' });
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ apirocErrorKind: 'network' }),
      'Ambiguous vendor create outcome — reconcile itself failed; recording the ICS fallback (accepted residual)'
    );
  });

  it('ambiguous + reconcile finds MORE THAN ONE candidate ⇒ records the ICS fallback and warns with a COUNT only (accepted residual)', async () => {
    const { ApirocError: RealApirocError } = await import('../../lib/apiroc/errors.js');
    mockWriteConsultationEvent.mockRejectedValue(
      new RealApirocError({ kind: 'server_error', operation: 'events.create' })
    );
    mockReconcileByTag.mockResolvedValue([{ id: 'evt-1' }, { id: 'evt-2' }]);
    const log = fakeLog();

    await expect(projectBookingToExpertCalendar(BASE_INPUT, log)).resolves.toBe('failed');

    expect(mockRecordIcsDelivery).toHaveBeenCalledWith({ meetingId: 'meeting-1', party: 'expert' });
    expect(mockRecordProviderEvent).not.toHaveBeenCalled();
    const [[meta]] = vi
      .mocked(log.warn)
      .mock.calls.filter(
        ([, message]) =>
          message ===
          'Ambiguous vendor create outcome — reconcile found more than one candidate event; recording the ICS fallback (accepted residual)'
      );
    expect(meta).toEqual({
      meetingId: 'meeting-1',
      party: 'expert',
      contextType: 'case',
      expertProfileId: 'expert-1',
      apirocErrorKind: 'server_error',
      reconciledCount: 2,
    });
    // No vendor id, no address — a COUNT only.
    expect(JSON.stringify(meta)).not.toContain('evt-1');
    expect(JSON.stringify(meta)).not.toContain('evt-2');
  });

  it('apirocErrorKind logs error.kind, never error.name (R16)', async () => {
    const { ApirocError: RealApirocError } = await import('../../lib/apiroc/errors.js');
    mockWriteConsultationEvent.mockRejectedValue(
      new RealApirocError({ kind: 'rate_limited', operation: 'events.create' })
    );
    const log = fakeLog();

    await projectBookingToExpertCalendar(BASE_INPUT, log);

    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ apirocErrorKind: 'rate_limited' }),
      expect.any(String)
    );
  });

  it("apirocErrorKind is 'config' for an ApirocConfigError", async () => {
    const { ApirocConfigError: RealApirocConfigError } = await import('../../lib/apiroc/errors.js');
    mockWriteConsultationEvent.mockRejectedValue(
      new RealApirocConfigError('APIROC_API_KEY is not set')
    );
    const log = fakeLog();

    await projectBookingToExpertCalendar(BASE_INPUT, log);

    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ apirocErrorKind: 'config' }),
      expect.any(String)
    );
  });
});

/**
 * BAL-433 Slice 1 — ADR-1044 amendment 2026-08-25, RULING 1.
 *
 * ⚠ WHAT CHANGED, AND WHY THE OLD ASSERTIONS COULD NOT SURVIVE: before this slice an expert
 * with no writable calendar produced NOTHING — a `log.info` and a return. Silence is not a
 * fact anything downstream can act on, so BAL-475 would have had to re-derive the condition
 * off `calendar_connections`. The condition is now a durable row.
 *
 * ⚠ AND STILL NOTHING IS BUILT AND NOTHING IS SENT. There is no ICS here, no transport, no
 * notification event — only the recorded condition. BAL-475 delivers; BAL-476 cancels.
 */
describe('projectBookingToExpertCalendar — the expert-party ICS fallback (BAL-433 Ruling 1)', () => {
  beforeEach(() => {
    mockListConnections.mockReset();
    mockWriteConsultationEvent.mockReset();
    mockRecordIcsDelivery.mockReset();
    mockRecordIcsDelivery.mockResolvedValue({ id: 'row-ics-1' });
  });

  /**
   * The FOUR listed cases collapse into ONE predicate — `pickWriteTarget(connections) ===
   * undefined`. iCloud is not a fourth arm: an iCloud expert has NO `calendar_connections` row
   * at all (the connect route's Zod enum admits two providers only), so it reaches here as the
   * first case. ⚠ There is NO provider check at this write path and there never was.
   */
  it.each([
    ['no connection at all (this is also how an iCloud expert arrives)', () => []],
    ['a non-ACTIVE credential', () => [connection({ credentialStatus: 'EXPIRED' })]],
    ['a connection with no target calendar', () => [connection({ targetCalendarId: null })]],
  ])(
    '%s → records the ICS fallback exactly once and writes no vendor event',
    async (_case, rows) => {
      mockListConnections.mockResolvedValue(rows());
      const log = fakeLog();

      await expect(projectBookingToExpertCalendar(BASE_INPUT, log)).resolves.toBe('ics');

      expect(mockRecordIcsDelivery).toHaveBeenCalledTimes(1);
      expect(mockRecordIcsDelivery).toHaveBeenCalledWith({
        meetingId: 'meeting-1',
        party: 'expert',
      });
      expect(mockWriteConsultationEvent).not.toHaveBeenCalled();
      expect(vi.mocked(log.error)).not.toHaveBeenCalled();
    }
  );

  it('logs the CONNECTION COUNT and no provider name, address or calendar id', async () => {
    // The count is what separates "never connected" from "connected but unusable"; anything
    // more would put vendor identity or an address into an operational log.
    mockListConnections.mockResolvedValue([connection({ credentialStatus: 'REVOKED' })]);
    const log = fakeLog();

    await projectBookingToExpertCalendar(BASE_INPUT, log);

    expect(vi.mocked(log.info)).toHaveBeenCalledTimes(1);
    const [[meta, message]] = vi.mocked(log.info).mock.calls;
    // ⚠ AN EXACT KEY SET, NOT A PARTIAL MATCH. Every key is an id or a closed enum
    // (`party`, `contextType`, `deliveryMode`) plus a COUNT — a provider name, a calendar id
    // or anything derived from an address fails right here rather than in a log review.
    expect(meta).toEqual({
      meetingId: 'meeting-1',
      party: 'expert',
      contextType: 'case',
      expertProfileId: 'expert-1',
      connectionCount: 1,
      deliveryMode: 'ics',
    });
    expect(message).toContain('BAL-475');
  });

  it('a throwing recordIcsDelivery degrades to a logged failure — the booking still stands', async () => {
    mockListConnections.mockResolvedValue([]);
    mockRecordIcsDelivery.mockRejectedValue(new Error('db unavailable'));
    const log = fakeLog();

    await expect(projectBookingToExpertCalendar(BASE_INPUT, log)).resolves.toBe('failed');
    expect(vi.mocked(log.error)).toHaveBeenCalledTimes(1);
  });
});

/**
 * BAL-283 — the headline noun is now a per-context INPUT rather than a literal in this module.
 * The default is what makes the `case` path byte-identical to BAL-400's shipped behaviour, so
 * it is pinned here rather than left implied by the suite above.
 */
describe('projectBookingToExpertCalendar — the event label (BAL-283)', () => {
  beforeEach(() => {
    mockListConnections.mockReset();
    mockWriteConsultationEvent.mockReset();
    mockListConnections.mockResolvedValue([connection()]);
    mockWriteConsultationEvent.mockResolvedValue({});
  });

  /** The `event` object handed to the vendor writer on the single expected call. */
  async function writtenEvent(
    input: Parameters<typeof projectBookingToExpertCalendar>[0]
  ): Promise<Record<string, unknown>> {
    await projectBookingToExpertCalendar(input, fakeLog());
    const [call] = mockWriteConsultationEvent.mock.calls;
    return (call?.[0] as { event: Record<string, unknown> }).event;
  }

  it('omitting eventLabel keeps BAL-400\'s exact "Consultation with {company}" headline', async () => {
    const event = await writtenEvent(BASE_INPUT);

    expect(event.title).toBe('Consultation with Northwind Industrial');
  });

  it('an "Intro call" label titles the event without disturbing the subject line', async () => {
    const event = await writtenEvent({ ...BASE_INPUT, eventLabel: 'Intro call' });

    expect(event.title).toBe('Intro call with Northwind Industrial');
    // The subject stays the request's own title, ABOVE the join URL — the label replaces the
    // headline noun only, never the description.
    expect(event.description).toBe(`Salesforce CPQ rollout\n\n${BASE_INPUT.joinUrl}`);
  });

  it('⚠ carries NO attendees and NO generateMeetingUrlProvider on the labelled path either', async () => {
    // ADR-1044 §4 HARD CONSTRAINT / BAL-433 Ruling 2. `event-mapper.test.ts` pins this for the
    // mapper; asserted again HERE so a second context reaching the writer cannot smuggle either
    // field in through the input that BAL-283 widened.
    const event = await writtenEvent({ ...BASE_INPUT, eventLabel: 'Intro call' });

    expect(event.attendees).toBeUndefined();
    expect(event.generateMeetingUrlProvider).toBeUndefined();
  });
});
