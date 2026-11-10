import { describe, it, expect } from 'vitest';
import { proficiencyToPct } from './proficiency';

describe('proficiencyToPct', () => {
  it('maps the 0–10 scale to 0–100', () => {
    expect(proficiencyToPct(0)).toBe(0);
    expect(proficiencyToPct(5)).toBe(50);
    expect(proficiencyToPct(10)).toBe(100);
  });

  it('clamps out-of-range values', () => {
    expect(proficiencyToPct(-3)).toBe(0);
    expect(proficiencyToPct(15)).toBe(100);
  });
});
