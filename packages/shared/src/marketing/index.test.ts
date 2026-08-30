import { describe, it, expect } from 'vitest';
import { FEATURED_EXPERT_USERNAMES, FEATURED_EXPERT_LIMIT } from './index';

describe('FEATURED_EXPERT_USERNAMES', () => {
  it('ships empty — the shipped default per D2 (no deterministic fallback)', () => {
    expect(FEATURED_EXPERT_USERNAMES).toEqual([]);
  });

  it('never exceeds FEATURED_EXPERT_LIMIT', () => {
    expect(FEATURED_EXPERT_USERNAMES.length).toBeLessThanOrEqual(FEATURED_EXPERT_LIMIT);
  });

  it('has no duplicate entries', () => {
    const unique = new Set(FEATURED_EXPERT_USERNAMES);
    expect(unique.size).toBe(FEATURED_EXPERT_USERNAMES.length);
  });

  it('every entry is a non-empty, lowercase, whitespace-free slug', () => {
    for (const username of FEATURED_EXPERT_USERNAMES) {
      expect(username.length).toBeGreaterThan(0);
      expect(username).toBe(username.toLowerCase());
      expect(username).toBe(username.trim());
    }
  });
});

describe('FEATURED_EXPERT_LIMIT', () => {
  it('is 3', () => {
    expect(FEATURED_EXPERT_LIMIT).toBe(3);
  });
});
