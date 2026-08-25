import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEventsDelete, mockFindLiveExpertProviderEvent, mockSoftDeleteByMeetingAndParty } =
  vi.hoisted(() => ({
    mockEventsDelete: vi.fn(),
    mockFindLiveExpertProviderEvent: vi.fn(),
    mockSoftDeleteByMeetingAndParty: vi.fn(),
  }));

vi.mock('@balo/db', () => ({
  meetingCalendarEventsRepository: {
    findLiveExpertProviderEvent: mockFindLiveExpertProviderEvent,
    softDeleteByMeetingAndParty: mockSoftDeleteByMeetingAndParty,
  },
}));

vi.mock('../../lib/apiroc/index.js', () => ({
  getApirocClient: () => ({ events: { delete: mockEventsDelete } }),
  callApiroc: async (_operation: string, fn: () => Promise<unknown>) => fn(),
}));

const { deleteConsultationEvent } = await import('./delete-consultation-event.js');

describe('deleteConsultationEvent (BAL-396 §5/§10.6)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is a no-op when there is no live row — never throws, never calls the vendor', async () => {
    mockFindLiveExpertProviderEvent.mockResolvedValue(undefined);

    await deleteConsultationEvent({ meetingId: 'meeting-1', endUserAccountId: 'eua-1' });

    expect(mockEventsDelete).not.toHaveBeenCalled();
    expect(mockSoftDeleteByMeetingAndParty).not.toHaveBeenCalled();
  });

  it('deletes using the STORED calendarId (never a current target_calendar_id) and the stored vendorEventId', async () => {
    mockFindLiveExpertProviderEvent.mockResolvedValue({
      id: 'row-1',
      meetingId: 'meeting-1',
      calendarId: 'cal-stored-at-write-time',
      vendorEventId: 'vendor-event-1',
    });

    await deleteConsultationEvent({ meetingId: 'meeting-1', endUserAccountId: 'eua-1' });

    expect(mockEventsDelete).toHaveBeenCalledWith(
      'eua-1',
      'cal-stored-at-write-time',
      'vendor-event-1'
    );
    expect(mockSoftDeleteByMeetingAndParty).toHaveBeenCalledWith('meeting-1', 'expert');
  });

  /**
   * ⚠⚠ round-2 fix #14 — THE ORDERING REGRESSION TEST. A prior revision of this test pinned
   * the OPPOSITE ordering ("soft-deletes ONLY after the vendor delete succeeds"), which
   * directly contradicted `meetingCalendarEventsRepository.softDeleteByMeetingAndParty`'s own
   * docstring: "Marking first and deleting after is the right order — an orphaned vendor
   * event is recoverable via balo_booking_id, a lost row is not." A caller following that
   * repository docstring would get `findLiveExpertProviderEvent → undefined` on the next call (row
   * already marked deleted) and the vendor event would NEVER get deleted under the old,
   * delete-then-mark order if the process crashed in between. This test now asserts the
   * documented order: mark first, delete at the vendor second — and that a vendor-delete
   * failure does NOT roll the mark back (the accepted tradeoff the docstring names).
   */
  it('marks Balo’s row deleted BEFORE calling the vendor, and does not roll the mark back if the vendor delete fails', async () => {
    const callOrder: string[] = [];
    mockFindLiveExpertProviderEvent.mockResolvedValue({
      calendarId: 'cal-1',
      vendorEventId: 'vendor-1',
    });
    mockSoftDeleteByMeetingAndParty.mockImplementation(async () => {
      callOrder.push('mark');
    });
    mockEventsDelete.mockImplementation(async () => {
      callOrder.push('vendor-delete');
      throw new Error('vendor 500');
    });

    await expect(
      deleteConsultationEvent({ meetingId: 'meeting-1', endUserAccountId: 'eua-1' })
    ).rejects.toThrow('vendor 500');

    // The mark happened, and happened BEFORE the vendor call — not rolled back on failure.
    expect(mockSoftDeleteByMeetingAndParty).toHaveBeenCalledWith('meeting-1', 'expert');
    expect(callOrder).toEqual(['mark', 'vendor-delete']);
  });

  it('the happy path also marks before deleting at the vendor', async () => {
    const callOrder: string[] = [];
    mockFindLiveExpertProviderEvent.mockResolvedValue({
      calendarId: 'cal-1',
      vendorEventId: 'vendor-1',
    });
    mockSoftDeleteByMeetingAndParty.mockImplementation(async () => {
      callOrder.push('mark');
    });
    mockEventsDelete.mockImplementation(async () => {
      callOrder.push('vendor-delete');
    });

    await deleteConsultationEvent({ meetingId: 'meeting-1', endUserAccountId: 'eua-1' });

    expect(callOrder).toEqual(['mark', 'vendor-delete']);
  });
});
