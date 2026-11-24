import { describe, it, expect } from 'vitest';
import { ALL_SOURCE_FILES, isCommentLine, readRaw } from './_source-scan.js';

/**
 * BAL-666 — **A SCHEDULED NOTIFICATION IS ONLY EVER MADE TERMINAL-`failed` BY ONE HELPER.**
 *
 * `failScheduledNotification` marks the row, logs, and raises the `scheduled_notification.failed`
 * admin alert. A second caller of `scheduledNotificationsRepository.markFailed(` would fail a row
 * with no alert, which is exactly the silent failure the alert exists to end.
 *
 * ⚠ NO REGEX: `includes` / `split` over non-comment lines only (see `_source-scan.ts`).
 */

const MARKER = 'scheduledNotificationsRepository.markFailed(';
const HELPER = 'notifications/scheduling/fail-scheduled-notification.ts';

function isTestFile(rel: string): boolean {
  return rel.endsWith('.test.ts');
}

function filesCallingMarker(files: readonly string[], read: (rel: string) => string): string[] {
  return files.filter((rel) =>
    read(rel)
      .split('\n')
      .some((line) => !isCommentLine(line) && line.includes(MARKER))
  );
}

const SOURCE_FILES = ALL_SOURCE_FILES.filter((rel) => !isTestFile(rel));

describe('scheduled notifications fail through one helper', () => {
  it('walks a real source tree, including the helper and the dispatcher', () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(50);
    expect(SOURCE_FILES).toContain(HELPER);
    expect(SOURCE_FILES).toContain('jobs/scheduled-notification-dispatch.ts');
  });

  it('calls markFailed in the helper and nowhere else', () => {
    expect(filesCallingMarker(SOURCE_FILES, readRaw)).toEqual([HELPER]);
  });

  it('flags a second caller (positive control)', () => {
    const fake = (rel: string): string =>
      rel === 'a.ts' ? `await ${MARKER}row.id, 'x');` : `// ${MARKER}row.id, 'x')`;
    expect(filesCallingMarker(['a.ts', 'b.ts'], fake)).toEqual(['a.ts']);
  });
});
