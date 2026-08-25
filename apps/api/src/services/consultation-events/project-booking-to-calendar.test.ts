import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

const { mockListConnections, mockWriteConsultationEvent } = vi.hoisted(() => ({
  mockListConnections: vi.fn(),
  mockWriteConsultationEvent: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  calendarRepository: { listConnectionsByExpertProfileId: mockListConnections },
}));

vi.mock('./write-consultation-event.js', () => ({
  writeConsultationEvent: (...args: unknown[]) => mockWriteConsultationEvent(...args),
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
  });

  it('no connection at all → logged no-op, never throws', async () => {
    mockListConnections.mockResolvedValue([]);
    const log = fakeLog();

    await expect(projectBookingToExpertCalendar(BASE_INPUT, log)).resolves.toBeUndefined();

    expect(mockWriteConsultationEvent).not.toHaveBeenCalled();
    expect(vi.mocked(log.info)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.error)).not.toHaveBeenCalled();
  });

  it('credentialStatus !== ACTIVE → no-op', async () => {
    mockListConnections.mockResolvedValue([connection({ credentialStatus: 'EXPIRED' })]);
    const log = fakeLog();

    await projectBookingToExpertCalendar(BASE_INPUT, log);

    expect(mockWriteConsultationEvent).not.toHaveBeenCalled();
    expect(vi.mocked(log.info)).toHaveBeenCalledTimes(1);
  });

  it('targetCalendarId === null → no-op', async () => {
    mockListConnections.mockResolvedValue([connection({ targetCalendarId: null })]);
    const log = fakeLog();

    await projectBookingToExpertCalendar(BASE_INPUT, log);

    expect(mockWriteConsultationEvent).not.toHaveBeenCalled();
    expect(vi.mocked(log.info)).toHaveBeenCalledTimes(1);
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

  it('a listConnections throw resolves to an error-logged no-op, never rethrown', async () => {
    mockListConnections.mockRejectedValue(new Error('db unavailable'));
    const log = fakeLog();

    await expect(projectBookingToExpertCalendar(BASE_INPUT, log)).resolves.toBeUndefined();
    expect(vi.mocked(log.error)).toHaveBeenCalledTimes(1);
  });

  it('a vendor throw from writeConsultationEvent resolves to an error-logged no-op, never rethrown', async () => {
    mockListConnections.mockResolvedValue([connection()]);
    mockWriteConsultationEvent.mockRejectedValue(new Error('Apiroc events.create failed'));
    const log = fakeLog();

    await expect(projectBookingToExpertCalendar(BASE_INPUT, log)).resolves.toBeUndefined();
    expect(vi.mocked(log.error)).toHaveBeenCalledTimes(1);
    const [[meta]] = vi.mocked(log.error).mock.calls;
    expect(meta).toMatchObject({ meetingId: 'meeting-1', expertProfileId: 'expert-1' });
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
