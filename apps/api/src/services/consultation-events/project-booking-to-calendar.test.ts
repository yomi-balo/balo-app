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
