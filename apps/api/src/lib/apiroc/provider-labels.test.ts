import { describe, expect, it } from 'vitest';
import { calendarProviderLabel } from './provider-labels.js';

describe('calendarProviderLabel', () => {
  it("maps 'google' to the Google Calendar label", () => {
    expect(calendarProviderLabel('google')).toBe('Google Calendar');
  });

  /**
   * ⚠ BAL-396 FIX ROUND — includes the trailing "calendar" noun, unlike "Google Calendar"
   * (which already carries it). Composing the noun HERE is what makes both call sites'
   * `your ${providerLabel}` interpolation produce "your Google Calendar" / "your Microsoft
   * 365 calendar" / "your calendar" — never a doubled noun.
   */
  it("maps 'microsoft' to the Microsoft 365 calendar label", () => {
    expect(calendarProviderLabel('microsoft')).toBe('Microsoft 365 calendar');
  });

  it('degrades unrecognised values to the generic noun rather than throwing', () => {
    expect(calendarProviderLabel('apple')).toBe('calendar');
    expect(calendarProviderLabel(undefined)).toBe('calendar');
    expect(calendarProviderLabel(null)).toBe('calendar');
    expect(calendarProviderLabel(42)).toBe('calendar');
    expect(calendarProviderLabel({})).toBe('calendar');
  });
});
