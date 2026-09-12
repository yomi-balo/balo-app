import { describe, it, expect } from 'vitest';
import { parseCaptureHealthWindow, parseCaptureHealthCategory } from './window';

describe('parseCaptureHealthWindow', () => {
  it('defaults to a 30-day window ending today when nothing is supplied', () => {
    const view = parseCaptureHealthWindow({});
    expect(view.days).toBe(30);
    expect(view.fellBack).toBe(false);
    const spanMs = view.to.getTime() - view.from.getTime();
    expect(spanMs).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('a valid explicit range is honoured, half-open on `to`', () => {
    const view = parseCaptureHealthWindow({ from: '2026-08-01', to: '2026-08-10' });
    expect(view.fromIso).toBe('2026-08-01');
    expect(view.toIso).toBe('2026-08-10');
    expect(view.days).toBe(10);
    expect(view.to.toISOString()).toBe('2026-08-11T00:00:00.000Z');
    expect(view.from.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(view.fellBack).toBe(false);
  });

  it('invalid input falls back to the default, never a throw', () => {
    const view = parseCaptureHealthWindow({ from: 'not-a-date', to: '2026-08-10' });
    expect(view.fellBack).toBe(true);
    expect(view.days).toBe(30);
  });

  it('an inverted range (from after to) falls back to the default', () => {
    const view = parseCaptureHealthWindow({ from: '2026-08-20', to: '2026-08-10' });
    expect(view.fellBack).toBe(true);
    expect(view.days).toBe(30);
  });

  it('a semantically invalid date (Feb 30) is rejected, not silently rolled over', () => {
    const view = parseCaptureHealthWindow({ from: '2026-02-30', to: '2026-08-10' });
    expect(view.fellBack).toBe(true);
  });

  it('a span over the cap is clamped, keeping `to` fixed', () => {
    const view = parseCaptureHealthWindow({ from: '2020-01-01', to: '2026-08-10' });
    expect(view.fellBack).toBe(true);
    expect(view.days).toBe(180);
    expect(view.toIso).toBe('2026-08-10');
  });
});

describe('parseCaptureHealthCategory', () => {
  it('accepts each known tile', () => {
    expect(parseCaptureHealthCategory('recording')).toBe('recording');
    expect(parseCaptureHealthCategory('transcription')).toBe('transcription');
    expect(parseCaptureHealthCategory('recap')).toBe('recap');
    expect(parseCaptureHealthCategory('healthy')).toBe('healthy');
  });

  it('returns null for undefined or an unknown value', () => {
    expect(parseCaptureHealthCategory(undefined)).toBeNull();
    expect(parseCaptureHealthCategory('bogus')).toBeNull();
    expect(parseCaptureHealthCategory('__proto__')).toBeNull();
  });
});
