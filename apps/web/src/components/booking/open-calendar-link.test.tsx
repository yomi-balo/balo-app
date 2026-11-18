import { afterEach, describe, expect, it, vi } from 'vitest';
import { navigateToCalendarLink, openCalendarLinkInNewTab } from './open-calendar-link';

const URL_ = 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=Call';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('openCalendarLinkInNewTab', () => {
  it('opens a new tab, cuts its opener and reports success', () => {
    const tab = { opener: globalThis as unknown } as Window;
    const open = vi.spyOn(globalThis, 'open').mockReturnValue(tab);
    expect(openCalendarLinkInNewTab(URL_)).toBe(true);
    expect(open).toHaveBeenCalledWith(URL_, '_blank');
    expect(tab.opener).toBeNull();
  });

  it('reports a blocked tab and never navigates this one', () => {
    vi.spyOn(globalThis, 'open').mockReturnValue(null);
    const assign = vi.fn();
    vi.spyOn(globalThis, 'location', 'get').mockReturnValue({ assign } as unknown as Location);
    expect(openCalendarLinkInNewTab(URL_)).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('navigateToCalendarLink', () => {
  it('navigates this tab and opens no popup', () => {
    const open = vi.spyOn(globalThis, 'open');
    const assign = vi.fn();
    vi.spyOn(globalThis, 'location', 'get').mockReturnValue({ assign } as unknown as Location);
    navigateToCalendarLink(URL_);
    expect(assign).toHaveBeenCalledWith(URL_);
    expect(open).not.toHaveBeenCalled();
  });
});
