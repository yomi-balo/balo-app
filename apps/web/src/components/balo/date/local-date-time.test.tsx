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
  props: { timeZone?: string; variant?: LocalDateTimeVariant } = {}
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
});
