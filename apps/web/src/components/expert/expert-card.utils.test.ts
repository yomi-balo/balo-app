// Day/weekday/time formatting in computeAvailability uses Intl on LOCAL date
// parts. The table fixtures below are authored in UTC, so this suite MUST run
// under TZ=UTC for the same-day / tomorrow boundaries to line up. Run via:
//   TZ=UTC pnpm exec vitest run src/components/expert/expert-card.utils.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildExpertise,
  computeAvailability,
  getCountryDisplay,
  type ExpertiseSkillInput,
} from './expert-card.utils';

// Fixed reference point for the whole availability suite: Tuesday 2026-06-02 09:00 UTC.
const NOW = new Date('2026-06-02T09:00:00Z');

describe('computeAvailability', () => {
  it('row 1: null input short-circuits to "No availability" / none', () => {
    const result = computeAvailability(null, NOW);
    expect(result.tone).toBe('none');
    expect(result.text).toBe('No availability');
  });

  it('returns "No availability" / none for an unparseable timestamp (NaN guard)', () => {
    const result = computeAvailability('not-a-date', NOW);
    expect(result.tone).toBe('none');
    expect(result.text).toBe('No availability');
  });

  it('row 2: a past slot (−1h) is treated as "Available now" / live', () => {
    const result = computeAvailability('2026-06-02T08:00:00Z', NOW);
    expect(result.tone).toBe('live');
    expect(result.text).toBe('Available now');
  });

  it('row 3: +5m (inside the 15m live window) → "Available now" / live', () => {
    const result = computeAvailability('2026-06-02T09:05:00Z', NOW);
    expect(result.tone).toBe('live');
    expect(result.text).toBe('Available now');
  });

  it('row 4: +14m (just under the 15m edge) → "Available now" / live', () => {
    const result = computeAvailability('2026-06-02T09:14:00Z', NOW);
    expect(result.tone).toBe('live');
    expect(result.text).toBe('Available now');
  });

  it('exactly +15m (the live boundary, diffMin <= 15) → "Available now" / live', () => {
    const result = computeAvailability('2026-06-02T09:15:00Z', NOW);
    expect(result.tone).toBe('live');
    expect(result.text).toBe('Available now');
  });

  it('+20m (over 15m, rounds to 0h but floor pins it) → "Free in ~1h" / soon (Math.max(1, 0))', () => {
    const result = computeAvailability('2026-06-02T09:20:00Z', NOW);
    expect(result.tone).toBe('soon');
    expect(result.text).toBe('Free in ~1h');
  });

  it('row 5: +30m (over 15m, same day) → "Free in ~1h" / soon (rounds to 1)', () => {
    const result = computeAvailability('2026-06-02T09:30:00Z', NOW);
    expect(result.tone).toBe('soon');
    expect(result.text).toBe('Free in ~1h');
  });

  it('row 6: +2h (mid same-day) → "Free in ~2h" / soon', () => {
    const result = computeAvailability('2026-06-02T11:00:00Z', NOW);
    expect(result.tone).toBe('soon');
    expect(result.text).toBe('Free in ~2h');
  });

  it('row 7: +5h30 (under the 6h edge) → "Free in ~6h" / soon (rounds to 6)', () => {
    const result = computeAvailability('2026-06-02T14:30:00Z', NOW);
    expect(result.tone).toBe('soon');
    expect(result.text).toBe('Free in ~6h');
  });

  it('row 8: +6h (the 6h edge, diffMin >= 360) → "Available today" / soon', () => {
    const result = computeAvailability('2026-06-02T15:00:00Z', NOW);
    expect(result.tone).toBe('soon');
    expect(result.text).toBe('Available today');
  });

  it('row 9: +12h same day → "Available today" / soon', () => {
    const result = computeAvailability('2026-06-02T21:00:00Z', NOW);
    expect(result.tone).toBe('soon');
    expect(result.text).toBe('Available today');
  });

  it('row 10: +1d (next local day) → "Next: tomorrow <time>" / later', () => {
    const result = computeAvailability('2026-06-03T09:00:00Z', NOW);
    expect(result.tone).toBe('later');
    expect(result.text).toMatch(/^Next: tomorrow \d/);
  });

  it('row 11: +3d (Friday) → "Next: Fri <time>" / later', () => {
    const result = computeAvailability('2026-06-05T14:00:00Z', NOW);
    expect(result.tone).toBe('later');
    expect(result.text).toMatch(/^Next: Fri /);
  });
});

describe('getCountryDisplay', () => {
  it('maps an uppercase ISO code to name + flag', () => {
    expect(getCountryDisplay('AU')).toEqual({ name: 'Australia', flag: '🇦🇺' });
  });

  it('is case-insensitive (lowercase "au" resolves the same)', () => {
    expect(getCountryDisplay('au')).toEqual({ name: 'Australia', flag: '🇦🇺' });
  });

  it('returns null for an unknown code', () => {
    expect(getCountryDisplay('ZZ')).toBeNull();
  });

  it('returns null for a null code', () => {
    expect(getCountryDisplay(null)).toBeNull();
  });
});

describe('buildExpertise', () => {
  const skill = (over: Partial<ExpertiseSkillInput> = {}): ExpertiseSkillInput => ({
    productId: 'sales-cloud',
    proficiency: 3,
    skill: { name: 'Sales Cloud' },
    supportType: { slug: 'technical-fix-support' },
    ...over,
  });

  it('returns an empty array for no skills', () => {
    expect(buildExpertise([])).toEqual([]);
  });

  it('groups multiple support types under one product (insertion order)', () => {
    const result = buildExpertise([
      skill({ supportType: { slug: 'technical-fix-support' } }),
      skill({ supportType: { slug: 'architecture-integrations' } }),
    ]);
    expect(result).toEqual([{ product: 'Sales Cloud', skills: ['technical', 'architecture'] }]);
  });

  it('keeps distinct products in first-seen order', () => {
    const result = buildExpertise([
      skill({ productId: 'service', skill: { name: 'Service Cloud' } }),
      skill({ productId: 'sales', skill: { name: 'Sales Cloud' } }),
    ]);
    expect(result.map((e) => e.product)).toEqual(['Service Cloud', 'Sales Cloud']);
  });

  it('maps every support-type slug to its SkillType', () => {
    const result = buildExpertise([
      skill({ supportType: { slug: 'technical-fix-support' } }),
      skill({ supportType: { slug: 'architecture-integrations' } }),
      skill({ supportType: { slug: 'strategy-best-practices' } }),
      skill({ supportType: { slug: 'platform-training' } }),
    ]);
    expect(result[0]!.skills).toEqual(['technical', 'architecture', 'strategy', 'admin']);
  });

  it('dedupes a repeated SkillType within a product', () => {
    const result = buildExpertise([
      skill({ supportType: { slug: 'technical-fix-support' } }),
      skill({ supportType: { slug: 'technical-fix-support' } }),
    ]);
    expect(result).toEqual([{ product: 'Sales Cloud', skills: ['technical'] }]);
  });

  it('skips skills with proficiency <= 0', () => {
    const result = buildExpertise([
      skill({ proficiency: 0 }),
      skill({ productId: 'service', skill: { name: 'Service Cloud' }, proficiency: 2 }),
    ]);
    expect(result).toEqual([{ product: 'Service Cloud', skills: ['technical'] }]);
  });

  it('ignores an unknown support-type slug (still emits the product)', () => {
    const result = buildExpertise([skill({ supportType: { slug: 'mystery-slug' } })]);
    expect(result).toEqual([{ product: 'Sales Cloud', skills: [] }]);
  });
});
