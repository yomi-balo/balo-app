import { describe, it, expect } from 'vitest';
import { proficiencyToLevel, proficiencyToPct } from './proficiency';

describe('proficiencyToLevel', () => {
  it('maps 0 to None (muted)', () => {
    expect(proficiencyToLevel(0)).toMatchObject({ label: 'None', tone: 'muted' });
  });

  it('maps negative values to None (defensive)', () => {
    expect(proficiencyToLevel(-2).label).toBe('None');
  });

  it('maps 1–3 to Beginner (muted)', () => {
    expect(proficiencyToLevel(1).label).toBe('Beginner');
    expect(proficiencyToLevel(3)).toMatchObject({ label: 'Beginner', tone: 'muted' });
  });

  it('maps 4–6 to Intermediate (warning)', () => {
    expect(proficiencyToLevel(4)).toMatchObject({ label: 'Intermediate', tone: 'warning' });
    expect(proficiencyToLevel(6).label).toBe('Intermediate');
  });

  it('maps 7–8 to Advanced (primary)', () => {
    expect(proficiencyToLevel(7)).toMatchObject({ label: 'Advanced', tone: 'primary' });
    expect(proficiencyToLevel(8).label).toBe('Advanced');
  });

  it('maps 9–10 to Expert (success)', () => {
    expect(proficiencyToLevel(9)).toMatchObject({ label: 'Expert', tone: 'success' });
    expect(proficiencyToLevel(10).label).toBe('Expert');
  });

  it('returns a token-driven className for each level', () => {
    expect(proficiencyToLevel(0).className).toBe('text-muted-foreground');
    expect(proficiencyToLevel(5).className).toBe('text-warning');
    expect(proficiencyToLevel(8).className).toBe('text-primary');
    expect(proficiencyToLevel(10).className).toBe('text-success');
  });
});

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
