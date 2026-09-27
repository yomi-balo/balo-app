import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@/test/utils';
import { analytics } from '@/lib/analytics';
import { AnalyticsIdentify } from './analytics-identify';

/**
 * BAL-504 — `AnalyticsIdentify` owns the identify effect; `PostHogProvider` does not accept
 * `userId`/`userTraitsJson`.
 */
describe('AnalyticsIdentify', () => {
  afterEach(() => {
    vi.mocked(analytics.identify).mockClear();
  });

  it('identifies with the parsed traits when both props are present', () => {
    render(
      <AnalyticsIdentify userId="user-1" userTraitsJson={JSON.stringify({ email: 'a@b.com' })} />
    );

    expect(analytics.identify).toHaveBeenCalledWith('user-1', { email: 'a@b.com' });
  });

  it('does not identify when userId is absent', () => {
    render(<AnalyticsIdentify userTraitsJson={JSON.stringify({ email: 'a@b.com' })} />);

    expect(analytics.identify).not.toHaveBeenCalled();
  });

  it('does not identify when userTraitsJson is absent', () => {
    render(<AnalyticsIdentify userId="user-1" />);

    expect(analytics.identify).not.toHaveBeenCalled();
  });

  it('re-identifies when userId changes', () => {
    const { rerender } = render(
      <AnalyticsIdentify userId="user-1" userTraitsJson={JSON.stringify({ email: 'a@b.com' })} />
    );
    rerender(
      <AnalyticsIdentify userId="user-2" userTraitsJson={JSON.stringify({ email: 'a@b.com' })} />
    );

    expect(analytics.identify).toHaveBeenCalledTimes(2);
    expect(analytics.identify).toHaveBeenLastCalledWith('user-2', { email: 'a@b.com' });
  });
});
