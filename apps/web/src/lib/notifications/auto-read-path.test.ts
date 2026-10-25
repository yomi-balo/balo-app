import { describe, it, expect } from 'vitest';
import { isAutoReadablePath } from './auto-read-path';

describe('isAutoReadablePath', () => {
  it.each(['/cases/c1', '/projects/p1', '/engagements/e1', '/meetings/m1'])(
    'accepts entity path %s',
    (path) => {
      expect(isAutoReadablePath(path)).toBe(true);
    }
  );

  it.each([
    '/projects',
    '/experts',
    '/settings/billing',
    '/meetings/m1/call',
    '/projects/p1/files',
    '/cases/',
    '/cases',
    '/cases/c1/',
    '/billing/top-up',
    '/',
    '',
  ])('rejects non-entity path %s', (path) => {
    expect(isAutoReadablePath(path)).toBe(false);
  });
});
