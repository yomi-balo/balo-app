import { describe, it, expect } from 'vitest';
import { CALENDAR_SLOT_STATUS } from './calendar-slot-status';

describe('CALENDAR_SLOT_STATUS', () => {
  it.each([
    ['connected', 'Connected', 'success'],
    ['setting_up', 'Setting up', 'neutral'],
    ['reconnect_needed', 'Reconnect needed', 'warning'],
    ['attempt_failed', "Didn't finish", 'destructive'],
    ['connecting', 'Waiting for you', 'neutral'],
    ['o365_waiting', 'Waiting on IT', 'warning'],
  ] as const)('names %s "%s" in the %s tone', (state, words, tone) => {
    expect(CALENDAR_SLOT_STATUS[state]).toEqual({ words, tone });
  });

  it.each(['idle', 'o365_guidance'] as const)('gives %s no pill — it renders no row', (state) => {
    expect(CALENDAR_SLOT_STATUS[state]).toBeNull();
  });
});
