import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@/test/utils';
import { track, BILLING_EVENTS } from '@/lib/analytics';
import { BillingBlockedViewTracker } from './billing-blocked-view-tracker';

describe('BillingBlockedViewTracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fires billing_details_blocked_view once on mount', () => {
    render(<BillingBlockedViewTracker companyId="company-1" requestId="req-1" />);
    expect(track).toHaveBeenCalledWith(BILLING_EVENTS.DETAILS_BLOCKED_VIEW, {
      company_id: 'company-1',
      request_id: 'req-1',
    });
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('renders nothing', () => {
    const { container } = render(<BillingBlockedViewTracker companyId="c" requestId="r" />);
    expect(container).toBeEmptyDOMElement();
  });
});
