import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';

const { mockFindPending } = vi.hoisted(() => ({ mockFindPending: vi.fn() }));
vi.mock('@balo/db', () => ({
  expertsRepository: { findPendingApplicationByUserId: mockFindPending },
}));

import { ApplicationReviewBannerSlot } from './application-review-banner-slot';
import { log } from '@/lib/logging';

async function renderSlot(): Promise<ReturnType<typeof render>> {
  return render(
    (await ApplicationReviewBannerSlot({ userId: 'u-1', email: 'dana@northwind.test' })) ?? <></>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ApplicationReviewBannerSlot', () => {
  it("shows the banner while the viewer's application awaits a decision", async () => {
    mockFindPending.mockResolvedValue({ submittedAt: new Date('2026-10-03T09:00:00.000Z') });
    await renderSlot();
    expect(mockFindPending).toHaveBeenCalledWith('u-1');
    expect(screen.getByText('Your expert application is under review')).toBeInTheDocument();
    // Formatted on the server, never in the browser's timezone.
    expect(screen.getByRole('status')).toHaveTextContent('Submitted on October 3, 2026.');
  });

  it('renders nothing when there is no pending application', async () => {
    mockFindPending.mockResolvedValue(undefined);
    expect(
      await ApplicationReviewBannerSlot({ userId: 'u-1', email: 'dana@northwind.test' })
    ).toBeNull();
  });

  it('renders nothing on a failed read, and leaves a trace', async () => {
    mockFindPending.mockRejectedValue(new Error('db down'));
    expect(
      await ApplicationReviewBannerSlot({ userId: 'u-1', email: 'dana@northwind.test' })
    ).toBeNull();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      'Failed to read pending expert application for the dashboard banner',
      { userId: 'u-1', error: 'db down' }
    );
  });
});
