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
const SKILL_CATEGORIES: Array<[string, string, string[]]> = [
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
    'Industries',
    'industries',
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
// Seed function
// ──────────────────────────────────────────────────────

async function seed(): Promise<void> {
  console.log('Seeding reference data...');

  // 1. Verticals
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

  // 2. Support Types
  console.log('  Seeding support types...');
  await db
    .insert(schema.supportTypes)
    .values([
      { name: 'Technical Fix / Support', slug: 'technical-fix-support', sortOrder: 0 },
      { name: 'Architecture / Integrations', slug: 'architecture-integrations', sortOrder: 1 },
      { name: 'Strategy / Best Practices', slug: 'strategy-best-practices', sortOrder: 2 },
      { name: 'Platform Training', slug: 'platform-training', sortOrder: 3 },
    ])
    .onConflictDoNothing();

  // 3. Skill Categories + Skills
  console.log('  Seeding skill categories...');
  await db
    .insert(schema.skillCategories)
    .values(
      SKILL_CATEGORIES.map(([name, slug], i) => ({ name, slug, verticalId: sfId, sortOrder: i }))
    )
    .onConflictDoNothing();

  const categories = await db
    .select()
    .from(schema.skillCategories)
    .where(eq(schema.skillCategories.verticalId, sfId));
  const catMap = Object.fromEntries(categories.map((c) => [c.slug, c.id]));

  console.log('  Seeding skills...');
  const skillValues = SKILL_CATEGORIES.flatMap(([, catSlug, names]) =>
    names.map((name, i) => ({
      name,
      slug: slugify(name),
      verticalId: sfId,
      categoryId: catMap[catSlug],
      sortOrder: i,
    }))
  );
  await db.insert(schema.skills).values(skillValues).onConflictDoNothing();

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
    db.select().from(schema.skillCategories),
    db.select().from(schema.skills),
    db.select().from(schema.certificationCategories),
    db.select().from(schema.certifications),
    db.select().from(schema.languages),
    db.select().from(schema.industries),
  ]);

  console.log(
    `\nSeed complete. Seeded ${counts[0].length} verticals, ${counts[1].length} support types, ${counts[2].length} skill categories, ${counts[3].length} skills, ${counts[4].length} certification categories, ${counts[5].length} certifications, ${counts[6].length} languages, ${counts[7].length} industries.`
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
