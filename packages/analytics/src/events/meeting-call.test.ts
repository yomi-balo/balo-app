import { describe, it, expect } from 'vitest';
import { MEETING_CALL_EVENTS } from './meeting-call';

describe('MEETING_CALL_EVENTS (client)', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(MEETING_CALL_EVENTS)).toEqual([
      'JOINED',
      'LAYOUT_CHANGED',
      'SCREENSHARE_STARTED',
      'SCREENSHARE_STOPPED',
      'RECONNECTED',
      'LEFT',
      'ENDED_FOR_ALL',
      'GRANT_REJECTED',
      'ERROR',
      'DEVICE_BLOCKED',
    ]);
  });

  it('maps each constant to its snake_case event name', () => {
    expect(MEETING_CALL_EVENTS.JOINED).toBe('meeting_call_joined');
    expect(MEETING_CALL_EVENTS.LAYOUT_CHANGED).toBe('meeting_call_layout_changed');
    expect(MEETING_CALL_EVENTS.SCREENSHARE_STARTED).toBe('meeting_call_screenshare_started');
    expect(MEETING_CALL_EVENTS.SCREENSHARE_STOPPED).toBe('meeting_call_screenshare_stopped');
    expect(MEETING_CALL_EVENTS.RECONNECTED).toBe('meeting_call_reconnected');
    expect(MEETING_CALL_EVENTS.LEFT).toBe('meeting_call_left');
    expect(MEETING_CALL_EVENTS.ENDED_FOR_ALL).toBe('meeting_call_ended_for_all');
    expect(MEETING_CALL_EVENTS.GRANT_REJECTED).toBe('meeting_call_grant_rejected');
    expect(MEETING_CALL_EVENTS.ERROR).toBe('meeting_call_error');
    expect(MEETING_CALL_EVENTS.DEVICE_BLOCKED).toBe('meeting_call_device_blocked');
  });

  it('values follow the snake_case naming convention', () => {
    for (const value of Object.values(MEETING_CALL_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });

  it('every value carries the meeting_call feature prefix', () => {
    for (const value of Object.values(MEETING_CALL_EVENTS)) {
      expect(value.startsWith('meeting_call_')).toBe(true);
    }
  });
});
