import { describe, it, expect } from 'vitest';
import { EXPERT_CALENDAR_SETTINGS_PATH } from './settings-path';

describe('EXPERT_CALENDAR_SETTINGS_PATH (BAL-397 §13.1)', () => {
  it('points at the Schedule tab, not a dead ?tab=calendar', () => {
    expect(EXPERT_CALENDAR_SETTINGS_PATH).toBe('/expert/settings?tab=schedule');
  });

  it('is query-shaped so callers can append &calendar_* params', () => {
    expect(EXPERT_CALENDAR_SETTINGS_PATH).toContain('?');
    expect(EXPERT_CALENDAR_SETTINGS_PATH).not.toContain('#');
  });
});
