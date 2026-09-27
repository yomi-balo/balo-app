import { describe, expect, it } from 'vitest';
import { PROJECT_NUDGE_THRESHOLD, projectScore, seedFromHeroQuery } from './project-intent';

/**
 * BAL-582 §2 — a table-driven fixture pinning `projectScore` against the V1.5 ref's own
 * `INTENT_SIGNALS` behaviour (`marketing-home.jsx:235-251`), the ticket's negative example, the
 * production `copy.ts` phrases, and the regex edges the pre-flight identified.
 *
 * ⚠ Rows are labelled by EXPECTED SCORE (and nudge boolean) AT A STATED `productCount` —
 * deliberately NEVER by which mode a phrase happens to live in. Several of `copy.ts`'s own
 * CONSULTATION phrases score at or above the nudge threshold (`untangle a MuleSoft integration`
 * nudges via `integrat\w*`) — labelling by source mode would make those rows look wrong and
 * invite "fixing" the ported scorer, which must never be retuned (see the module docblock).
 *
 * `nudges` is taken directly from the plan's own ✓/✗ labels (plan §Tests), not derived from
 * `score` at test time — so a row's expectation comes from the spec, not from the code under test.
 */
interface ScoreRow {
  query: string;
  productCount: number;
  score: number;
  nudges: boolean;
}

const ROWS: readonly ScoreRow[] = [
  // Ref consultation phrases (marketing-home.jsx:213-220), at productCount 0.
  {
    query: 'Our lead assignment Flow fails on every update…',
    productCount: 0,
    score: -3,
    nudges: false,
  },
  {
    query: 'Need CPQ quote templates fixed before Friday…',
    productCount: 0,
    score: 0,
    nudges: false,
  },
  { query: 'Planning our first Data Cloud rollout…', productCount: 0, score: 3, nudges: true },
  {
    query: 'Set up an Agentforce pilot for the support team…',
    productCount: 0,
    score: 0,
    nudges: false,
  },
  { query: 'Marketing Cloud journeys stopped sending…', productCount: 0, score: 0, nudges: false },
  { query: 'Migrating from Classic to Lightning…', productCount: 0, score: 3, nudges: true },
  // Ref project phrases (marketing-home.jsx:222-228), at productCount 0.
  { query: 'Migrate us from HubSpot to Sales Cloud…', productCount: 0, score: 3, nudges: true },
  { query: 'Implement CPQ across two business units…', productCount: 0, score: 5, nudges: true },
  { query: 'Roll out Agentforce for our support team…', productCount: 0, score: 3, nudges: true },
  { query: 'Rebuild quote-to-cash in Revenue Cloud…', productCount: 0, score: 3, nudges: true },
  { query: 'Stand up Data Cloud for marketing…', productCount: 0, score: 3, nudges: true },
  // Ticket negative example.
  { query: 'Our lead assignment Flow fails on update', productCount: 0, score: -3, nudges: false },
  { query: 'Our lead assignment Flow fails on update', productCount: 2, score: -2, nudges: false },
  // Production `copy.ts` phrases.
  { query: 'fix a broken Flow before lunch', productCount: 0, score: -3, nudges: false },
  { query: 'set up Data Cloud the right way', productCount: 0, score: 0, nudges: false },
  {
    query: 'get a second opinion on an Agentforce build',
    productCount: 0,
    score: 0,
    nudges: false,
  },
  { query: 'untangle a MuleSoft integration', productCount: 0, score: 3, nudges: true },
  { query: 'review your org before go-live', productCount: 0, score: 2, nudges: false },
  { query: 'review your org before go-live', productCount: 2, score: 3, nudges: true },
  // Length gate: under 18 trimmed characters scores 0 outright.
  { query: 'implement CPQ now', productCount: 0, score: 0, nudges: false }, // 17 chars
  { query: 'migrate everything', productCount: 0, score: 3, nudges: true }, // 18 chars
  { query: '   migrate everything now please   ', productCount: 0, score: 3, nudges: true },
  // Regex edges.
  { query: 'deploy fails with an error', productCount: 0, score: 0, nudges: false },
  { query: 'Debugging a failing Apex trigger', productCount: 0, score: 0, nudges: false },
  { query: 'Lightning pages broke after the update', productCount: 0, score: 0, nudges: false },
  {
    query: 'build a new customer portal on Experience Cloud',
    productCount: 0,
    score: 0,
    nudges: false,
  },
  { query: 'Planning a roll-out of Field Service', productCount: 0, score: 3, nudges: true },
  { query: 'Planning a roll out of Field Service', productCount: 0, score: 3, nudges: true },
  { query: 'why does my report not load', productCount: 0, score: -3, nudges: false },
  { query: 'how do I add a custom field', productCount: 0, score: -3, nudges: false },
  { query: 'Phase two of our Marketing Cloud program', productCount: 0, score: 2, nudges: false },
  { query: 'Need an admin for a few weeks', productCount: 0, score: 2, nudges: false },
  {
    query: 'migrations of legacy data are stuck with an error',
    productCount: 0,
    score: 0,
    nudges: false,
  },
  // Stacking, products and length.
  { query: 'help with Service Cloud setup', productCount: 2, score: 1, nudges: false },
  { query: 'need an integration with NetSuite', productCount: 2, score: 4, nudges: true },
  { query: 'Sales Cloud rollout across all teams by Q3', productCount: 0, score: 7, nudges: true },
  {
    query: 'org-wide Agentforce deployment, go-live in six weeks',
    productCount: 2,
    score: 8,
    nudges: true,
  },
  {
    query: 'We need a second pair of eyes on our Sales Cloud permission sets and sharing rules',
    productCount: 0,
    score: 1,
    nudges: false,
  },
  {
    query: 'We need a second pair of eyes on our Sales Cloud permission sets and sharing rules',
    productCount: 2,
    score: 2,
    nudges: false,
  },
  {
    query: 'We have a hard deadline for our CPQ go-live across business units',
    productCount: 0,
    score: 5,
    nudges: true,
  },
];

describe('projectScore', () => {
  it('has at least 30 labelled fixture rows', () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(30);
  });

  it.each(ROWS)(
    'scores $score for "$query" at productCount $productCount',
    ({ query, productCount, score }) => {
      expect(projectScore(query, productCount)).toBe(score);
    }
  );

  it.each(ROWS)(
    'nudges $nudges for "$query" at productCount $productCount',
    ({ query, productCount, nudges }) => {
      expect(projectScore(query, productCount) >= PROJECT_NUDGE_THRESHOLD).toBe(nudges);
    }
  );

  it('is pure — repeated calls with the same input return the same score (pins no `/g` flag)', () => {
    const query = 'Implement CPQ across two business units…';
    const first = projectScore(query, 0);
    const second = projectScore(query, 0);
    const third = projectScore(query, 0);
    expect(first).toBe(5);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });
});

describe('seedFromHeroQuery', () => {
  it('returns no seed for an empty query and no products', () => {
    expect(seedFromHeroQuery('', [])).toEqual({ seed: undefined, seededInto: 'none' });
  });

  it('returns no seed for a whitespace-only query and no products', () => {
    expect(seedFromHeroQuery('   ', [])).toEqual({ seed: undefined, seededInto: 'none' });
  });

  it('seeds a title at exactly 120 trimmed characters', () => {
    const query = 'a'.repeat(120);
    const { seed, seededInto } = seedFromHeroQuery(query, []);
    expect(seededInto).toBe('title');
    expect(seed).toEqual({ title: query });
  });

  it('seeds a description at 121 trimmed characters', () => {
    const query = 'a'.repeat(121);
    const { seed, seededInto } = seedFromHeroQuery(query, []);
    expect(seededInto).toBe('description');
    expect(seed).toEqual({ descriptionText: query });
  });

  it('measures the 120-char cutoff against the TRIMMED length, not the raw length', () => {
    const trimmed = 'a'.repeat(120);
    const padded = `  ${trimmed}  `;
    const { seed, seededInto } = seedFromHeroQuery(padded, []);
    expect(seededInto).toBe('title');
    expect(seed).toEqual({ title: trimmed });
  });

  it('a padded query over 120 trimmed characters still becomes a description', () => {
    const trimmed = 'a'.repeat(125);
    const padded = `  ${trimmed}  `;
    const { seed, seededInto } = seedFromHeroQuery(padded, []);
    expect(seededInto).toBe('description');
    expect(seed).toEqual({ descriptionText: trimmed });
  });

  it('an empty query with selected products seeds only productIds, seededInto stays none', () => {
    const { seed, seededInto } = seedFromHeroQuery('', ['prod-1', 'prod-2']);
    expect(seededInto).toBe('none');
    expect(seed).toEqual({ productIds: ['prod-1', 'prod-2'] });
  });

  it('omits productIds entirely when no products are selected', () => {
    const { seed } = seedFromHeroQuery('migrate everything', []);
    expect(seed).toEqual({ title: 'migrate everything' });
    expect(seed).not.toHaveProperty('productIds');
  });

  it('combines a title seed with selected products', () => {
    const { seed, seededInto } = seedFromHeroQuery('migrate everything', ['prod-1']);
    expect(seededInto).toBe('title');
    expect(seed).toEqual({ title: 'migrate everything', productIds: ['prod-1'] });
  });
});
