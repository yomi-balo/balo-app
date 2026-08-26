import { describe, it, expect } from 'vitest';
import { RECORDING_SERVER_EVENTS } from './recording';

describe('RECORDING_SERVER_EVENTS', () => {
  it('exposes exactly the BAL-473 recording server events', () => {
    expect(Object.keys(RECORDING_SERVER_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'RECORDING_FAILED',
      'RECORDING_READY',
      'RECORDING_STARTED',
    ]);
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(RECORDING_SERVER_EVENTS.RECORDING_STARTED).toBe('recording_started');
    expect(RECORDING_SERVER_EVENTS.RECORDING_READY).toBe('recording_ready');
    expect(RECORDING_SERVER_EVENTS.RECORDING_FAILED).toBe('recording_failed');
  });

  it('uses snake_case event values', () => {
    for (const value of Object.values(RECORDING_SERVER_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});
