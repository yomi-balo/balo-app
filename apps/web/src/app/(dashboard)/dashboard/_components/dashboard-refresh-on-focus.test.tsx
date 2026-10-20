import { describe, it, expect, vi } from 'vitest';
import { render } from '@/test/utils';

const mockUseRefreshOnFocus = vi.fn();
vi.mock('@/hooks/use-refresh-on-focus', () => ({
  useRefreshOnFocus: () => mockUseRefreshOnFocus(),
}));

import { DashboardRefreshOnFocus } from './dashboard-refresh-on-focus';

describe('DashboardRefreshOnFocus', () => {
  it('calls the refresh-on-focus hook once and renders nothing', () => {
    const { container } = render(<DashboardRefreshOnFocus />);
    expect(mockUseRefreshOnFocus).toHaveBeenCalledTimes(1);
    expect(container).toBeEmptyDOMElement();
  });
});
