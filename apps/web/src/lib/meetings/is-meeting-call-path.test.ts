import { describe, expect, it } from 'vitest';
import { isMeetingCallPath } from './is-meeting-call-path';

describe('isMeetingCallPath', () => {
  it('matches the in-call route', () => {
    expect(isMeetingCallPath('/meetings/0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d/call')).toBe(true);
  });

  it('⚠ does NOT match the BAL-388 recap at the same URL family', () => {
    expect(isMeetingCallPath('/meetings/0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d')).toBe(false);
  });

  it('does not match a deeper or shallower path', () => {
    expect(isMeetingCallPath('/meetings/abc/call/settings')).toBe(false);
    expect(isMeetingCallPath('/meetings/call')).toBe(false);
    expect(isMeetingCallPath('/meetings')).toBe(false);
    expect(isMeetingCallPath('/')).toBe(false);
    expect(isMeetingCallPath('')).toBe(false);
  });

  it('does not match a lookalike prefix on another route', () => {
    expect(isMeetingCallPath('/admin/meetings/abc/call')).toBe(false);
    expect(isMeetingCallPath('/meetingsx/abc/call')).toBe(false);
  });

  it('requires a non-empty meeting id', () => {
    expect(isMeetingCallPath('/meetings//call')).toBe(false);
  });

  it('ignores a query string or a hash', () => {
    expect(isMeetingCallPath('/meetings/abc/call?ended=host')).toBe(true);
    expect(isMeetingCallPath('/meetings/abc/call#top')).toBe(true);
  });
});
