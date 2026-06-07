import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const client = postgres(connectionString, { max: 1 });
const db = drizzle(client, { schema });

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[()]/g, '')
    .replace(/[&/]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ──────────────────────────────────────────────────────
// Seed data definitions (compact format)
// ──────────────────────────────────────────────────────

/** [categoryName, categorySlug, productNames[]] */
const PRODUCT_CATEGORIES: Array<[string, string, string[]]> = [
  ['AI', 'ai', ['Agentforce']],
  ['Data Cloud', 'data-cloud', ['Data Cloud']],
  ['Sales Cloud', 'sales-cloud', ['CPQ', 'Sales Cloud']],
  [
    'Service Cloud',
    'service-cloud',
    ['Digital Engagement', 'Field Service', 'Service Cloud', 'Voice'],
  ],
  [
    'Marketing Cloud',
    'marketing-cloud',
    ['Account Engagement', 'Engagement', 'Intelligence', 'Loyalty Management', 'Personalisation'],
  ],
  ['Slack', 'slack', ['Slack']],
  ['Experience Cloud', 'experience-cloud', ['Experience Cloud']],
  ['Commerce Cloud', 'commerce-cloud', ['B2B Commerce', 'B2C Commerce', 'Order Management']],
  [
    'Platform',
    'platform',
    ['AppExchange', 'Heroku', 'Hyperforce', 'Salesforce Platform', 'Security', 'Shield'],
  ],
  ['Tableau', 'tableau', ['CRM Analytics', 'Tableau']],
  ['Mulesoft', 'mulesoft', ['MuleSoft']],
  [
    'Industry Clouds',
    'industry-clouds',
    [
      'Communications Cloud',
      'Consumer Goods Cloud',
      'Education Cloud',
      'Energy & Utilities Cloud',
      'Financial Services Cloud',
      'Government Cloud',
      'Health Cloud',
      'Manufacturing Cloud',
      'Media Cloud',
      'Nonprofit Cloud',
      'OmniStudio',
    ],
  ],
  ['Net Zero Cloud', 'net-zero-cloud', ['Net Zero Cloud']],
];

/**
 * Second-vertical taxonomy — intentionally a DIFFERENT shape than Salesforce.
 * Proves the seeder hardcodes nothing: the same `seedTaxonomyForVertical` loop
 * drives both verticals. [categoryName, categorySlug, productNames[]]
 */
const ACME_CATEGORIES: Array<[string, string, string[]]> = [
  ['Core Platform', 'core-platform', ['Acme Core', 'Acme Flows']],
  ['Analytics', 'analytics', ['Acme Insights', 'Acme Reports']],
];

/**
 * Support types are now PER-VERTICAL data (vertical slug → [name, slug][]).
 * Each vertical can carry its own dimensions without slug collisions thanks to
 * the composite (vertical_id, slug) unique on support_types.
 */
const SUPPORT_TYPES_BY_VERTICAL: Record<string, Array<[string, string]>> = {
  salesforce: [
    ['Technical Fix / Support', 'technical-fix-support'],
    ['Architecture / Integrations', 'architecture-integrations'],
    ['Strategy / Best Practices', 'strategy-best-practices'],
    ['Platform Training', 'platform-training'],
  ],
  acme: [
    ['Implementation', 'implementation'],
    ['Optimisation', 'optimisation'],
    ['Audit', 'audit'],
  ],
};

/**
 * Mock approved + searchable experts for the `acme` vertical. Idempotent by a
 * stable workosId / email marker. Each picks a product slug + support-type slug
 * from acme's own taxonomy so search facets surface real acme data.
 * [workosId, email, firstName, lastName, headline, productSlug, supportTypeSlug]
 */
const ACME_EXPERTS: Array<[string, string, string, string, string, string, string]> = [
  [
    'seed_acme_0',
    'acme-expert-0@seed.balo.dev',
    'Aria',
    'Stone',
    'Acme Core implementation lead',
    'acme-core',
    'implementation',
  ],
  [
    'seed_acme_1',
    'acme-expert-1@seed.balo.dev',
    'Bruno',
    'Vega',
    'Acme analytics & reporting specialist',
    'acme-insights',
    'optimisation',
  ],
  [
    'seed_acme_2',
    'acme-expert-2@seed.balo.dev',
    'Cora',
    'Lin',
    'Acme Flows architecture & audit',
    'acme-flows',
    'audit',
  ],
];

/** [categoryName, categorySlug, certEntries[]] — cert entry is name or [name, slug] for collisions */
const CERT_CATEGORIES: Array<[string, string, Array<string | [string, string]>]> = [
  [
    'Associate',
    'associate',
    ['AI Associate', 'Marketing Associate', 'Salesforce Associate', 'MuleSoft Associate'],
  ],
  [
    'Salesforce Administrator',
    'salesforce-administrator',
    [
      'Administrator',
      'Advanced Administrator',
      ['AI Specialist', 'ai-specialist-admin'],
      ['Business Analyst', 'business-analyst-admin'],
      'CPQ Specialist',
      ['Marketing Cloud Administrator', 'marketing-cloud-administrator-admin'],
      ['Platform App Builder', 'platform-app-builder-admin'],
      'Slack Administrator',
    ],
  ],
  [
    'Salesforce Architect',
    'salesforce-architect',
    [
      'Application Architect',
      'B2B Solution Architect',
      'B2C Commerce Architect',
      'B2C Solution Architect',
      'Catalyst Specialist',
      'Data Architect',
      'Development Lifecycle and Deployment Architect',
      'Heroku Architect',
      'Identity and Access Management Architect',
      'Integration Architect',
      'MuleSoft Integration Architect I',
      'MuleSoft Platform Architect I',
      'Sharing and Visibility Architect',
      'System Architect',
      'Technical Architect',
      ['AI Specialist', 'ai-specialist-architect'],
    ],
  ],
  [
    'Salesforce Consultant',
    'salesforce-consultant',
    [
      'CRM Analytics and Einstein Discovery Consultant',
      'Data Cloud Consultant',
      'Education Cloud Consultant',
      'Experience Cloud Consultant',
      'Field Service Consultant',
      'Nonprofit Cloud Consultant',
      'OmniStudio Consultant',
      'Sales Cloud Consultant',
      'Service Cloud Consultant',
      'Slack Consultant',
      ['Business Analyst', 'business-analyst-consultant'],
      ['Marketing Cloud Account Engagement Consultant', 'mc-account-engagement-consultant'],
    ],
  ],
  [
    'Salesforce Designer',
    'salesforce-designer',
    ['Strategy Designer', 'User Experience (UX) Designer'],
  ],
  [
    'Salesforce Developer',
    'salesforce-developer',
    [
      'B2C Commerce Developer',
      'Hyperautomation Specialist',
      'Industries CPQ Developer',
      'JavaScript Developer I',
      ['Marketing Cloud Developer', 'marketing-cloud-developer-dev'],
      'MuleSoft Developer I',
      'MuleSoft Developer II',
      'OmniStudio Developer',
      'Platform Developer I',
      'Platform Developer II',
      'Slack Developer',
      ['AI Specialist', 'ai-specialist-developer'],
      ['Platform App Builder', 'platform-app-builder-developer'],
    ],
  ],
  [
    'Salesforce Marketer',
    'salesforce-marketer',
    [
      [
        'Marketing Cloud Account Engagement Consultant',
        'mc-account-engagement-consultant-marketer',
      ],
      'Marketing Cloud Account Engagement Specialist',
      'Marketing Cloud Consultant',
      'Marketing Cloud Email Specialist',
      ['Marketing Cloud Administrator', 'marketing-cloud-administrator-marketer'],
      ['Marketing Cloud Developer', 'marketing-cloud-developer-marketer'],
    ],
  ],
  ['Sales Professional', 'sales-professional', ['Sales Representative']],
  [
    'Tableau',
    'tableau',
    [
      'Tableau Desktop Specialist',
      'Tableau Certified Data Analyst',
      'Tableau Server Certified Associate',
      'Tableau Certified Consultant',
      'Tableau Certified Architect',
    ],
  ],
];

const LANGUAGES: Array<[string, string, string]> = [
  ['English', 'en', '🇬🇧'],
  ['French', 'fr', '🇫🇷'],
  ['Spanish', 'es', '🇪🇸'],
  ['Italian', 'it', '🇮🇹'],
  ['German', 'de', '🇩🇪'],
  ['Korean', 'ko', '🇰🇷'],
  ['Chinese', 'zh', '🇨🇳'],
  ['Russian', 'ru', '🇷🇺'],
  ['Japanese', 'ja', '🇯🇵'],
  ['Hindi', 'hi', '🇮🇳'],
  ['Danish', 'da', '🇩🇰'],
  ['Vietnamese', 'vi', '🇻🇳'],
  ['Portuguese', 'pt', '🇵🇹'],
  ['Polish', 'pl', '🇵🇱'],
  ['Arabic', 'ar', '🇸🇦'],
  ['Filipino', 'fil', '🇵🇭'],
  ['Turkish', 'tr', '🇹🇷'],
];

const INDUSTRIES = [
  'Agriculture & Mining',
  'Automotive',
  'Communications',
  'Consumer Goods',
  'Education',
  'Energy & Utilities',
  'Engineering',
  'Financial Services',
  'Healthcare & Life Sciences',
  'Manufacturing',
  'Media & Entertainment',
  'Non-profit',
  'Professional Services',
  'Public Sector & Government',
  'Real Estate & Construction',
  'Retail',
  'Technology',
  'Transportation',
  'Travel & Hospitality',
];

// ──────────────────────────────────────────────────────
// Generic, vertical-agnostic taxonomy seeder
// ──────────────────────────────────────────────────────

/**
 * Seed categories → products → support types for ONE vertical. Used for BOTH
 * Salesforce and the mock `acme` vertical — proving the seeder hardcodes no
 * vertical-specific taxonomy. Idempotent (onConflictDoNothing on the composite
 * (vertical_id, slug) uniques).
 */
async function seedTaxonomyForVertical(
  verticalId: string,
  categories: Array<[string, string, string[]]>,
  supportTypes: Array<[string, string]>
): Promise<void> {
  // Categories.
  await db
    .insert(schema.categories)
    .values(categories.map(([name, slug], i) => ({ name, slug, verticalId, sortOrder: i })))
    .onConflictDoNothing();

  const catRows = await db
    .select()
    .from(schema.categories)
    .where(eq(schema.categories.verticalId, verticalId));
  const catMap = Object.fromEntries(catRows.map((c) => [c.slug, c.id]));

  // Products.
  const productValues = categories.flatMap(([, catSlug, names]) =>
    names.map((name, i) => ({
      name,
      slug: slugify(name),
      verticalId,
      categoryId: catMap[catSlug],
      sortOrder: i,
    }))
  );
  if (productValues.length > 0) {
    await db.insert(schema.products).values(productValues).onConflictDoNothing();
  }

  // Support types (vertical-scoped).
  if (supportTypes.length > 0) {
    await db
      .insert(schema.supportTypes)
      .values(supportTypes.map(([name, slug], i) => ({ name, slug, verticalId, sortOrder: i })))
      .onConflictDoNothing();
  }
}

/**
 * Seed a handful of approved + searchable experts in the `acme` vertical so
 * local dev mirrors the data-only path (a second vertical reachable via
 * `?vertical=acme`). Idempotent: keyed on stable workosId / email markers and
 * skipped entirely if already present. Each competency draws from acme's own
 * products + support types.
 */
async function seedAcmeExperts(acmeVerticalId: string): Promise<void> {
  // Resolve acme products + support types by slug (seeded above).
  const products = await db
    .select()
    .from(schema.products)
    .where(eq(schema.products.verticalId, acmeVerticalId));
  const productBySlug = Object.fromEntries(products.map((p) => [p.slug, p.id]));

  const supportTypes = await db
    .select()
    .from(schema.supportTypes)
    .where(eq(schema.supportTypes.verticalId, acmeVerticalId));
  const supportTypeBySlug = Object.fromEntries(supportTypes.map((s) => [s.slug, s.id]));

  for (const [
    workosId,
    email,
    firstName,
    lastName,
    headline,
    productSlug,
    supportTypeSlug,
  ] of ACME_EXPERTS) {
    // Idempotency: skip if this seed user already exists.
    const [existingUser] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.workosId, workosId))
      .limit(1);
    if (existingUser) continue;

    // Each expert's user + profile + competency inserts are atomic, so a
    // mid-insert crash rolls back cleanly and never leaves a profile-less
    // seed user for the next run to skip.
    await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(schema.users)
        .values({
          workosId,
          email,
          emailVerified: true,
          firstName,
          lastName,
          activeMode: 'expert',
          onboardingCompleted: true,
        })
        .onConflictDoNothing()
        .returning();
      if (!user) return;

      const now = new Date();
      const [profile] = await tx
        .insert(schema.expertProfiles)
        .values({
          userId: user.id,
          verticalId: acmeVerticalId,
          type: 'freelancer',
          headline,
          bio: 'Seeded mock-vertical expert for the taxonomy data-only path.',
          rateCents: 200,
          searchable: true,
          applicationStatus: 'approved',
          submittedAt: now,
          approvedAt: now,
        })
        .returning();
      if (!profile) return;

      const productId = productBySlug[productSlug];
      const supportTypeId = supportTypeBySlug[supportTypeSlug];
      if (productId && supportTypeId) {
        await tx
          .insert(schema.expertCompetency)
          .values({
            expertProfileId: profile.id,
            productId: productId,
            supportTypeId,
            proficiency: 4,
          })
          .onConflictDoNothing();
      }
    });
  }
}

// ──────────────────────────────────────────────────────
// Seed function
// ──────────────────────────────────────────────────────

async function seed(): Promise<void> {
  console.log('Seeding reference data...');

  // 1. Verticals — Salesforce (live) + an active `acme` MOCK vertical that
  //    demonstrates the data-only path (its taxonomy + experts are seeded by the
  //    same generic loop, proving no hardcoding).
  console.log('  Seeding verticals...');
  await db
    .insert(schema.verticals)
    .values([
      {
        name: 'Salesforce',
        slug: 'salesforce',
        description: 'Salesforce ecosystem',
        isActive: true,
      },
      {
        name: 'Acme Cloud',
        slug: 'acme',
        description: 'Mock vertical for the taxonomy data-driven path',
        isActive: true,
      },
      { name: 'Microsoft', slug: 'microsoft', description: 'Microsoft ecosystem', isActive: false },
      { name: 'Adobe', slug: 'adobe', description: 'Adobe ecosystem', isActive: false },
    ])
    .onConflictDoNothing();

  const [salesforceVertical] = await db
    .select()
    .from(schema.verticals)
    .where(eq(schema.verticals.slug, 'salesforce'))
    .limit(1);
  if (!salesforceVertical) {
    throw new Error('Failed to fetch Salesforce vertical after insert');
  }
  const sfId = salesforceVertical.id;

  const [acmeVertical] = await db
    .select()
    .from(schema.verticals)
    .where(eq(schema.verticals.slug, 'acme'))
    .limit(1);
  if (!acmeVertical) {
    throw new Error('Failed to fetch Acme vertical after insert');
  }
  const acmeId = acmeVertical.id;

  // 2. Taxonomy (categories → products → support types) per vertical, via the
  //    SAME generic seeder — no vertical-specific code path.
  console.log('  Seeding Salesforce taxonomy...');
  await seedTaxonomyForVertical(
    sfId,
    PRODUCT_CATEGORIES,
    SUPPORT_TYPES_BY_VERTICAL.salesforce ?? []
  );

  console.log('  Seeding Acme (mock) taxonomy...');
  await seedTaxonomyForVertical(acmeId, ACME_CATEGORIES, SUPPORT_TYPES_BY_VERTICAL.acme ?? []);

  console.log('  Seeding Acme (mock) experts...');
  await seedAcmeExperts(acmeId);

  // 4. Certification Categories + Certifications
  console.log('  Seeding certification categories...');
  await db
    .insert(schema.certificationCategories)
    .values(CERT_CATEGORIES.map(([name, slug], i) => ({ name, slug, sortOrder: i })))
    .onConflictDoNothing();

  const certCats = await db.select().from(schema.certificationCategories);
  const certCatMap = Object.fromEntries(certCats.map((c) => [c.slug, c.id]));

  console.log('  Seeding certifications...');
  const certValues = CERT_CATEGORIES.flatMap(([, catSlug, entries]) =>
    entries.map((entry) => {
      const [name, slug] = Array.isArray(entry) ? entry : [entry, slugify(entry)];
      return { name, slug, verticalId: sfId, categoryId: certCatMap[catSlug] };
    })
  );
  await db.insert(schema.certifications).values(certValues).onConflictDoNothing();

  // 7. Languages
  console.log('  Seeding languages...');
  await db
    .insert(schema.languages)
    .values(
      LANGUAGES.map(([name, code, flagEmoji], i) => ({ name, code, flagEmoji, sortOrder: i }))
    )
    .onConflictDoNothing();

  // 8. Industries
  console.log('  Seeding industries...');
  await db
    .insert(schema.industries)
    .values(INDUSTRIES.map((name, i) => ({ name, slug: slugify(name), sortOrder: i })))
    .onConflictDoNothing();

  // Summary
  const counts = await Promise.all([
    db.select().from(schema.verticals),
    db.select().from(schema.supportTypes),
    db.select().from(schema.categories),
    db.select().from(schema.products),
    db.select().from(schema.certificationCategories),
    db.select().from(schema.certifications),
    db.select().from(schema.languages),
    db.select().from(schema.industries),
  ]);

  console.log(
    `\nSeed complete. Seeded ${counts[0].length} verticals, ${counts[1].length} support types, ${counts[2].length} categories, ${counts[3].length} products, ${counts[4].length} certification categories, ${counts[5].length} certifications, ${counts[6].length} languages, ${counts[7].length} industries.`
  );
  await client.end();
}

(async () => {
  try {
    await seed();
  } catch (err) {
    console.error('Seed failed:', err);
    process.exit(1);
  }
})();
