import { describe, it, expect } from 'vitest';
import { CalendarAuthError, CalendarNotConnectedError } from './errors';

describe('CalendarAuthError', () => {
  it('sets name to CalendarAuthError', () => {
    const err = new CalendarAuthError('auth revoked');
    expect(err.name).toBe('CalendarAuthError');
  });

  it('sets the message', () => {
    const err = new CalendarAuthError('token expired');
    expect(err.message).toBe('token expired');
  });

  it('is an instance of Error', () => {
    const err = new CalendarAuthError('test');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('CalendarNotConnectedError', () => {
  it('sets name to CalendarNotConnectedError', () => {
    const err = new CalendarNotConnectedError('expert-123');
    expect(err.name).toBe('CalendarNotConnectedError');
  });

  it('includes expertProfileId in message', () => {
    const err = new CalendarNotConnectedError('expert-456');
    expect(err.message).toBe('Expert expert-456 has no connected calendar');
  });

  it('is an instance of Error', () => {
    const err = new CalendarNotConnectedError('test');
    expect(err).toBeInstanceOf(Error);
  });
});
