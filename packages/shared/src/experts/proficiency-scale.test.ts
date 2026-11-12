import { describe, it, expect } from 'vitest';
import {
  PROFICIENCY_SCALE,
  SEARCH_MIN_PROFICIENCY,
  proficiencyScaleLevel,
} from './proficiency-scale';

describe('SEARCH_MIN_PROFICIENCY', () => {
  it('is 7, the Advanced level', () => {
    expect(SEARCH_MIN_PROFICIENCY).toBe(7);
    expect(proficiencyScaleLevel(SEARCH_MIN_PROFICIENCY).title).toBe('Advanced');
  });
});

describe('PROFICIENCY_SCALE', () => {
  it('has eleven entries whose value matches the index', () => {
    expect(PROFICIENCY_SCALE).toHaveLength(11);
    PROFICIENCY_SCALE.forEach((level, index) => expect(level.value).toBe(index));
  });

  it('has unique, non-empty titles and descriptions', () => {
    const titles = PROFICIENCY_SCALE.map((l) => l.title);
    expect(new Set(titles).size).toBe(11);
    for (const level of PROFICIENCY_SCALE) {
      expect(level.title.trim()).not.toBe('');
      expect(level.description.trim()).not.toBe('');
    }
  });

  it('pins the ticket copy at 0, 7 and 10', () => {
    expect(PROFICIENCY_SCALE[0]).toEqual({
      value: 0,
      title: 'No experience',
      description: "You haven't worked with this.",
    });
    expect(PROFICIENCY_SCALE[7]).toEqual({
      value: 7,
      title: 'Advanced',
      description:
        'You handle complex work on your own, and teammates come to you for help with it.',
    });
    expect(PROFICIENCY_SCALE[10]).toEqual({
      value: 10,
      title: 'Master',
      description:
        "You're recognised beyond your own clients and employer, for example through talks, published work or Salesforce recognition.",
    });
  });
});

describe('proficiencyScaleLevel', () => {
  it('returns the level for an in-range value', () => {
    expect(proficiencyScaleLevel(8).title).toBe('Highly experienced');
  });

  it('clamps out-of-range values', () => {
    expect(proficiencyScaleLevel(-2).value).toBe(0);
    expect(proficiencyScaleLevel(15).value).toBe(10);
  });

  it('rounds fractional values', () => {
    expect(proficiencyScaleLevel(6.4).value).toBe(6);
    expect(proficiencyScaleLevel(6.6).value).toBe(7);
  });
});
