import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';

vi.mock('server-only', () => ({}));

// Spies that MUST NOT be called — the mock booking is fully decoupled from the
// state machine + notifications.
const mockTransitionStatus = vi.fn();
const mockFindById = vi.fn();
vi.mock('@balo/db', () => ({
  projectRequestsRepository: {
    findById: (...args: unknown[]) => mockFindById(...args),
    transitionStatus: (...args: unknown[]) => mockTransitionStatus(...args),
  },
}));

const mockPublish = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublish(...args),
}));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireUser(),
}));

import { bookExploratoryMeetingAction } from './book-exploratory';

describe('bookExploratoryMeetingAction (MOCK seam)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue({ id: 'user-client', companyId: 'company-1' });
    mockFindById.mockResolvedValue({
      id: REQUEST_ID,
      companyId: 'company-1',
      status: 'exploratory_meeting_requested',
    });
  });

  it('requires a signed-in user', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    const result = await bookExploratoryMeetingAction({ requestId: REQUEST_ID });
    expect(result).toEqual({ success: false, error: 'You must be signed in to book a call.' });
  });

  it('rejects an invalid (non-UUID) requestId', async () => {
    const result = await bookExploratoryMeetingAction({ requestId: 'not-a-uuid' });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('returns a not-found error when the request no longer exists', async () => {
    mockFindById.mockResolvedValue(undefined);
    const result = await bookExploratoryMeetingAction({ requestId: REQUEST_ID });
    expect(result).toEqual({ success: false, error: 'This request no longer exists.' });
  });

  it('returns a generic error when the lookup throws', async () => {
    mockFindById.mockRejectedValue(new Error('db down'));
    const result = await bookExploratoryMeetingAction({ requestId: REQUEST_ID });
    expect(result).toEqual({
      success: false,
      error: 'Could not book your call. Please try again.',
    });
  });

  it('rejects a non-owner (different company)', async () => {
    mockRequireUser.mockResolvedValue({ id: 'user-other', companyId: 'company-2' });
    const result = await bookExploratoryMeetingAction({ requestId: REQUEST_ID });
    expect(result).toEqual({ success: false, error: 'You do not have permission to do this.' });
  });

  it('rejects when the request is not awaiting a booking', async () => {
    mockFindById.mockResolvedValue({
      id: REQUEST_ID,
      companyId: 'company-1',
      status: 'requested',
    });
    const result = await bookExploratoryMeetingAction({ requestId: REQUEST_ID });
    expect(result).toEqual({ success: false, error: 'No exploratory call to book.' });
  });

  it('returns a mocked confirmation on the happy path', async () => {
    const result = await bookExploratoryMeetingAction({ requestId: REQUEST_ID });
    expect(result).toEqual({
      success: true,
      mocked: true,
      confirmation: {
        message: 'Your exploratory call is booked. Balo will email you the details.',
        scheduledAtIso: null,
      },
    });
  });

  it('does NOT transition status or publish any notification (decoupling guarantee)', async () => {
    await bookExploratoryMeetingAction({ requestId: REQUEST_ID });
    expect(mockTransitionStatus).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });
});
