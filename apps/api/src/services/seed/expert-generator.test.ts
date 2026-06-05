import { describe, it, expect } from 'vitest';
import { generateExperts } from './expert-generator.js';
import { DEFAULT_SEED, MAX_RATE_CENTS } from './constants.js';
import type { GeneratedExpert, SeedTaxonomy } from './types.js';

const BASELINE = new Date('2026-05-31T00:00:00.000Z');

/** A taxonomy resembling the seeded one: core clouds first, then mid, then niche. */
function makeTaxonomy(): SeedTaxonomy {
  const skillNames = [
    // core (idx 0-3, weight 5)
    'Sales Cloud',
    'Service Cloud',
    'Platform',
    'Data Cloud',
    // mid (idx 4-8, weight 3)
    'Marketing Cloud',
    'Experience Cloud',
    'Commerce Cloud',
    'Tableau',
    'MuleSoft',
    // niche (idx 9+, weight 1)
    'Industries',
    'Net Zero Cloud',
    'Slack',
    'Agentforce',
  ];
  return {
    verticalId: 'vertical-sf',
    skills: skillNames.map((name, i) => ({ id: `skill-${i}`, name })),
    supportTypeIds: ['support-1', 'support-2', 'support-3', 'support-4'],
    languages: [
      { id: 'lang-en', name: 'English' },
      { id: 'lang-fr', name: 'French' },
      { id: 'lang-es', name: 'Spanish' },
      { id: 'lang-de', name: 'German' },
    ],
    industries: [
      { id: 'ind-fin', name: 'Financial Services' },
      { id: 'ind-health', name: 'Healthcare' },
      { id: 'ind-retail', name: 'Retail' },
    ],
    certificationIds: Array.from({ length: 8 }, (_, i) => `cert-${i}`),
  };
}

function gen(count: number, seed = DEFAULT_SEED): GeneratedExpert[] {
  return generateExperts({ count, seed, taxonomy: makeTaxonomy(), baselineNow: BASELINE });
}

describe('generateExperts — determinism', () => {
  it('produces deep-equal output for the same inputs', () => {
    expect(gen(60)).toEqual(gen(60));
  });

  it('keeps expert #34 attributes stable across runs', () => {
    const a = gen(60)[34]!;
    const b = gen(60)[34]!;
    expect({
      headline: a.headline,
      rateCents: a.rateCents,
      timezone: a.timezone,
      skillIds: a.skills.map((s) => s.skillId),
    }).toEqual({
      headline: b.headline,
      rateCents: b.rateCents,
      timezone: b.timezone,
      skillIds: b.skills.map((s) => s.skillId),
    });
  });

  it('keeps experts 0..59 identical between count=60 and count=150', () => {
    const small = gen(60);
    const large = gen(150);
    for (let i = 0; i < 60; i++) {
      expect(large[i]).toEqual(small[i]);
    }
  });

  it('changes output when the seed changes', () => {
    expect(gen(20, 1)).not.toEqual(gen(20, 2));
  });
});

describe('generateExperts — markers & identifiers', () => {
  it('uses recognizable seed markers for email and workosId', () => {
    const experts = gen(5, 999);
    expect(experts[0]!.email).toBe('expert0@seed.balo.dev');
    expect(experts[3]!.email).toBe('expert3@seed.balo.dev');
    expect(experts[0]!.workosId).toBe('seed_999_0');
    expect(experts[3]!.workosId).toBe('seed_999_3');
  });

  it('gives every expert a unique username (disambiguated by index)', () => {
    const experts = gen(60);
    const usernames = new Set(experts.map((e) => e.username));
    expect(usernames.size).toBe(60);
    for (const e of experts) {
      expect(e.username).toMatch(/-\d+$/);
    }
  });
});

describe('generateExperts — rate bands', () => {
  it('keeps every rate an integer within [120, 1300] and <= MAX_RATE_CENTS', () => {
    for (const e of gen(200)) {
      expect(Number.isInteger(e.rateCents)).toBe(true);
      expect(e.rateCents).toBeGreaterThanOrEqual(120);
      expect(e.rateCents).toBeLessThanOrEqual(1300);
      expect(e.rateCents).toBeLessThanOrEqual(MAX_RATE_CENTS);
    }
  });

  it('produces a typical-band majority over a large sample', () => {
    const experts = gen(300);
    const typical = experts.filter((e) => e.rateBand === 'typical').length;
    // typical weight is 80% — expect a clear majority.
    expect(typical / experts.length).toBeGreaterThan(0.6);
  });
});

describe('generateExperts — skills', () => {
  it('assigns 3–7 distinct (skill,supportType) pairs each', () => {
    for (const e of gen(120)) {
      expect(e.skills.length).toBeGreaterThanOrEqual(3);
      expect(e.skills.length).toBeLessThanOrEqual(7);
      const keys = new Set(e.skills.map((s) => `${s.skillId}:${s.supportTypeId}`));
      expect(keys.size).toBe(e.skills.length);
      for (const s of e.skills) {
        expect(s.proficiency).toBeGreaterThanOrEqual(1);
        expect(s.proficiency).toBeLessThanOrEqual(5);
      }
    }
  });

  it('selects core clouds more often than niche skills', () => {
    const experts = gen(300);
    const coreIds = new Set(['skill-0', 'skill-1', 'skill-2', 'skill-3']);
    const nicheIds = new Set(['skill-9', 'skill-10', 'skill-11', 'skill-12']);
    let core = 0;
    let niche = 0;
    for (const e of experts) {
      for (const s of e.skills) {
        if (coreIds.has(s.skillId)) core += 1;
        if (nicheIds.has(s.skillId)) niche += 1;
      }
    }
    expect(core).toBeGreaterThan(niche);
  });
});

describe('generateExperts — work history', () => {
  it('generates 2–4 rows with exactly one current open-ended role', () => {
    for (const e of gen(120)) {
      expect(e.workHistory.length).toBeGreaterThanOrEqual(2);
      expect(e.workHistory.length).toBeLessThanOrEqual(4);

      const current = e.workHistory.filter((w) => w.isCurrent);
      expect(current).toHaveLength(1);
      const [currentRole] = current;
      expect(currentRole?.endedAt).toBeNull();
      expect(currentRole?.sortOrder).toBe(0);
      expect(currentRole?.startedAt.getTime()).toBeLessThan(BASELINE.getTime());
    }
  });

  it('orders rows by sortOrder 0..n-1 with the current role first', () => {
    for (const e of gen(120)) {
      const orders = e.workHistory.map((w) => w.sortOrder);
      expect(orders).toEqual(Array.from({ length: e.workHistory.length }, (_, i) => i));
      expect(e.workHistory[0]?.isCurrent).toBe(true);
    }
  });

  it('keeps every closed span chronological and non-overlapping (newest → oldest)', () => {
    for (const e of gen(120)) {
      let previousStart: number | null = null;
      for (const [i, row] of e.workHistory.entries()) {
        expect(row.responsibilities.length).toBeGreaterThan(0);
        if (i === 0) {
          previousStart = row.startedAt.getTime();
          continue;
        }
        const { endedAt } = row;
        // Past row: started strictly before it ended.
        expect(endedAt).not.toBeNull();
        if (endedAt === null) continue;
        expect(row.startedAt.getTime()).toBeLessThan(endedAt.getTime());
        // Non-overlap: this (older) row ended on/before the previous row started.
        if (previousStart !== null) {
          expect(endedAt.getTime()).toBeLessThanOrEqual(previousStart);
        }
        previousStart = row.startedAt.getTime();
      }
    }
  });
});

describe('generateExperts — certifications', () => {
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

  it('links 3–8 distinct catalog certs with valid earned/expiry dates', () => {
    const catalog = new Set(makeTaxonomy().certificationIds);
    for (const e of gen(120)) {
      expect(e.certifications.length).toBeGreaterThanOrEqual(3);
      expect(e.certifications.length).toBeLessThanOrEqual(8);

      const ids = e.certifications.map((c) => c.certificationId);
      expect(new Set(ids).size).toBe(ids.length); // distinct (unique index safe)
      for (const c of e.certifications) {
        expect(catalog.has(c.certificationId)).toBe(true);
        expect(c.earnedAt).toMatch(ISO_DATE);
        // earned in the past, on/before baseline.
        expect(c.earnedAt <= BASELINE.toISOString().slice(0, 10)).toBe(true);
        if (c.expiresAt !== null) {
          expect(c.expiresAt).toMatch(ISO_DATE);
          expect(c.expiresAt > BASELINE.toISOString().slice(0, 10)).toBe(true);
        }
      }
    }
  });

  it('varies the cert count across the population', () => {
    const counts = new Set(gen(300).map((e) => e.certifications.length));
    expect(counts.size).toBeGreaterThan(1);
  });

  it('treats an empty cert catalog as non-fatal (no throw, empty links)', () => {
    const experts = generateExperts({
      count: 20,
      seed: DEFAULT_SEED,
      taxonomy: { ...makeTaxonomy(), certificationIds: [] },
      baselineNow: BASELINE,
    });
    for (const e of experts) {
      expect(e.certifications).toEqual([]);
    }
  });
});

describe('generateExperts — search readiness & languages', () => {
  it('always includes English as the native language', () => {
    for (const e of gen(40)) {
      const english = e.languages.find((l) => l.languageId === 'lang-en');
      expect(english).toBeDefined();
      expect(english!.proficiency).toBe('native');
    }
  });

  it('produces a non-null approved offset and valid experience year', () => {
    for (const e of gen(40)) {
      expect(e.approvedOffsetMs).toBeGreaterThan(0);
      expect(e.yearStartedSalesforce).toBeGreaterThanOrEqual(2026 - 18);
      expect(e.yearStartedSalesforce).toBeLessThanOrEqual(2026 - 1);
    }
  });

  it('renders headlines with no leftover placeholders', () => {
    for (const e of gen(40)) {
      expect(e.headline).not.toMatch(/\{[a-z]+\}/);
      expect(e.headline.length).toBeGreaterThan(0);
    }
  });
});

describe('generateExperts — taxonomy guard', () => {
  it('throws loudly when there are no skills', () => {
    expect(() =>
      generateExperts({
        count: 5,
        seed: DEFAULT_SEED,
        taxonomy: { ...makeTaxonomy(), skills: [] },
        baselineNow: BASELINE,
      })
    ).toThrow(/no skills/i);
  });

  it('throws loudly when there are no support types', () => {
    expect(() =>
      generateExperts({
        count: 5,
        seed: DEFAULT_SEED,
        taxonomy: { ...makeTaxonomy(), supportTypeIds: [] },
        baselineNow: BASELINE,
      })
    ).toThrow(/no support types/i);
  });
});
