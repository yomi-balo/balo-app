import { describe, it, expect } from 'vitest';
import { ENGAGEMENT_TYPE_INDICATOR } from './engagement-type-indicator';

describe('ENGAGEMENT_TYPE_INDICATOR', () => {
  it('is total over all six holder-bearing context labels', () => {
    // ⚠ Explicit comparators on both sides (SonarCloud S2871 — a comparator-less `.sort()` is a
    // reliability bug by rule, even where the default happens to be correct). BAL-498 R5, B1.
    const byCodePoint = (a: string, b: string): number => a.localeCompare(b);
    const keys = Object.keys(ENGAGEMENT_TYPE_INDICATOR).sort(byCodePoint);
    expect(keys).toEqual(
      [
        'case',
        'package_session',
        'project_discovery',
        'project_kickoff',
        'request_interaction',
        'retainer_checkin',
      ].sort(byCodePoint)
    );
  });

  it('every entry has an icon, a border class, and a non-empty label', () => {
    for (const [key, entry] of Object.entries(ENGAGEMENT_TYPE_INDICATOR)) {
      expect(entry.icon, `${key} missing icon`).toBeDefined();
      expect(entry.borderClass, `${key} missing borderClass`).toMatch(/^border-l-/);
      expect(entry.label.length, `${key} missing label`).toBeGreaterThan(0);
    }
  });

  it('falls back to the neutral Calendar treatment for retainer_checkin (unreachable-today label)', () => {
    expect(ENGAGEMENT_TYPE_INDICATOR.retainer_checkin.borderClass).toBe(
      'border-l-muted-foreground'
    );
    expect(ENGAGEMENT_TYPE_INDICATOR.retainer_checkin.label).toBe('Meeting');
  });

  it('groups the three request/discovery-flavoured labels under the same violet accent', () => {
    expect(ENGAGEMENT_TYPE_INDICATOR.project_kickoff.borderClass).toBe('border-l-violet');
    expect(ENGAGEMENT_TYPE_INDICATOR.project_discovery.borderClass).toBe('border-l-violet');
    expect(ENGAGEMENT_TYPE_INDICATOR.request_interaction.borderClass).toBe('border-l-violet');
  });

  it('every borderClass is a semantic token, never a raw Tailwind palette scale', () => {
    for (const [key, entry] of Object.entries(ENGAGEMENT_TYPE_INDICATOR)) {
      // No regex, deliberately (SonarCloud S5852 / the repo's invariant convention): a raw scale
      // ends in a number — `border-l-violet-500`. A semantic token never does.
      const lastSegment = entry.borderClass.split('-').at(-1) ?? '';
      expect(Number.isNaN(Number(lastSegment)), `${key}: ${entry.borderClass}`).toBe(true);
      // ⚠ THE SCALE CHECK ALONE MISSES AN ARBITRARY-VALUE HEX. `border-l-[#7c3aed]` has last
      // segment `[#7c3aed]`, so `Number(…)` is NaN and the assertion above passes — while the AC
      // says "no raw hex OR palette literals". Cheap second guard, still no regex.
      expect(entry.borderClass.includes('#'), `${key}: ${entry.borderClass}`).toBe(false);
    }
  });
});
