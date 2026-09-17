import { describe, it, expect } from 'vitest';
import {
  DASHBOARD_EVENTS,
  DASHBOARD_UP_NEXT_MEETING_TYPES,
  DASHBOARD_UP_NEXT_TARGETS,
  DASHBOARD_UP_NEXT_ROW_STATES,
} from './dashboard';

describe('DASHBOARD_EVENTS (BAL-566, client)', () => {
  it('exposes exactly the two dashboard events, sorted', () => {
    expect(Object.keys(DASHBOARD_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'UP_NEXT_CLICKED',
      'UP_NEXT_VIEWED',
    ]);
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(DASHBOARD_EVENTS.UP_NEXT_VIEWED).toBe('dashboard_up_next_viewed');
    expect(DASHBOARD_EVENTS.UP_NEXT_CLICKED).toBe('dashboard_up_next_clicked');
  });

  it('every value matches the dashboard_up_next_ event-name shape', () => {
    for (const value of Object.values(DASHBOARD_EVENTS)) {
      expect(value).toMatch(/^dashboard_up_next_[a-z]+$/);
    }
  });
});

describe('DASHBOARD_UP_NEXT_MEETING_TYPES', () => {
  it('is exactly the four listed context types, in display-tile order', () => {
    expect(DASHBOARD_UP_NEXT_MEETING_TYPES).toEqual([
      'case',
      'project_kickoff',
      'project_discovery',
      'request_interaction',
    ]);
  });
});

describe('DASHBOARD_UP_NEXT_TARGETS', () => {
  it('is exactly the six click targets', () => {
    expect(DASHBOARD_UP_NEXT_TARGETS).toEqual([
      'row',
      'join',
      'cases',
      'projects',
      'calendar',
      'find_expert',
    ]);
  });
});

describe('DASHBOARD_UP_NEXT_ROW_STATES', () => {
  it('is exactly the three row timing states', () => {
    expect(DASHBOARD_UP_NEXT_ROW_STATES).toEqual(['upcoming', 'starting_soon', 'happening_now']);
  });
});
