import { describe, it, expect } from 'vitest';
import { resolveWorkspaceBackHref } from './workspace-back-href';

describe('resolveWorkspaceBackHref', () => {
  it.each([
    ['agency', 'agency-1', '/projects?lens=agency&agency=agency-1'],
    ['agency', null, '/projects'],
    ['inbox', 'agency-1', '/projects'],
    ['request_detail', 'agency-1', '/projects'],
    ['bogus', 'agency-1', '/projects'],
    [undefined, 'agency-1', '/projects'],
    [undefined, null, '/projects'],
  ])('from=%s agencyId=%s -> %s', (from, agencyId, expected) => {
    expect(resolveWorkspaceBackHref(from, agencyId)).toBe(expected);
  });
});
