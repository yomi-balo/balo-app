/**
 * PURE expert generator for BAL-239.
 *
 * `generateExperts` is deterministic: the same `{count, seed, taxonomy,
 * baselineNow}` always yields the same array, and experts `0..k` are identical
 * regardless of `count` (so count=60 and count=150 agree on the first 60).
 *
 * Determinism applies to ATTRIBUTES, never to DB-generated UUID PKs — this
 * module produces no ids. Do NOT reorder generation steps: each call into a
 * `WeightedRng` instance advances its stream, so order is part of the contract.
 *
 * No DB, no env, no I/O.
 */
import {
  EXPERT_TYPE_WEIGHTS,
  FALLBACK_INDUSTRIES,
  PROJECT_COUNT_BUCKETS,
  RATE_BANDS,
  SEED_EMAIL_DOMAIN,
  SEED_WORKOS_PREFIX,
  SKILL_COUNT_RANGE,
  SKILL_TIER_BOUNDARIES,
  SKILL_TIER_WEIGHTS,
  TIMEZONE_WEIGHTS,
} from './constants.js';
import { HEADLINE_TEMPLATES, renderHeadline } from './headlines.js';
import { faker, seedFaker, WeightedRng } from './rng.js';
import type { GeneratedExpert, LanguageProficiency, SeedTaxonomy } from './types.js';

export interface GenerateExpertsInput {
  count: number;
  seed: number;
  taxonomy: SeedTaxonomy;
  baselineNow: Date;
}

const LANGUAGE_PROFICIENCIES: readonly LanguageProficiency[] = [
  'beginner',
  'intermediate',
  'advanced',
  'native',
];

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Weight of a skill by its position in the flattened (core-first) taxonomy. */
function skillWeightForIndex(idx: number): number {
  if (idx < SKILL_TIER_BOUNDARIES.core) return SKILL_TIER_WEIGHTS.core;
  if (idx < SKILL_TIER_BOUNDARIES.mid) return SKILL_TIER_WEIGHTS.mid;
  return SKILL_TIER_WEIGHTS.niche;
}

/** Slugify a name to a username base (lowercase, alnum + hyphen). */
function baseUsername(first: string, last: string): string {
  // Collapse runs of non-alphanumerics to single spaces, trim, then space→dash.
  // Avoids the anchored `+` alternation (`/^-+|-+$/g`) that SonarCloud flags as
  // a super-linear ReDoS pattern (S5852); same slug output.
  const cleaned = `${first}-${last}`
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/ /g, '-');
  return cleaned.length > 0 ? cleaned : 'expert';
}

export function generateExperts(input: GenerateExpertsInput): GeneratedExpert[] {
  const { count, seed, taxonomy, baselineNow } = input;

  if (taxonomy.skills.length === 0) {
    throw new Error(
      'Seed taxonomy has no skills — run `pnpm --filter db db:seed` before seeding experts.'
    );
  }
  if (taxonomy.supportTypeIds.length === 0) {
    throw new Error(
      'Seed taxonomy has no support types — run `pnpm --filter db db:seed` before seeding experts.'
    );
  }

  seedFaker(seed);
  const rng = new WeightedRng(seed);

  const baselineYear = baselineNow.getUTCFullYear();
  const skillWeights = taxonomy.skills.map((_, i) => skillWeightForIndex(i));
  const tzValues = TIMEZONE_WEIGHTS.map((t) => t.value);
  const tzWeights = TIMEZONE_WEIGHTS.map((t) => t.weight);
  const typeValues = EXPERT_TYPE_WEIGHTS.map((t) => t.value);
  const typeWeights = EXPERT_TYPE_WEIGHTS.map((t) => t.weight);
  const rateWeights = RATE_BANDS.map((b) => b.weight);

  const experts: GeneratedExpert[] = [];

  for (let i = 0; i < count; i++) {
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();

    const timezone = rng.pick(tzValues, tzWeights);
    const type = rng.pick(typeValues, typeWeights);

    // Rate band → per-minute cents.
    const band = rng.pick(RATE_BANDS, rateWeights);
    const rateCents = rng.int(band.min, band.max);

    // Experience.
    const yearsAgo = rng.int(1, 18);
    const yearStartedSalesforce = baselineYear - yearsAgo;

    // Skills: weighted distinct sample, each with a support type + proficiency.
    const skillCount = rng.int(SKILL_COUNT_RANGE.min, SKILL_COUNT_RANGE.max);
    const pickedSkillEntries = rng.sampleWeighted(
      taxonomy.skills.map((s, idx) => ({ skill: s, idx })),
      skillWeights,
      skillCount
    );
    const seenSkillSupport = new Set<string>();
    const skills: GeneratedExpert['skills'] = [];
    for (const entry of pickedSkillEntries) {
      const supportTypeId = rng.pickOne(taxonomy.supportTypeIds);
      const key = `${entry.skill.id}:${supportTypeId}`;
      if (seenSkillSupport.has(key)) continue;
      seenSkillSupport.add(key);
      skills.push({
        skillId: entry.skill.id,
        supportTypeId,
        proficiency: rng.int(1, 5),
      });
    }

    // Top-weighted skill name drives the headline `{cloud}` slot.
    const topCloud = pickedSkillEntries[0]?.skill.name ?? 'Salesforce';

    // Languages: English (index 0) always native, plus 0–2 others.
    const languages = buildLanguages(rng, taxonomy);

    // Industries: 0–3 seeded (or none → headline falls back to a pool string).
    const industryIds = buildIndustries(rng, taxonomy);
    const industryName = resolveIndustryName(rng, taxonomy, industryIds);

    const headlineTemplate = rng.pickOne(HEADLINE_TEMPLATES);
    const headline = renderHeadline(headlineTemplate, {
      years: yearsAgo,
      cloud: topCloud,
      industry: industryName,
    });

    experts.push({
      index: i,
      workosId: `${SEED_WORKOS_PREFIX}${seed}_${i}`,
      email: `expert${i}@${SEED_EMAIL_DOMAIN}`,
      firstName,
      lastName,
      timezone,
      type,
      headline,
      bio: faker.lorem.paragraph(),
      username: `${baseUsername(firstName, lastName)}-${i}`,
      rateCents,
      rateBand: band.band,
      yearStartedSalesforce,
      projectCountMin: rng.pickOne(PROJECT_COUNT_BUCKETS),
      projectLeadCountMin: rng.pickOne(PROJECT_COUNT_BUCKETS),
      isSalesforceMvp: rng.bool(0.05),
      isSalesforceCta: rng.bool(0.05),
      isCertifiedTrainer: rng.bool(0.05),
      approvedOffsetMs: rng.int(1, 90) * ONE_DAY_MS,
      skills,
      languages,
      industryIds,
      // rating / session_count omitted — no columns exist for them yet (see
      // GeneratedExpert in types.ts). Adding draws here would also be dead RNG.
    });
  }

  return experts;
}

function buildLanguages(rng: WeightedRng, taxonomy: SeedTaxonomy): GeneratedExpert['languages'] {
  if (taxonomy.languages.length === 0) return [];
  const result: GeneratedExpert['languages'] = [
    { languageId: taxonomy.languages[0].id, proficiency: 'native' },
  ];
  const extras = rng.int(0, 2);
  if (taxonomy.languages.length > 1 && extras > 0) {
    const pool = taxonomy.languages.slice(1);
    const picked = rng.sampleWeighted(
      pool,
      pool.map(() => 1),
      extras
    );
    for (const lang of picked) {
      result.push({
        languageId: lang.id,
        proficiency: rng.pickOne(LANGUAGE_PROFICIENCIES.slice(0, 3)),
      });
    }
  }
  return result;
}

function buildIndustries(rng: WeightedRng, taxonomy: SeedTaxonomy): string[] {
  if (taxonomy.industries.length === 0) return [];
  const n = Math.min(rng.int(1, 3), taxonomy.industries.length);
  return rng
    .sampleWeighted(
      taxonomy.industries,
      taxonomy.industries.map(() => 1),
      n
    )
    .map((ind) => ind.id);
}

function resolveIndustryName(
  rng: WeightedRng,
  taxonomy: SeedTaxonomy,
  industryIds: string[]
): string {
  const first = industryIds[0];
  if (first) {
    const match = taxonomy.industries.find((ind) => ind.id === first);
    if (match) return match.name.toLowerCase();
  }
  return rng.pickOne(FALLBACK_INDUSTRIES);
}
