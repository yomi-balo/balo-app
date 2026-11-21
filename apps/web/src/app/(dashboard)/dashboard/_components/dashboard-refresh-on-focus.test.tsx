import { describe, it, expect, vi } from 'vitest';
import { render } from '@/test/utils';

const mockUseRefreshOnFocus = vi.fn();
vi.mock('@/hooks/use-refresh-on-focus', () => ({
  useRefreshOnFocus: () => mockUseRefreshOnFocus(),
}));
const mockUseRefreshOnMeetingsChanged = vi.fn();
vi.mock('@/hooks/use-refresh-on-meetings-changed', () => ({
  useRefreshOnMeetingsChanged: () => mockUseRefreshOnMeetingsChanged(),
}));

import { DashboardRefreshOnFocus } from './dashboard-refresh-on-focus';

describe('DashboardRefreshOnFocus', () => {
  it('calls the focus and meetings-changed refresh hooks once each and renders nothing', () => {
    const { container } = render(<DashboardRefreshOnFocus />);
    expect(mockUseRefreshOnFocus).toHaveBeenCalledTimes(1);
    expect(mockUseRefreshOnMeetingsChanged).toHaveBeenCalledTimes(1);
    expect(container).toBeEmptyDOMElement();
  });
});
