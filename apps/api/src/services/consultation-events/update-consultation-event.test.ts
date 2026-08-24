import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEventsUpdate, mockCallApiroc } = vi.hoisted(() => ({
  mockEventsUpdate: vi.fn(),
  mockCallApiroc: vi.fn(async (_operation: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../lib/apiroc/index.js', () => ({
  getApirocClient: () => ({ events: { update: mockEventsUpdate } }),
  callApiroc: mockCallApiroc,
}));

const { updateConsultationEvent } = await import('./update-consultation-event.js');

const START = new Date('2026-09-01T10:00:00.000Z');
const END = new Date('2026-09-01T10:30:00.000Z');

const INPUT = {
  meetingId: 'meeting-1',
  endUserAccountId: 'eua-1',
  calendarId: 'cal-primary',
  vendorEventId: 'vendor-event-id-abc',
  startAt: START,
  endAt: END,
};

describe('updateConsultationEvent — T-CAL (BAL-409)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends ONLY start/end — no id, no privateExtendedProperties, no attendees', async () => {
    mockEventsUpdate.mockResolvedValue({});

    await updateConsultationEvent(INPUT);

    expect(mockEventsUpdate).toHaveBeenCalledWith('eua-1', 'cal-primary', 'vendor-event-id-abc', {
      start: { dateTime: START.toISOString(), timeZone: 'UTC' },
      end: { dateTime: END.toISOString(), timeZone: 'UTC' },
    });
    const [, , , data] = mockEventsUpdate.mock.calls[0] as [string, string, string, object];
    expect(data).not.toHaveProperty('id');
    expect(data).not.toHaveProperty('privateExtendedProperties');
    expect(data).not.toHaveProperty('attendees');
  });

  it('uses the STORED calendarId and vendorEventId — never re-derived', async () => {
    mockEventsUpdate.mockResolvedValue({});

    await updateConsultationEvent({
      ...INPUT,
      calendarId: 'stored-cal',
      vendorEventId: 'stored-vendor-id',
    });

    expect(mockEventsUpdate).toHaveBeenCalledWith(
      'eua-1',
      'stored-cal',
      'stored-vendor-id',
      expect.anything()
    );
  });

  it('a Microsoft-shaped {} response is NOT treated as failure — no response is read at all', async () => {
    mockEventsUpdate.mockResolvedValue({ privateExtendedProperties: {} });

    await expect(updateConsultationEvent(INPUT)).resolves.toBeUndefined();
  });

  it('exactly one callApiroc invocation, labelled events.update', async () => {
    mockEventsUpdate.mockResolvedValue({});

    await updateConsultationEvent(INPUT);

    expect(mockCallApiroc).toHaveBeenCalledTimes(1);
    expect(mockCallApiroc.mock.calls[0]?.[0]).toBe('events.update');
  });

  it('propagates a thrown ApirocError from callApiroc without swallowing it', async () => {
    class FakeApirocError extends Error {
      readonly kind = 'server_error';
    }
    mockCallApiroc.mockRejectedValueOnce(new FakeApirocError('boom'));

    await expect(updateConsultationEvent(INPUT)).rejects.toThrow('boom');
  });
});
