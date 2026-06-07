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
  CERT_COUNT_RANGE,
  CERT_EARNED_MONTHS_AGO_RANGE,
  CERT_EXPIRY_MONTHS_AHEAD_RANGE,
  CERT_HAS_EXPIRY_PROBABILITY,
  COMPETENCY_COUNT_RANGE,
  CURRENT_ROLE_MONTHS_RANGE,
  EXPERT_TYPE_WEIGHTS,
  FALLBACK_INDUSTRIES,
  PAST_ROLE_MONTHS_RANGE,
  PRODUCT_TIER_BOUNDARIES,
  PRODUCT_TIER_WEIGHTS,
  PROJECT_COUNT_BUCKETS,
  RATE_BANDS,
  ROLE_GAP_MONTHS_RANGE,
  SEED_EMAIL_DOMAIN,
  SEED_WORKOS_PREFIX,
  TIMEZONE_WEIGHTS,
  WORK_HISTORY_COUNT_RANGE,
  WORK_RESPONSIBILITY_SNIPPETS,
  WORK_ROLE_TITLES,
} from './constants.js';
import { HEADLINE_TEMPLATES, renderHeadline } from './headlines.js';
import { faker, seedFaker, WeightedRng } from './rng.js';
import type {
  GeneratedCertification,
  GeneratedExpert,
  GeneratedWorkHistory,
  LanguageProficiency,
  SeedTaxonomy,
} from './types.js';

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

/** Weight of a product by its position in the flattened (core-first) taxonomy. */
function productWeightForIndex(idx: number): number {
  if (idx < PRODUCT_TIER_BOUNDARIES.core) return PRODUCT_TIER_WEIGHTS.core;
  if (idx < PRODUCT_TIER_BOUNDARIES.mid) return PRODUCT_TIER_WEIGHTS.mid;
  return PRODUCT_TIER_WEIGHTS.niche;
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

  if (taxonomy.products.length === 0) {
    throw new Error(
      'Seed taxonomy has no products — run `pnpm --filter db db:seed` before seeding experts.'
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
  const productWeights = taxonomy.products.map((_, i) => productWeightForIndex(i));
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

    // Competencies: weighted distinct sample, each with a support type + proficiency.
    const competencyCount = rng.int(COMPETENCY_COUNT_RANGE.min, COMPETENCY_COUNT_RANGE.max);
    const pickedProductEntries = rng.sampleWeighted(
      taxonomy.products.map((p, idx) => ({ product: p, idx })),
      productWeights,
      competencyCount
    );
    const seenProductSupport = new Set<string>();
    const competencies: GeneratedExpert['competencies'] = [];
    for (const entry of pickedProductEntries) {
      const supportTypeId = rng.pickOne(taxonomy.supportTypeIds);
      const key = `${entry.product.id}:${supportTypeId}`;
      if (seenProductSupport.has(key)) continue;
      seenProductSupport.add(key);
      competencies.push({
        productId: entry.product.id,
        supportTypeId,
        proficiency: rng.int(1, 5),
      });
    }

    // Top-weighted product name drives the headline `{cloud}` slot.
    const topCloud = pickedProductEntries[0]?.product.name ?? 'Salesforce';

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

    // Trailing scalar draws — hoisted out of the object literal into source-order
    // consts (object-literal evaluation is already top-to-bottom, so this does
    // NOT change the RNG stream). They MUST stay before the new work-history /
    // certification draws so every existing attribute remains byte-identical.
    const bio = faker.lorem.paragraph();
    const username = `${baseUsername(firstName, lastName)}-${i}`;
    const projectCountMin = rng.pickOne(PROJECT_COUNT_BUCKETS);
    const projectLeadCountMin = rng.pickOne(PROJECT_COUNT_BUCKETS);
    const isSalesforceMvp = rng.bool(0.05);
    const isSalesforceCta = rng.bool(0.05);
    const isCertifiedTrainer = rng.bool(0.05);
    const approvedOffsetMs = rng.int(1, 90) * ONE_DAY_MS;

    // NEW draws — appended STRICTLY AFTER all existing draws for this expert so
    // the count-independence determinism contract holds.
    const workHistory = buildWorkHistory(rng, baselineNow);
    const certifications = buildCertifications(rng, taxonomy, baselineNow);

    experts.push({
      index: i,
      workosId: `${SEED_WORKOS_PREFIX}${seed}_${i}`,
      email: `expert${i}@${SEED_EMAIL_DOMAIN}`,
      firstName,
      lastName,
      timezone,
      type,
      headline,
      bio,
      username,
      rateCents,
      rateBand: band.band,
      yearStartedSalesforce,
      projectCountMin,
      projectLeadCountMin,
      isSalesforceMvp,
      isSalesforceCta,
      isCertifiedTrainer,
      approvedOffsetMs,
      competencies,
      languages,
      industryIds,
      workHistory,
      certifications,
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

// ── Work history + certifications (BAL-256) ──────────────────────────

/** Subtract whole months from a UTC date (month-accurate). */
function subMonths(d: Date, m: number): Date {
  const r = new Date(d.getTime());
  r.setUTCMonth(r.getUTCMonth() - m);
  return r;
}

/** Add whole months to a UTC date (month-accurate). */
function addMonths(d: Date, m: number): Date {
  const r = new Date(d.getTime());
  r.setUTCMonth(r.getUTCMonth() + m);
  return r;
}

/** UTC date → ISO `'YYYY-MM-DD'` (the `date` column wire format). */
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Join 1–3 distinct responsibility snippets into one blurb. */
function pickResponsibilities(rng: WeightedRng): string {
  const n = rng.int(1, 3);
  return rng
    .sampleWeighted(
      WORK_RESPONSIBILITY_SNIPPETS,
      WORK_RESPONSIBILITY_SNIPPETS.map(() => 1),
      n
    )
    .join(' ');
}

/**
 * 2–4 work-history rows, walking backward from `baselineNow`. Index 0 is the
 * single open-ended current role (`isCurrent`, `endedAt: null`, `sortOrder: 0`);
 * older roles are closed spans with strictly increasing `sortOrder` and
 * non-overlapping, chronologically descending date ranges.
 */
function buildWorkHistory(rng: WeightedRng, baselineNow: Date): GeneratedWorkHistory[] {
  const count = rng.int(WORK_HISTORY_COUNT_RANGE.min, WORK_HISTORY_COUNT_RANGE.max);
  const out: GeneratedWorkHistory[] = [];
  let cursorEnd = baselineNow; // exclusive upper bound for the next (older) role
  for (let i = 0; i < count; i++) {
    if (i === 0) {
      const months = rng.int(CURRENT_ROLE_MONTHS_RANGE.min, CURRENT_ROLE_MONTHS_RANGE.max);
      const startedAt = subMonths(baselineNow, months);
      out.push({
        role: rng.pickOne(WORK_ROLE_TITLES),
        company: faker.company.name(),
        startedAt,
        endedAt: null,
        isCurrent: true,
        responsibilities: pickResponsibilities(rng),
        sortOrder: 0,
      });
      cursorEnd = startedAt;
    } else {
      const gap = rng.int(ROLE_GAP_MONTHS_RANGE.min, ROLE_GAP_MONTHS_RANGE.max);
      const endedAt = subMonths(cursorEnd, gap);
      const startedAt = subMonths(
        endedAt,
        rng.int(PAST_ROLE_MONTHS_RANGE.min, PAST_ROLE_MONTHS_RANGE.max)
      );
      out.push({
        role: rng.pickOne(WORK_ROLE_TITLES),
        company: faker.company.name(),
        startedAt,
        endedAt,
        isCurrent: false,
        responsibilities: pickResponsibilities(rng),
        sortOrder: i,
      });
      cursorEnd = startedAt;
    }
  }
  return out;
}

/**
 * 3–8 distinct certification links from the seeded catalog (count clamped to the
 * catalog size). Empty catalog is NON-fatal → returns `[]`. `earnedAt` is a past
 * ISO date; `expiresAt` is null or a future ISO date.
 */
function buildCertifications(
  rng: WeightedRng,
  taxonomy: SeedTaxonomy,
  baselineNow: Date
): GeneratedCertification[] {
  if (taxonomy.certificationIds.length === 0) return [];
  const n = Math.min(
    rng.int(CERT_COUNT_RANGE.min, CERT_COUNT_RANGE.max),
    taxonomy.certificationIds.length
  );
  const pickedIds = rng.sampleWeighted(
    taxonomy.certificationIds,
    taxonomy.certificationIds.map(() => 1),
    n
  );
  return pickedIds.map((certificationId) => {
    const earnedAt = toIsoDate(
      subMonths(
        baselineNow,
        rng.int(CERT_EARNED_MONTHS_AGO_RANGE.min, CERT_EARNED_MONTHS_AGO_RANGE.max)
      )
    );
    const expiresAt = rng.bool(CERT_HAS_EXPIRY_PROBABILITY)
      ? toIsoDate(
          addMonths(
            baselineNow,
            rng.int(CERT_EXPIRY_MONTHS_AHEAD_RANGE.min, CERT_EXPIRY_MONTHS_AHEAD_RANGE.max)
          )
        )
      : null;
    return { certificationId, earnedAt, expiresAt };
  });
}
