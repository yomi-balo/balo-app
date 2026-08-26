import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEventsCreate, mockRecordProviderEvent } = vi.hoisted(() => ({
  mockEventsCreate: vi.fn(),
  mockRecordProviderEvent: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  meetingCalendarEventsRepository: { recordProviderEvent: mockRecordProviderEvent },
}));

vi.mock('../../lib/apiroc/index.js', () => ({
  getApirocClient: () => ({ events: { create: mockEventsCreate } }),
  callApiroc: async (_operation: string, fn: () => Promise<unknown>) => fn(),
}));

const { writeConsultationEvent } = await import('./write-consultation-event.js');

const BASE_EVENT = {
  title: 'Consultation',
  start: { dateTime: '2026-08-20T10:00:00.000Z', timeZone: 'UTC' },
  end: { dateTime: '2026-08-20T10:30:00.000Z', timeZone: 'UTC' },
  transparency: 'opaque' as const,
  privateExtendedProperties: { baloBookingId: 'booking-1' },
};

describe('writeConsultationEvent (BAL-396 §5/§10.6)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates the event and records the VENDOR-RETURNED id, not a derived one', async () => {
    mockEventsCreate.mockResolvedValue({ id: 'vendor-event-id-abc' });
    mockRecordProviderEvent.mockResolvedValue({ id: 'row-1' });

    const result = await writeConsultationEvent({
      meetingId: 'meeting-1',
      connectionId: 'conn-1',
      endUserAccountId: 'eua-1',
      calendarId: 'cal-primary',
      baloBookingId: 'booking-1',
      event: BASE_EVENT,
    });

    expect(mockEventsCreate).toHaveBeenCalledWith('eua-1', 'cal-primary', BASE_EVENT);
    expect(mockRecordProviderEvent).toHaveBeenCalledWith({
      meetingId: 'meeting-1',
      // BAL-433 — STRUCTURAL, never a request field: `endUserAccountId` comes off a
      // `calendar_connections` row and that table is keyed on `expert_profile_id`.
      party: 'expert',
      connectionId: 'conn-1',
      calendarId: 'cal-primary',
      vendorEventId: 'vendor-event-id-abc',
      baloBookingId: 'booking-1',
    });
    expect(result).toEqual({ id: 'row-1' });
  });

  it('⚠⚠ M1 — a vendor-returned id that DIFFERS from a caller-supplied id throws, never silently records the wrong one', async () => {
    // Mirrors the observed Microsoft behaviour: HTTP 200, but a substituted Graph id.
    mockEventsCreate.mockResolvedValue({ id: 'AQMkADAw-graph-id' });

    await expect(
      writeConsultationEvent({
        meetingId: 'meeting-1',
        connectionId: 'conn-1',
        endUserAccountId: 'eua-1',
        calendarId: 'cal-primary',
        baloBookingId: 'booking-1',
        event: { ...BASE_EVENT, id: 'bal393spikecustomid001' },
      })
    ).rejects.toThrow(/different event id/i);

    expect(mockRecordProviderEvent).not.toHaveBeenCalled();
  });

  it('a vendor-returned id that MATCHES a caller-supplied id records normally', async () => {
    mockEventsCreate.mockResolvedValue({ id: 'same-id' });
    mockRecordProviderEvent.mockResolvedValue({ id: 'row-1' });

    await writeConsultationEvent({
      meetingId: 'meeting-1',
      connectionId: 'conn-1',
      endUserAccountId: 'eua-1',
      calendarId: 'cal-primary',
      baloBookingId: 'booking-1',
      event: { ...BASE_EVENT, id: 'same-id' },
    });

    expect(mockRecordProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({ vendorEventId: 'same-id' })
    );
  });
});
