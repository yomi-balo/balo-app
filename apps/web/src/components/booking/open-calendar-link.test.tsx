import { afterEach, describe, expect, it, vi } from 'vitest';
import { openCalendarLink } from './open-calendar-link';

const URL_ = 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=Call';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('openCalendarLink', () => {
  it('opens a new tab and cuts its opener', () => {
    const tab = { opener: globalThis as unknown } as Window;
    const open = vi.spyOn(globalThis, 'open').mockReturnValue(tab);
    openCalendarLink(URL_);
    expect(open).toHaveBeenCalledWith(URL_, '_blank');
    expect(tab.opener).toBeNull();
  });

  it('falls back to this tab when the popup is blocked (an in-app browser)', () => {
    vi.spyOn(globalThis, 'open').mockReturnValue(null);
    const assign = vi.fn();
    vi.spyOn(globalThis, 'location', 'get').mockReturnValue({ assign } as unknown as Location);
    openCalendarLink(URL_);
    expect(assign).toHaveBeenCalledWith(URL_);
  });
});
