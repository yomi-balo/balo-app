import { describe, it, expect } from 'vitest';
import {
  COMMAND_PALETTE_EVENTS,
  COMMAND_PALETTE_OPEN_METHODS,
  COMMAND_PALETTE_ACTION_TYPES,
} from './command-palette';

describe('COMMAND_PALETTE_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(COMMAND_PALETTE_EVENTS)).toEqual(['OPENED', 'ACTION']);
  });

  it('maps each constant to its exact snake_case value', () => {
    expect(COMMAND_PALETTE_EVENTS.OPENED).toBe('command_palette_opened');
    expect(COMMAND_PALETTE_EVENTS.ACTION).toBe('command_palette_action');
  });

  it('values follow the command_palette_ prefix convention', () => {
    for (const value of Object.values(COMMAND_PALETTE_EVENTS)) {
      expect(value).toMatch(/^command_palette_[a-z]+(_[a-z]+)*$/);
    }
  });
});

describe('COMMAND_PALETTE_OPEN_METHODS', () => {
  it('is the exact pinned tuple, in order', () => {
    expect(COMMAND_PALETTE_OPEN_METHODS).toEqual(['shortcut', 'click']);
  });
});

describe('COMMAND_PALETTE_ACTION_TYPES', () => {
  it("is exactly ['switch_workspace'] — 'navigate' is measured by nav_item_clicked", () => {
    expect(COMMAND_PALETTE_ACTION_TYPES).toEqual(['switch_workspace']);
  });
});
