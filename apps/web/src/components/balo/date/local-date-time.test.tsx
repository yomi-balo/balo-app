import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { LocalDateTime, type LocalDateTimeVariant } from './local-date-time';

// Chosen so UTC and Australia/Sydney (AEDT, UTC+11) land on DIFFERENT calendar days —
// 24 Dec in UTC, 25 Dec in Sydney — so the zone-dependent tests below are meaningful.
const ISO = '2026-12-24T23:00:00.000Z';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderedTime(
  iso: string,
  props: { timeZone?: string; variant?: Exclude<LocalDateTimeVariant, 'day-month-time-range'> } = {}
): HTMLElement {
  const { container } = render(<LocalDateTime iso={iso} {...props} />);
  const time = container.querySelector('time');
  if (!(time instanceof HTMLElement)) throw new Error('no <time> rendered');
  return time;
}

describe('LocalDateTime', () => {
  it('with an EXPLICIT timeZone, renders that zone on first paint', () => {
    const time = renderedTime(ISO, { timeZone: 'Australia/Sydney' });

    expect(time.textContent).toMatch(/25 Dec/);
  });

  it('with an explicit timeZone, the sr-only zone span announces it', () => {
    const time = renderedTime(ISO, { timeZone: 'Australia/Sydney' });

    const srOnly = time.querySelector('.sr-only');
    expect(srOnly?.textContent).toContain('Australia/Sydney');
  });

  it('with the prop OMITTED, defaults to UTC on first paint (no hydration mismatch)', () => {
    const time = renderedTime(ISO);

    expect(time.textContent).toMatch(/24 Dec/);
    expect(time.querySelector('.sr-only')?.textContent).toContain('UTC');
  });

  it('with the prop OMITTED, still upgrades to the viewer zone after mount', () => {
    // Only `resolvedOptions()` — the viewer-zone PROBE — is stubbed. The formatting call
    // (`new Intl.DateTimeFormat('en-AU', { timeZone, ... }).format(...)`) is untouched.
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      timeZone: 'Australia/Sydney',
    } as Intl.ResolvedDateTimeFormatOptions);

    const time = renderedTime(ISO);

    expect(time.textContent).toMatch(/25 Dec/);
  });

  it('an explicit timeZone is authoritative and never probes the viewer zone', () => {
    const resolvedOptionsSpy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions');

    renderedTime(ISO, { timeZone: 'Australia/Sydney' });

    expect(resolvedOptionsSpy).not.toHaveBeenCalled();
  });

  describe('day-month-time-range', () => {
    function renderedRange(iso: string, timeZone: string, durationMinutes: number): HTMLElement {
      const { container } = render(
        <LocalDateTime
          iso={iso}
          variant="day-month-time-range"
          timeZone={timeZone}
          durationMinutes={durationMinutes}
        />
      );
      const time = container.querySelector('time');
      if (!(time instanceof HTMLElement)) throw new Error('no <time> rendered');
      return time;
    }

    it('renders the day, the range and the length, all in one string', () => {
      // 08:00 UTC = 6:00 pm Sydney (AEST, +10 in September).
      const time = renderedRange('2026-09-22T08:00:00.000Z', 'Australia/Sydney', 30);

      expect(time.textContent).toContain('Tue, 22 Sept, 6:00 – 6:30 pm · 30 min');
    });

    it('states the am/pm period ONCE when the range does not cross it', () => {
      const time = renderedRange('2026-09-22T08:00:00.000Z', 'Australia/Sydney', 30);

      expect(time.textContent).not.toMatch(/pm.*pm/);
    });

    it('states the am/pm period on BOTH ends once the range crosses noon', () => {
      // 01:45 UTC = 11:45 am Sydney; +30 min crosses into 12:15 pm.
      const time = renderedRange('2026-09-22T01:45:00.000Z', 'Australia/Sydney', 30);

      expect(time.textContent).toContain('11:45 am – 12:15 pm · 30 min');
    });

    it('never renders the range without its length, even before the viewer zone resolves', () => {
      const { container } = render(
        <LocalDateTime iso={ISO} variant="day-month-time-range" durationMinutes={45} />
      );
      const time = container.querySelector('time');

      expect(time?.textContent).toContain('45 min');
    });

    it('showDay={false} drops the date, for a row already grouped under a day heading', () => {
      const { container } = render(
        <LocalDateTime
          iso="2026-09-22T08:00:00.000Z"
          variant="day-month-time-range"
          timeZone="Australia/Sydney"
          durationMinutes={30}
          showDay={false}
        />
      );
      const time = container.querySelector('time');

      expect(time?.textContent).toContain('6:00 – 6:30 pm · 30 min');
      expect(time?.textContent).not.toMatch(/Sept/);
    });
  });
});
