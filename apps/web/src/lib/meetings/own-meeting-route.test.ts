import { describe, it, expect } from 'vitest';
import { meetingIdOfRecapOrEndPath } from './own-meeting-route';

describe('meetingIdOfRecapOrEndPath', () => {
  it.each([
    ['/meetings/abc', 'abc'],
    ['/meetings/abc/end', 'abc'],
    ['/meetings/abc?tab=1', 'abc'],
    ['/meetings/abc/end#top', 'abc'],
  ])('%s → %s', (pathname, expected) => {
    expect(meetingIdOfRecapOrEndPath(pathname)).toBe(expected);
  });

  it.each([
    '/meetings/abc/call',
    '/meetings',
    '/meetings/',
    '/meetings//end',
    '/meetings/abc/end/y',
    '/cases/abc',
    '/cases/abc/end',
    'meetings/abc',
    '/other/meetings/abc',
    '',
  ])('%s → null', (pathname) => {
    expect(meetingIdOfRecapOrEndPath(pathname)).toBeNull();
  });
});
