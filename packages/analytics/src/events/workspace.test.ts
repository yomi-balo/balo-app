import { describe, it, expect } from 'vitest';
import { WORKSPACE_SERVER_EVENTS, WORKSPACE_EVENTS } from './workspace';

describe('WORKSPACE_SERVER_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(WORKSPACE_SERVER_EVENTS)).toEqual(['SWITCHED']);
  });

  it('maps each constant to its snake_case event name', () => {
    expect(WORKSPACE_SERVER_EVENTS.SWITCHED).toBe('workspace_switched');
  });

  it('values follow the snake_case naming convention', () => {
    for (const value of Object.values(WORKSPACE_SERVER_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});

describe('WORKSPACE_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(WORKSPACE_EVENTS)).toEqual(['SWITCHER_OPENED']);
  });

  it('maps each constant to its snake_case event name', () => {
    expect(WORKSPACE_EVENTS.SWITCHER_OPENED).toBe('workspace_switcher_opened');
  });

  it('values follow the snake_case naming convention', () => {
    for (const value of Object.values(WORKSPACE_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});
