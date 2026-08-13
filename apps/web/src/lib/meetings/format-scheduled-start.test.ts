import { describe, expect, it } from 'vitest';
import { formatScheduledStartLabel } from './format-scheduled-start';

/**
 * BAL-435 (ruling R10) — the scheduled start, in the viewer's own timezone.
 *
 * ⚠ THE SUITE RUNS UNDER `TZ=UTC` (memory `reference_web_tests_need_tz_utc`), so the formatted
 * value is stable here while remaining viewer-local in a browser.
 */
describe('formatScheduledStartLabel', () => {
  it('formats an ISO instant as a short local time', () => {
    const label = formatScheduledStartLabel('2026-09-02T10:00:00.000Z');

    expect(label).not.toBeNull();
    // ⚠ NOT a hardcoded 'en-US' string: the runtime's own locale decides 12h vs 24h, so the
    // assertion is on the SHAPE rather than on a literal a CI locale change would break.
    expect(label ?? '').toMatch(/10[:.]00/);
  });

  it('⚠ null in ⇒ null out — the caller then has no subject and renders neutral copy', () => {
    expect(formatScheduledStartLabel(null)).toBeNull();
  });

  it('⚠⚠ an unparseable instant is null, NEVER a placeholder like "the scheduled time"', () => {
    for (const raw of ['', 'soon', '2026-13-45', 'not a date']) {
      expect(formatScheduledStartLabel(raw)).toBeNull();
    }
  });
});
