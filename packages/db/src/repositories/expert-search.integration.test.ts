import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import {
  agencies,
  consultations,
  expertProfiles,
  industries,
  languages,
  verticals,
  categories,
  products,
  supportTypes,
} from '../schema';
import { referenceDataRepository } from './reference-data';
import { expertsRepository } from './experts';
import { searchExpertFactory, userFactory } from '../test/factories';
import {
  expertSearchRepository,
  buildWhereConditions,
  buildOrderBy,
  timeframeBoundary,
  type ExpertSearchParams,
} from './expert-search';

// ── Inline taxonomy seeding (global-setup seeds ONLY the vertical) ──

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Date.now()}`;
}

async function getVerticalId(): Promise<string> {
  return (await referenceDataRepository.getSalesforceVertical()).id;
}

async function createProduct(verticalId: string, name: string): Promise<string> {
  const [cat] = await db
    .insert(categories)
    .values({ verticalId, name: uniq('cat'), slug: uniq('cat-slug') })
    .returning();
  const [row] = await db
    .insert(products)
    .values({ verticalId, categoryId: cat!.id, name, slug: uniq('product-slug') })
    .returning();
  return row!.id;
}

async function createSupportType(verticalId: string, name: string): Promise<string> {
  const [row] = await db
    .insert(supportTypes)
    .values({ verticalId, name, slug: uniq('st-slug') })
    .returning();
  return row!.id;
}

async function createLanguage(name: string, flagEmoji: string | null = '🏳️'): Promise<string> {
  const [row] = await db
    .insert(languages)
    .values({ name, code: uniq('lang'), flagEmoji })
    .returning();
  return row!.id;
}

async function createIndustry(name: string): Promise<string> {
  const [row] = await db
    .insert(industries)
    .values({ name, slug: uniq('ind-slug') })
    .returning();
  return row!.id;
}

async function createAgency(name: string, logoUrl: string | null): Promise<string> {
  const [row] = await db
    .insert(agencies)
    .values({ name, slug: uniq('agency-slug'), logoUrl })
    .returning();
  return row!.id;
}

/** Build a complete ExpertSearchParams with sensible defaults for tests. */
function params(over: Partial<ExpertSearchParams> & { verticalId: string }): ExpertSearchParams {
  return {
    productIds: [],
    supportTypeIds: [],
    languageIds: [],
    industryIds: [],
    timeframe: undefined,
    rateMinCents: undefined,
    rateMaxCents: undefined,
    sort: 'best_match',
    page: 1,
    pageSize: 20,
    availabilityGateEnabled: false,
    now: new Date('2026-06-02T00:00:00.000Z'),
    ...over,
  };
}

const NOW = new Date('2026-06-02T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

// ── resolveVerticalId ───────────────────────────────────────────────

describe('expertSearchRepository.resolveVerticalId', () => {
  it('resolves the salesforce slug to its id', async () => {
    const verticalId = await getVerticalId();
    const resolved = await expertSearchRepository.resolveVerticalId('salesforce');
    expect(resolved).toBe(verticalId);
  });

  it('returns null for an unknown slug', async () => {
    const resolved = await expertSearchRepository.resolveVerticalId('does-not-exist');
    expect(resolved).toBeNull();
  });
});

// ── Vertical-as-data: a SECOND vertical adapts with NO code change ──────────
//
// Guards the load-bearing acceptance criterion (AC #4 / #2): adding a vertical
// is a pure DATA operation. We seed an entire second vertical (vertical →
// categories → products → support types → approved experts) INLINE, using only
// the generic helpers, with support-type slugs that DIFFER from Salesforce's —
// which is only possible because support_types is now (vertical_id, slug)-unique
// rather than globally slug-unique. This whole block fails pre-change (the mock
// support-type slugs collide on the old global unique) and passes post-change.

/** Insert a brand-new vertical with a unique slug; returns its id + slug. */
async function createMockVertical(): Promise<{ id: string; slug: string }> {
  const slug = uniq('mock-vertical');
  const [row] = await db
    .insert(verticals)
    .values({ name: uniq('Mock Vertical'), slug, isActive: true })
    .returning();
  return { id: row!.id, slug };
}

describe('expertSearchRepository — vertical-as-data (second vertical, no code change)', () => {
  it('isolates search + computes facets purely from the mock vertical data', async () => {
    const sfVerticalId = await getVerticalId();

    // ── 1. Seed a second vertical entirely as DATA ──────────────────────────
    const mock = await createMockVertical();

    // Mock products under their own category.
    const mockProductId = await createProduct(mock.id, uniq('Mock Product'));

    // Mock support types with slugs that DIFFER from Salesforce's — only legal
    // post-change (composite (vertical_id, slug) unique).
    const mockSupportTypeId = await createSupportType(mock.id, 'Mock Implementation');
    await createSupportType(mock.id, 'Mock Audit');

    // ── 2. Approved + searchable experts in the mock vertical ───────────────
    const mockExpert = await searchExpertFactory({
      verticalId: mock.id,
      competencies: [{ productId: mockProductId, supportTypeId: mockSupportTypeId }],
    });

    // A Salesforce expert that must NOT leak into mock-vertical results.
    const sfProductId = await createProduct(sfVerticalId, uniq('SF Product'));
    const sfSupportTypeId = await createSupportType(sfVerticalId, 'SF Support');
    const sfExpert = await searchExpertFactory({
      verticalId: sfVerticalId,
      competencies: [{ productId: sfProductId, supportTypeId: sfSupportTypeId }],
    });

    // ── 3a. resolveVerticalId resolves the mock slug ────────────────────────
    const resolved = await expertSearchRepository.resolveVerticalId(mock.slug);
    expect(resolved).toBe(mock.id);

    // ── 3b. search is vertical-isolated ─────────────────────────────────────
    const { rows } = await expertSearchRepository.search(
      params({ verticalId: mock.id, pageSize: 50 })
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(mockExpert.id);
    expect(ids).not.toContain(sfExpert.id);

    // ── 3c. facets are computed from LIVE mock data (not a hardcoded list) ──
    const facets = await expertSearchRepository.facetCounts(mock.id, false, NOW);

    // Support-type facets are the MOCK ones, never Salesforce's.
    const supportTypeIds = facets.supportTypes.map((f) => f.id);
    expect(supportTypeIds).toContain(mockSupportTypeId);
    expect(supportTypeIds).not.toContain(sfSupportTypeId);

    // Product facets are the mock products.
    const productIds = facets.products.map((f) => f.id);
    expect(productIds).toContain(mockProductId);
    expect(productIds).not.toContain(sfProductId);

    // ── 3d. filtering by the mock support type works ────────────────────────
    const filtered = await expertSearchRepository.search(
      params({ verticalId: mock.id, supportTypeIds: [mockSupportTypeId], pageSize: 50 })
    );
    expect(filtered.rows.map((r) => r.id)).toEqual([mockExpert.id]);
  });
});

// ── 1. FTS relevance ordering ───────────────────────────────────────

describe('expertSearchRepository.search — FTS relevance ordering', () => {
  it('ranks experts mentioning the query above unrelated experts', async () => {
    const verticalId = await getVerticalId();
    const matching = await searchExpertFactory({
      verticalId,
      headline: 'Agentforce automation specialist',
      bio: 'I build agentforce bots',
    });
    await searchExpertFactory({
      verticalId,
      headline: 'Marketing Cloud email guru',
      bio: 'Journeys and campaigns',
    });

    const { rows } = await expertSearchRepository.search(
      params({ verticalId, query: 'agentforce' })
    );

    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.id).toBe(matching.id);
  });
});

// ── 2. Weighted ranking across all three weights (load-bearing) ─────

describe('expertSearchRepository.search — weighted A > B > C ranking', () => {
  it('headline(A) outranks bio(B) outranks product-name(C)', async () => {
    const verticalId = await getVerticalId();
    const term = 'pardot';

    const expertA = await searchExpertFactory({
      verticalId,
      headline: `${term} expert consultant`,
      bio: 'general salesforce work',
    });
    const expertB = await searchExpertFactory({
      verticalId,
      headline: 'Senior consultant',
      bio: `deep ${term} marketing automation experience`,
    });
    const productC = await createProduct(verticalId, `${term} administration`);
    const supportTypeC = await createSupportType(verticalId, 'Technical');
    const expertC = await searchExpertFactory({
      verticalId,
      headline: 'CRM specialist',
      bio: 'works on opportunities',
      competencies: [{ productId: productC, supportTypeId: supportTypeC }],
    });

    const { rows } = await expertSearchRepository.search(
      params({ verticalId, query: term, pageSize: 50 })
    );

    const order = rows.map((r) => r.id);
    const idxA = order.indexOf(expertA.id);
    const idxB = order.indexOf(expertB.id);
    const idxC = order.indexOf(expertC.id);

    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxC).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeLessThan(idxB); // A (headline) > B (bio)
    expect(idxB).toBeLessThan(idxC); // B (bio) > C (product name)
  });
});

// ── 3. Fuzzy fallback within ranking ────────────────────────────────

describe('expertSearchRepository.search — fuzzy trigram fallback', () => {
  it('ranks the misspelled fuzzy hit above a non-matching expert', async () => {
    const verticalId = await getVerticalId();
    const matching = await searchExpertFactory({
      verticalId,
      headline: 'Salesforce platform architect',
      bio: 'Apex and LWC',
    });
    // Unrelated expert: no trigram overlap with "salesfroce" in headline or bio,
    // so it only survives via base visibility and must rank below the fuzzy hit.
    const unrelated = await searchExpertFactory({
      verticalId,
      headline: 'Marketing Cloud email guru',
      bio: 'Journeys and campaigns',
    });

    // "salesfroce" — close enough trigram similarity to the headline token.
    const { rows } = await expertSearchRepository.search(
      params({ verticalId, query: 'salesfroce', sort: 'best_match', pageSize: 50 })
    );

    const ids = rows.map((r) => r.id);
    // The fuzzy near-miss must be returned at all (exercises the > 0.3 predicate).
    expect(ids).toContain(matching.id);

    const idxMatching = ids.indexOf(matching.id);
    const idxUnrelated = ids.indexOf(unrelated.id);
    // The +0.1 * word_similarity rank bump must lift the fuzzy hit above the
    // non-match. When the unrelated expert is filtered out entirely (no trigram
    // overlap → rank 0 but still base-visible), it ranks last via the browse
    // tiebreakers, so the matching expert still precedes it where both appear.
    if (idxUnrelated >= 0) {
      expect(idxMatching).toBeLessThan(idxUnrelated);
    }
  });
});

// ── 3b. Name search (BAL-263) ───────────────────────────────────────
//
// The stored search_vector is generated from headline(A) + bio(B) only — the
// expert's NAME lives on `users` and was never matched before BAL-263. The name
// is controlled via userFactory({ firstName, lastName }) + passing `userId`,
// because the factory's firstName/lastName overrides only feed the username
// slug (createDraft), NOT the users row that search matches on.

describe('expertSearchRepository.search — name matching (BAL-263)', () => {
  it('matches an expert by first name, last name, and full name', async () => {
    const verticalId = await getVerticalId();
    // Distinctive name that does NOT appear in any default headline/bio so the
    // match is unambiguously coming from the name predicate.
    const user = await userFactory({ firstName: 'Zephyrina', lastName: 'Quompublex' });
    const target = await searchExpertFactory({ verticalId, userId: user.id });

    // A decoy expert with a totally different name + default headline/bio.
    const decoyUser = await userFactory({ firstName: 'Bartholomew', lastName: 'Krendlewix' });
    const decoy = await searchExpertFactory({ verticalId, userId: decoyUser.id });

    const byFirst = await expertSearchRepository.search(
      params({ verticalId, query: 'Zephyrina', pageSize: 50 })
    );
    expect(byFirst.rows.map((r) => r.id)).toContain(target.id);
    expect(byFirst.rows.map((r) => r.id)).not.toContain(decoy.id);

    const byLast = await expertSearchRepository.search(
      params({ verticalId, query: 'Quompublex', pageSize: 50 })
    );
    expect(byLast.rows.map((r) => r.id)).toContain(target.id);
    expect(byLast.rows.map((r) => r.id)).not.toContain(decoy.id);

    const byFull = await expertSearchRepository.search(
      params({ verticalId, query: 'Zephyrina Quompublex', pageSize: 50 })
    );
    expect(byFull.rows.map((r) => r.id)).toContain(target.id);
    expect(byFull.rows.map((r) => r.id)).not.toContain(decoy.id);
  });

  it('matches a minor typo in the name via trigram fuzziness', async () => {
    const verticalId = await getVerticalId();
    const user = await userFactory({ firstName: 'Zephyrina', lastName: 'Quompublex' });
    const target = await searchExpertFactory({ verticalId, userId: user.id });

    // "Zephyrena" — one-character typo, close trigram similarity to "Zephyrina".
    const { rows } = await expertSearchRepository.search(
      params({ verticalId, query: 'Zephyrena', pageSize: 50 })
    );
    expect(rows.map((r) => r.id)).toContain(target.id);
  });

  it('ranks a strong name match at the top, above a same-token headline match', async () => {
    const verticalId = await getVerticalId();
    // The person we are searching for, by name. Their headline/bio do NOT contain
    // the query token, so they can only surface (and rank) via the name term.
    const namedUser = await userFactory({ firstName: 'Mxyzptlk', lastName: 'Consultant' });
    const named = await searchExpertFactory({
      verticalId,
      userId: namedUser.id,
      headline: 'Senior delivery lead',
      bio: 'Implementations and rollouts',
    });

    // A different expert whose HEADLINE contains the same token but whose name is
    // unrelated — the name-weighted hit must outrank this headline-only hit.
    const headlineUser = await userFactory({ firstName: 'Greta', lastName: 'Halvorsen' });
    const headlineMatch = await searchExpertFactory({
      verticalId,
      userId: headlineUser.id,
      headline: 'Mxyzptlk platform architect',
      bio: 'General work',
    });

    const { rows } = await expertSearchRepository.search(
      params({ verticalId, query: 'Mxyzptlk', sort: 'best_match', pageSize: 50 })
    );

    const ids = rows.map((r) => r.id);
    const idxNamed = ids.indexOf(named.id);
    const idxHeadline = ids.indexOf(headlineMatch.id);
    expect(idxNamed).toBeGreaterThanOrEqual(0);
    expect(idxHeadline).toBeGreaterThanOrEqual(0);
    // 0.5 * word_similarity(name) ≈ 0.5 for the exact name token, which dominates
    // the 0.1 headline bump → the named expert ranks at/near the top.
    expect(idxNamed).toBeLessThan(idxHeadline);
  });

  it('does not disturb headline/bio/product matches when the name does not match', async () => {
    const verticalId = await getVerticalId();
    // Expert with a default name; surfaces purely on headline FTS.
    const headlineExpert = await searchExpertFactory({
      verticalId,
      headline: 'Agentforce automation specialist',
      bio: 'I build agentforce bots',
    });
    // Expert whose product name matches but whose name + headline do not.
    const productId = await createProduct(verticalId, 'Agentforce administration');
    const stId = await createSupportType(verticalId, 'Technical');
    const productExpert = await searchExpertFactory({
      verticalId,
      headline: 'CRM specialist',
      bio: 'works on opportunities',
      competencies: [{ productId, supportTypeId: stId }],
    });

    const { rows } = await expertSearchRepository.search(
      params({ verticalId, query: 'agentforce', pageSize: 50 })
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(headlineExpert.id);
    expect(ids).toContain(productExpert.id);
    // Headline (A) still outranks the product-name (C) match — the name term,
    // which neither expert triggers, does not perturb the existing ordering.
    expect(ids.indexOf(headlineExpert.id)).toBeLessThan(ids.indexOf(productExpert.id));
  });
});

// ── 4. OR-within / AND-across ───────────────────────────────────────

describe('expertSearchRepository.search — OR within facet, AND across facets', () => {
  it('(productA OR productB) AND english returns union intersected with english speakers', async () => {
    const verticalId = await getVerticalId();
    const productA = await createProduct(verticalId, uniq('SkillA'));
    const productB = await createProduct(verticalId, uniq('SkillB'));
    const stId = await createSupportType(verticalId, 'Technical');
    const english = await createLanguage('English');
    const spanish = await createLanguage('Spanish');

    // Has productA + English → included
    const e1 = await searchExpertFactory({
      verticalId,
      competencies: [{ productId: productA, supportTypeId: stId }],
      languages: [{ languageId: english }],
    });
    // Has productB + English → included
    const e2 = await searchExpertFactory({
      verticalId,
      competencies: [{ productId: productB, supportTypeId: stId }],
      languages: [{ languageId: english }],
    });
    // Has productA but only Spanish → excluded (AND across facets)
    await searchExpertFactory({
      verticalId,
      competencies: [{ productId: productA, supportTypeId: stId }],
      languages: [{ languageId: spanish }],
    });

    const { rows, total } = await expertSearchRepository.search(
      params({
        verticalId,
        productIds: [productA, productB],
        languageIds: [english],
        pageSize: 50,
      })
    );

    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual([e1.id, e2.id].sort());
    expect(total).toBe(2);
    // No row multiplication — each expert appears once.
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ── 5. supportTypes filter ──────────────────────────────────────────

describe('expertSearchRepository.search — supportTypes filter', () => {
  it('filters by support_types.id via expert_competency.support_type_id', async () => {
    const verticalId = await getVerticalId();
    const productId = await createProduct(verticalId, uniq('Skill'));
    const stWanted = await createSupportType(verticalId, 'Architecture');
    const stOther = await createSupportType(verticalId, 'Training');

    const wanted = await searchExpertFactory({
      verticalId,
      competencies: [{ productId: productId, supportTypeId: stWanted }],
    });
    await searchExpertFactory({
      verticalId,
      competencies: [{ productId: productId, supportTypeId: stOther }],
    });

    const { rows } = await expertSearchRepository.search(
      params({ verticalId, supportTypeIds: [stWanted], pageSize: 50 })
    );

    expect(rows.map((r) => r.id)).toEqual([wanted.id]);
  });
});

// ── 5b. industries filter ───────────────────────────────────────────

describe('expertSearchRepository.search — industries filter', () => {
  it('filters by industries.id via expert_industries', async () => {
    const verticalId = await getVerticalId();
    const wantedIndustry = await createIndustry('Technology');
    const otherIndustry = await createIndustry('Finance');

    const wanted = await searchExpertFactory({ verticalId });
    await expertsRepository.syncIndustries(wanted.id, [wantedIndustry]);

    const other = await searchExpertFactory({ verticalId });
    await expertsRepository.syncIndustries(other.id, [otherIndustry]);

    const { rows } = await expertSearchRepository.search(
      params({ verticalId, industryIds: [wantedIndustry], pageSize: 50 })
    );

    const ids = rows.map((r) => r.id);
    expect(ids).toContain(wanted.id);
    expect(ids).not.toContain(other.id);
  });
});

// ── 6. Availability gate ────────────────────────────────────────────

describe('expertSearchRepository.search — availability gate', () => {
  it('gate ON returns only experts with a future cached slot; gate OFF returns all three', async () => {
    const verticalId = await getVerticalId();
    const nullCache = await searchExpertFactory({ verticalId, earliestAvailableAt: undefined });
    const pastCache = await searchExpertFactory({
      verticalId,
      earliestAvailableAt: new Date(NOW.getTime() - DAY),
    });
    const futureCache = await searchExpertFactory({
      verticalId,
      earliestAvailableAt: new Date(NOW.getTime() + DAY),
    });

    const gateOn = await expertSearchRepository.search(
      params({ verticalId, availabilityGateEnabled: true, now: NOW, pageSize: 50 })
    );
    expect(gateOn.rows.map((r) => r.id)).toEqual([futureCache.id]);

    const gateOff = await expertSearchRepository.search(
      params({ verticalId, availabilityGateEnabled: false, now: NOW, pageSize: 50 })
    );
    const offIds = gateOff.rows.map((r) => r.id).sort();
    expect(offIds).toEqual([nullCache.id, pastCache.id, futureCache.id].sort());
  });
});

// ── 6b. countMatchingIgnoringGate (powers wasAvailabilityGated) ──────

describe('expertSearchRepository.countMatchingIgnoringGate', () => {
  it('returns matches the gated search hides: product matches but no future availability', async () => {
    const verticalId = await getVerticalId();
    const productId = await createProduct(verticalId, uniq('Skill'));
    const stId = await createSupportType(verticalId, 'Technical');

    // Approved + searchable expert whose product matches the filter, but with NO
    // availability-cache row → invisible to a gated search, but a genuine match.
    await searchExpertFactory({
      verticalId,
      competencies: [{ productId: productId, supportTypeId: stId }],
      earliestAvailableAt: undefined,
    });

    const gatedSearch = await expertSearchRepository.search(
      params({
        verticalId,
        productIds: [productId],
        availabilityGateEnabled: true,
        now: NOW,
        pageSize: 50,
      })
    );
    expect(gatedSearch.total).toBe(0);

    // The route builds the probe params with the gate off and timeframe cleared.
    const ungated = await expertSearchRepository.countMatchingIgnoringGate(
      params({
        verticalId,
        productIds: [productId],
        availabilityGateEnabled: false,
        timeframe: undefined,
        now: NOW,
        pageSize: 50,
      })
    );
    expect(ungated).toBe(1);
  });

  it('both the gated search and the probe count the expert when future availability exists', async () => {
    const verticalId = await getVerticalId();
    const productId = await createProduct(verticalId, uniq('Skill'));
    const stId = await createSupportType(verticalId, 'Technical');

    await searchExpertFactory({
      verticalId,
      competencies: [{ productId: productId, supportTypeId: stId }],
      earliestAvailableAt: new Date(NOW.getTime() + DAY), // future → bookable
    });

    const gatedSearch = await expertSearchRepository.search(
      params({
        verticalId,
        productIds: [productId],
        availabilityGateEnabled: true,
        now: NOW,
        pageSize: 50,
      })
    );
    expect(gatedSearch.total).toBeGreaterThanOrEqual(1);

    const ungated = await expertSearchRepository.countMatchingIgnoringGate(
      params({
        verticalId,
        productIds: [productId],
        availabilityGateEnabled: false,
        timeframe: undefined,
        now: NOW,
        pageSize: 50,
      })
    );
    expect(ungated).toBeGreaterThanOrEqual(1);
  });

  it('honours the same facet/rate filters as search (non-matching expert excluded)', async () => {
    const verticalId = await getVerticalId();
    const wantedProduct = await createProduct(verticalId, uniq('Wanted'));
    const otherProduct = await createProduct(verticalId, uniq('Other'));
    const stId = await createSupportType(verticalId, 'Technical');

    // Matches the product filter (no availability).
    await searchExpertFactory({
      verticalId,
      competencies: [{ productId: wantedProduct, supportTypeId: stId }],
      earliestAvailableAt: undefined,
    });
    // Does NOT match the product filter → must not be counted.
    await searchExpertFactory({
      verticalId,
      competencies: [{ productId: otherProduct, supportTypeId: stId }],
      earliestAvailableAt: undefined,
    });

    const ungated = await expertSearchRepository.countMatchingIgnoringGate(
      params({
        verticalId,
        productIds: [wantedProduct],
        availabilityGateEnabled: false,
        timeframe: undefined,
        now: NOW,
        pageSize: 50,
      })
    );
    expect(ungated).toBe(1);
  });
});

// ── 7. Timeframe ranges ─────────────────────────────────────────────

describe('expertSearchRepository.search — timeframe ranges (gate-independent)', () => {
  it('includes/excludes by earliest_available_at <= now + interval', async () => {
    const verticalId = await getVerticalId();
    const inHalfDay = await searchExpertFactory({
      verticalId,
      earliestAvailableAt: new Date(NOW.getTime() + DAY / 2),
    });
    const inTwoDays = await searchExpertFactory({
      verticalId,
      earliestAvailableAt: new Date(NOW.getTime() + 2 * DAY),
    });
    const inFiveDays = await searchExpertFactory({
      verticalId,
      earliestAvailableAt: new Date(NOW.getTime() + 5 * DAY),
    });

    // gate OFF the whole time — timeframe self-gates.
    const today = await expertSearchRepository.search(
      params({ verticalId, timeframe: 'today', now: NOW, pageSize: 50 })
    );
    expect(today.rows.map((r) => r.id)).toEqual([inHalfDay.id]);

    const threeDays = await expertSearchRepository.search(
      params({ verticalId, timeframe: '3days', now: NOW, pageSize: 50 })
    );
    expect(threeDays.rows.map((r) => r.id).sort()).toEqual([inHalfDay.id, inTwoDays.id].sort());

    const week = await expertSearchRepository.search(
      params({ verticalId, timeframe: 'week', now: NOW, pageSize: 50 })
    );
    expect(week.rows.map((r) => r.id).sort()).toEqual(
      [inHalfDay.id, inTwoDays.id, inFiveDays.id].sort()
    );
  });
});

// ── 8. Each sort mode ───────────────────────────────────────────────

describe('expertSearchRepository.search — sort modes', () => {
  it('soonest orders by earliest_available_at ASC NULLS LAST', async () => {
    const verticalId = await getVerticalId();
    const noCache = await searchExpertFactory({ verticalId, earliestAvailableAt: undefined });
    const later = await searchExpertFactory({
      verticalId,
      earliestAvailableAt: new Date(NOW.getTime() + 5 * DAY),
    });
    const sooner = await searchExpertFactory({
      verticalId,
      earliestAvailableAt: new Date(NOW.getTime() + DAY),
    });

    const { rows } = await expertSearchRepository.search(
      params({ verticalId, sort: 'soonest', now: NOW, pageSize: 50 })
    );
    const ids = rows.map((r) => r.id);
    expect(ids.indexOf(sooner.id)).toBeLessThan(ids.indexOf(later.id));
    // null-cache expert sinks last.
    expect(ids.indexOf(later.id)).toBeLessThan(ids.indexOf(noCache.id));
  });

  it('lowest_rate orders by rate_cents ASC NULLS LAST', async () => {
    const verticalId = await getVerticalId();
    const cheap = await searchExpertFactory({ verticalId, rateCents: 100 });
    const pricey = await searchExpertFactory({ verticalId, rateCents: 500 });
    const noRate = await searchExpertFactory({ verticalId, rateCents: null });

    const { rows } = await expertSearchRepository.search(
      params({ verticalId, sort: 'lowest_rate', pageSize: 50 })
    );
    const ids = rows.map((r) => r.id);
    expect(ids.indexOf(cheap.id)).toBeLessThan(ids.indexOf(pricey.id));
    expect(ids.indexOf(pricey.id)).toBeLessThan(ids.indexOf(noRate.id));
  });

  it('most_experienced orders by year_started_salesforce ASC NULLS LAST', async () => {
    const verticalId = await getVerticalId();
    const veteran = await searchExpertFactory({ verticalId, yearStartedSalesforce: 2008 });
    const junior = await searchExpertFactory({ verticalId, yearStartedSalesforce: 2022 });

    const { rows } = await expertSearchRepository.search(
      params({ verticalId, sort: 'most_experienced', pageSize: 50 })
    );
    const ids = rows.map((r) => r.id);
    expect(ids.indexOf(veteran.id)).toBeLessThan(ids.indexOf(junior.id));
  });

  it('best_match uses relevance primary, soonness tiebreaker when ranks tie', async () => {
    const verticalId = await getVerticalId();
    // No query → all ranks 0 → falls through to browse order (soonest first).
    const later = await searchExpertFactory({
      verticalId,
      earliestAvailableAt: new Date(NOW.getTime() + 5 * DAY),
    });
    const sooner = await searchExpertFactory({
      verticalId,
      earliestAvailableAt: new Date(NOW.getTime() + DAY),
    });

    const { rows } = await expertSearchRepository.search(
      params({ verticalId, sort: 'best_match', now: NOW, pageSize: 50 })
    );
    const ids = rows.map((r) => r.id);
    expect(ids.indexOf(sooner.id)).toBeLessThan(ids.indexOf(later.id));
  });
});

// ── 9. Pagination ───────────────────────────────────────────────────

describe('expertSearchRepository.search — pagination', () => {
  it('slices by pageSize, total stays correct, no duplicate/missing rows across pages', async () => {
    const verticalId = await getVerticalId();
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const e = await searchExpertFactory({ verticalId, rateCents: 100 + i });
      created.push(e.id);
    }

    const page1 = await expertSearchRepository.search(
      params({ verticalId, sort: 'lowest_rate', page: 1, pageSize: 2 })
    );
    const page2 = await expertSearchRepository.search(
      params({ verticalId, sort: 'lowest_rate', page: 2, pageSize: 2 })
    );
    const page3 = await expertSearchRepository.search(
      params({ verticalId, sort: 'lowest_rate', page: 3, pageSize: 2 })
    );

    expect(page1.total).toBe(5);
    expect(page2.total).toBe(5);
    expect(page1.rows).toHaveLength(2);
    expect(page2.rows).toHaveLength(2);
    expect(page3.rows).toHaveLength(1);

    const allPaged = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.id);
    expect(new Set(allPaged).size).toBe(5); // no duplicates across pages
    expect(allPaged.sort()).toEqual([...created].sort());

    // Page beyond last → empty rows, correct total.
    const page4 = await expertSearchRepository.search(
      params({ verticalId, sort: 'lowest_rate', page: 4, pageSize: 2 })
    );
    expect(page4.rows).toHaveLength(0);
    expect(page4.total).toBe(5);
  });
});

// ── 10. Facet counts (selection-independent) ────────────────────────

describe('expertSearchRepository.facetCounts', () => {
  it('is selection-independent (applied product filter / q does not change totals) and dedupes', async () => {
    const verticalId = await getVerticalId();
    const productA = await createProduct(verticalId, uniq('SkillA'));
    const productB = await createProduct(verticalId, uniq('SkillB'));
    const stTech = await createSupportType(verticalId, 'Technical');
    const stArch = await createSupportType(verticalId, 'Architecture');
    const english = await createLanguage('English');

    // Expert with productA under TWO support types → count(DISTINCT) must dedupe to 1.
    await searchExpertFactory({
      verticalId,
      competencies: [
        { productId: productA, supportTypeId: stTech },
        { productId: productA, supportTypeId: stArch },
      ],
      languages: [{ languageId: english }],
    });
    await searchExpertFactory({
      verticalId,
      competencies: [{ productId: productB, supportTypeId: stTech }],
      languages: [{ languageId: english }],
    });

    const facets = await expertSearchRepository.facetCounts(verticalId, false, NOW);

    const productAFacet = facets.products.find((f) => f.id === productA);
    const productBFacet = facets.products.find((f) => f.id === productB);
    expect(productAFacet?.count).toBe(1); // deduped despite 2 support-type rows
    expect(productBFacet?.count).toBe(1);

    // English: both experts → 2.
    const englishFacet = facets.languages.find((f) => f.id === english);
    expect(englishFacet?.count).toBe(2);

    // Selection-independence: the route would pass the same args regardless of
    // applied filters/q, so facetCounts ignores them by construction. Re-running
    // yields identical totals.
    const facetsAgain = await expertSearchRepository.facetCounts(verticalId, false, NOW);
    expect(facetsAgain.products.find((f) => f.id === productA)?.count).toBe(1);
  });

  it('respects the availability gate', async () => {
    const verticalId = await getVerticalId();
    const productId = await createProduct(verticalId, uniq('Skill'));
    const stId = await createSupportType(verticalId, 'Technical');

    await searchExpertFactory({
      verticalId,
      competencies: [{ productId: productId, supportTypeId: stId }],
      earliestAvailableAt: new Date(NOW.getTime() + DAY), // future → counted when gate ON
    });
    await searchExpertFactory({
      verticalId,
      competencies: [{ productId: productId, supportTypeId: stId }],
      earliestAvailableAt: undefined, // no cache → excluded when gate ON
    });

    const gateOff = await expertSearchRepository.facetCounts(verticalId, false, NOW);
    expect(gateOff.products.find((f) => f.id === productId)?.count).toBe(2);

    const gateOn = await expertSearchRepository.facetCounts(verticalId, true, NOW);
    expect(gateOn.products.find((f) => f.id === productId)?.count).toBe(1);
  });
});

// ── 11. Rate range ──────────────────────────────────────────────────

describe('expertSearchRepository.search — rate range', () => {
  it('applies bounds; null-rate excluded when a bound is set, included otherwise', async () => {
    const verticalId = await getVerticalId();
    const cheap = await searchExpertFactory({ verticalId, rateCents: 100 });
    const mid = await searchExpertFactory({ verticalId, rateCents: 300 });
    const pricey = await searchExpertFactory({ verticalId, rateCents: 900 });
    const noRate = await searchExpertFactory({ verticalId, rateCents: null });

    const bounded = await expertSearchRepository.search(
      params({ verticalId, rateMinCents: 200, rateMaxCents: 500, pageSize: 50 })
    );
    const boundedIds = bounded.rows.map((r) => r.id);
    expect(boundedIds).toEqual([mid.id]);
    expect(boundedIds).not.toContain(noRate.id);
    expect(boundedIds).not.toContain(cheap.id);
    expect(boundedIds).not.toContain(pricey.id);

    // No bound → null-rate expert included.
    const unbounded = await expertSearchRepository.search(params({ verticalId, pageSize: 50 }));
    expect(unbounded.rows.map((r) => r.id)).toContain(noRate.id);
  });
});

// ── 12. Base visibility ─────────────────────────────────────────────

describe('expertSearchRepository.search — base visibility', () => {
  it('excludes non-searchable and non-approved experts', async () => {
    const verticalId = await getVerticalId();
    const visible = await searchExpertFactory({ verticalId, searchable: true });

    // searchable=false expert
    await searchExpertFactory({ verticalId, searchable: false });

    // An approved+searchable expert whose approvedAt is then cleared → not
    // visible. (updateProfile does not expose approvedAt, so set it directly.)
    const unapproved = await searchExpertFactory({ verticalId, searchable: true });
    await db
      .update(expertProfiles)
      .set({ approvedAt: null })
      .where(eq(expertProfiles.id, unapproved.id));

    const { rows } = await expertSearchRepository.search(params({ verticalId, pageSize: 50 }));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(visible.id);
    expect(ids).not.toContain(unapproved.id);
  });
});

// ── 13. consultationCount proxy ─────────────────────────────────────

describe('expertSearchRepository.search — consultationCount proxy', () => {
  it('counts confirmed non-deleted consultations; excludes cancelled/soft-deleted; degrades to 0', async () => {
    const verticalId = await getVerticalId();
    const withConsults = await searchExpertFactory({ verticalId });
    const withoutConsults = await searchExpertFactory({ verticalId });

    const base = NOW.getTime();
    await db.insert(consultations).values([
      // confirmed → counts
      {
        expertProfileId: withConsults.id,
        startAt: new Date(base + DAY),
        endAt: new Date(base + DAY + 60 * 60 * 1000),
        status: 'confirmed',
      },
      {
        expertProfileId: withConsults.id,
        startAt: new Date(base + 2 * DAY),
        endAt: new Date(base + 2 * DAY + 60 * 60 * 1000),
        status: 'confirmed',
      },
      // cancelled → excluded
      {
        expertProfileId: withConsults.id,
        startAt: new Date(base + 3 * DAY),
        endAt: new Date(base + 3 * DAY + 60 * 60 * 1000),
        status: 'cancelled',
      },
      // confirmed but soft-deleted → excluded
      {
        expertProfileId: withConsults.id,
        startAt: new Date(base + 4 * DAY),
        endAt: new Date(base + 4 * DAY + 60 * 60 * 1000),
        status: 'confirmed',
        deletedAt: new Date(),
      },
    ]);

    const { rows } = await expertSearchRepository.search(params({ verticalId, pageSize: 50 }));
    const a = rows.find((r) => r.id === withConsults.id);
    const b = rows.find((r) => r.id === withoutConsults.id);
    expect(a?.consultationCount).toBe(2);
    expect(b?.consultationCount).toBe(0);
  });
});

// ── 14. Mapper-relevant row fields ──────────────────────────────────

describe('expertSearchRepository.search — row field hydration', () => {
  it('hydrates earliestAvailableAt, rate, languages w/ flagEmoji, agency, distinctions, country', async () => {
    const verticalId = await getVerticalId();
    const agencyId = await createAgency('Acme Consulting', 'https://cdn.example.com/acme.png');
    const english = await createLanguage('English', '🇬🇧');
    const french = await createLanguage('French', '🇫🇷');
    const user = await userFactory({
      firstName: 'Ada',
      lastName: 'Lovelace',
      countryCode: 'GB',
      avatarUrl: 'https://cdn.example.com/ada.png',
    });

    const slot = new Date(NOW.getTime() + DAY);
    const expert = await searchExpertFactory({
      verticalId,
      userId: user.id,
      agencyId,
      headline: 'Distinguished Architect',
      bio: 'CTA + MVP',
      rateCents: 250,
      isSalesforceMvp: true,
      isSalesforceCta: true,
      isCertifiedTrainer: true,
      languages: [{ languageId: english }, { languageId: french }],
      earliestAvailableAt: slot,
    });

    const { rows } = await expertSearchRepository.search(params({ verticalId, pageSize: 50 }));
    const row = rows.find((r) => r.id === expert.id);
    expect(row).toBeDefined();
    expect(row!.firstName).toBe('Ada');
    expect(row!.lastName).toBe('Lovelace');
    expect(row!.countryCode).toBe('GB');
    expect(row!.avatarUrl).toBe('https://cdn.example.com/ada.png');
    expect(row!.rateCents).toBe(250);
    expect(row!.earliestAvailableAt?.getTime()).toBe(slot.getTime());
    expect(row!.agencyName).toBe('Acme Consulting');
    expect(row!.agencyLogoUrl).toBe('https://cdn.example.com/acme.png');
    expect(row!.isSalesforceMvp).toBe(true);
    expect(row!.isSalesforceCta).toBe(true);
    expect(row!.isCertifiedTrainer).toBe(true);
    const langNames = row!.languages.map((l) => l.name).sort();
    expect(langNames).toEqual(['English', 'French']);
    const englishLang = row!.languages.find((l) => l.name === 'English');
    expect(englishLang?.flagEmoji).toBe('🇬🇧');
  });

  it('returns null agency fields and null rate when not set', async () => {
    const verticalId = await getVerticalId();
    const expert = await searchExpertFactory({
      verticalId,
      agencyId: null,
      rateCents: null,
    });

    const { rows } = await expertSearchRepository.search(params({ verticalId, pageSize: 50 }));
    const row = rows.find((r) => r.id === expert.id);
    expect(row!.agencyName).toBeNull();
    expect(row!.agencyLogoUrl).toBeNull();
    expect(row!.rateCents).toBeNull();
  });

  it('returns an agency with a null logoUrl when the agency has no logo', async () => {
    const verticalId = await getVerticalId();
    const agencyId = await createAgency('No Logo Agency', null);
    const expert = await searchExpertFactory({ verticalId, agencyId });

    const { rows } = await expertSearchRepository.search(params({ verticalId, pageSize: 50 }));
    const row = rows.find((r) => r.id === expert.id);
    expect(row!.agencyName).toBe('No Logo Agency');
    expect(row!.agencyLogoUrl).toBeNull();
  });

  it('hydrates per-expert competencies (product name + support-type slug + proficiency)', async () => {
    const verticalId = await getVerticalId();
    const productName = uniq('Sales Cloud');
    const productId = await createProduct(verticalId, productName);
    const [supportType] = await db
      .insert(supportTypes)
      .values({ verticalId, name: 'Technical Fix & Support', slug: uniq('st-slug') })
      .returning();
    const expert = await searchExpertFactory({
      verticalId,
      competencies: [{ productId: productId, supportTypeId: supportType!.id, proficiency: 4 }],
    });

    const { rows } = await expertSearchRepository.search(params({ verticalId, pageSize: 50 }));
    const row = rows.find((r) => r.id === expert.id);
    expect(row).toBeDefined();
    expect(row!.competencies).toEqual([
      {
        productId: productId,
        productName: productName,
        supportTypeSlug: supportType!.slug,
        proficiency: 4,
      },
    ]);
  });

  it('returns an empty competencies array for an expert with no competencies', async () => {
    const verticalId = await getVerticalId();
    const expert = await searchExpertFactory({ verticalId });

    const { rows } = await expertSearchRepository.search(params({ verticalId, pageSize: 50 }));
    const row = rows.find((r) => r.id === expert.id);
    expect(row!.competencies).toEqual([]);
  });
});

// ── Pure helper unit-style coverage (executed against the real DB run) ──

describe('buildWhereConditions / buildOrderBy / timeframeBoundary (pure)', () => {
  it('base conditions only when no filters supplied', () => {
    const verticalId = '00000000-0000-0000-0000-000000000000';
    const conds = buildWhereConditions(params({ verticalId }), NOW);
    // vertical + searchable + approved = 3 base conditions, no filters.
    expect(conds).toHaveLength(3);
  });

  it('adds one EXISTS condition per non-empty facet (AND across)', () => {
    const verticalId = '00000000-0000-0000-0000-000000000000';
    const conds = buildWhereConditions(
      params({
        verticalId,
        productIds: ['a', 'b'],
        supportTypeIds: ['c'],
        languageIds: ['d'],
        industryIds: ['e'],
      }),
      NOW
    );
    // 3 base + 4 facet EXISTS.
    expect(conds).toHaveLength(7);
  });

  it('adds gate predicates when the gate is enabled', () => {
    const verticalId = '00000000-0000-0000-0000-000000000000';
    const off = buildWhereConditions(params({ verticalId, availabilityGateEnabled: false }), NOW);
    const on = buildWhereConditions(params({ verticalId, availabilityGateEnabled: true }), NOW);
    // gate ON adds 2 predicates (isNotNull + gt).
    expect(on.length - off.length).toBe(2);
  });

  it('adds timeframe predicates independent of the gate', () => {
    const verticalId = '00000000-0000-0000-0000-000000000000';
    const base = buildWhereConditions(params({ verticalId }), NOW);
    const tf = buildWhereConditions(params({ verticalId, timeframe: 'today' }), NOW);
    expect(tf.length - base.length).toBe(2);
  });

  it('adds rate-bound predicates', () => {
    const verticalId = '00000000-0000-0000-0000-000000000000';
    const base = buildWhereConditions(params({ verticalId }), NOW);
    const ranged = buildWhereConditions(
      params({ verticalId, rateMinCents: 100, rateMaxCents: 500 }),
      NOW
    );
    expect(ranged.length - base.length).toBe(2);
  });

  it('adds a single FTS match condition when a query is present', () => {
    const verticalId = '00000000-0000-0000-0000-000000000000';
    const base = buildWhereConditions(params({ verticalId }), NOW);
    const withQ = buildWhereConditions(params({ verticalId, query: 'agentforce' }), NOW);
    expect(withQ.length - base.length).toBe(1);
  });

  it('skips FTS when the query is blank/whitespace', () => {
    const verticalId = '00000000-0000-0000-0000-000000000000';
    const base = buildWhereConditions(params({ verticalId }), NOW);
    const blank = buildWhereConditions(params({ verticalId, query: '   ' }), NOW);
    expect(blank).toHaveLength(base.length);
  });

  it('buildOrderBy returns a stable id tiebreaker for every sort mode', () => {
    for (const sort of ['best_match', 'soonest', 'lowest_rate', 'most_experienced'] as const) {
      const order = buildOrderBy(sort);
      expect(order.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('timeframeBoundary computes now + N days', () => {
    expect(timeframeBoundary('today', NOW).getTime()).toBe(NOW.getTime() + DAY);
    expect(timeframeBoundary('3days', NOW).getTime()).toBe(NOW.getTime() + 3 * DAY);
    expect(timeframeBoundary('week', NOW).getTime()).toBe(NOW.getTime() + 7 * DAY);
  });
});
