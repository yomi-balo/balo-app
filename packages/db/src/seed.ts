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

async function seed(): Promise<void> {
  console.log('Seeding reference data...');

  // ──────────────────────────────────────────────
  // 1. Verticals
  // ──────────────────────────────────────────────
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
        name: 'Microsoft',
        slug: 'microsoft',
        description: 'Microsoft ecosystem',
        isActive: false,
      },
      {
        name: 'Adobe',
        slug: 'adobe',
        description: 'Adobe ecosystem',
        isActive: false,
      },
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

  // ──────────────────────────────────────────────
  // 2. Support Types
  // ──────────────────────────────────────────────
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

  // ──────────────────────────────────────────────
  // 3. Skill Categories
  // ──────────────────────────────────────────────
  console.log('  Seeding skill categories...');
  await db
    .insert(schema.skillCategories)
    .values([
      { name: 'AI', slug: 'ai', verticalId: sfId, sortOrder: 0 },
      { name: 'Data Cloud', slug: 'data-cloud', verticalId: sfId, sortOrder: 1 },
      { name: 'Sales Cloud', slug: 'sales-cloud', verticalId: sfId, sortOrder: 2 },
      { name: 'Service Cloud', slug: 'service-cloud', verticalId: sfId, sortOrder: 3 },
      { name: 'Marketing Cloud', slug: 'marketing-cloud', verticalId: sfId, sortOrder: 4 },
      { name: 'Slack', slug: 'slack', verticalId: sfId, sortOrder: 5 },
      { name: 'Experience Cloud', slug: 'experience-cloud', verticalId: sfId, sortOrder: 6 },
      { name: 'Commerce Cloud', slug: 'commerce-cloud', verticalId: sfId, sortOrder: 7 },
      { name: 'Platform', slug: 'platform', verticalId: sfId, sortOrder: 8 },
      { name: 'Tableau', slug: 'tableau', verticalId: sfId, sortOrder: 9 },
      { name: 'Mulesoft', slug: 'mulesoft', verticalId: sfId, sortOrder: 10 },
      { name: 'Industries', slug: 'industries', verticalId: sfId, sortOrder: 11 },
      { name: 'Net Zero Cloud', slug: 'net-zero-cloud', verticalId: sfId, sortOrder: 12 },
    ])
    .onConflictDoNothing();

  // Fetch categories to map slug -> id for skill FK assignment
  const categories = await db
    .select()
    .from(schema.skillCategories)
    .where(eq(schema.skillCategories.verticalId, sfId));
  const catMap = Object.fromEntries(categories.map((c) => [c.slug, c.id]));

  // ──────────────────────────────────────────────
  // 4. Skills (grouped by category)
  // ──────────────────────────────────────────────
  console.log('  Seeding skills...');
  await db
    .insert(schema.skills)
    .values([
      // AI
      {
        name: 'Agentforce',
        slug: 'agentforce',
        verticalId: sfId,
        categoryId: catMap['ai'],
        sortOrder: 0,
      },
      // Data Cloud
      {
        name: 'Data Cloud',
        slug: 'data-cloud',
        verticalId: sfId,
        categoryId: catMap['data-cloud'],
        sortOrder: 0,
      },
      // Sales Cloud
      {
        name: 'CPQ',
        slug: 'cpq',
        verticalId: sfId,
        categoryId: catMap['sales-cloud'],
        sortOrder: 0,
      },
      {
        name: 'Sales Cloud',
        slug: 'sales-cloud',
        verticalId: sfId,
        categoryId: catMap['sales-cloud'],
        sortOrder: 1,
      },
      // Service Cloud
      {
        name: 'Digital Engagement',
        slug: 'digital-engagement',
        verticalId: sfId,
        categoryId: catMap['service-cloud'],
        sortOrder: 0,
      },
      {
        name: 'Field Service',
        slug: 'field-service',
        verticalId: sfId,
        categoryId: catMap['service-cloud'],
        sortOrder: 1,
      },
      {
        name: 'Service Cloud',
        slug: 'service-cloud',
        verticalId: sfId,
        categoryId: catMap['service-cloud'],
        sortOrder: 2,
      },
      {
        name: 'Voice',
        slug: 'voice',
        verticalId: sfId,
        categoryId: catMap['service-cloud'],
        sortOrder: 3,
      },
      // Marketing Cloud
      {
        name: 'Account Engagement',
        slug: 'account-engagement',
        verticalId: sfId,
        categoryId: catMap['marketing-cloud'],
        sortOrder: 0,
      },
      {
        name: 'Engagement',
        slug: 'engagement',
        verticalId: sfId,
        categoryId: catMap['marketing-cloud'],
        sortOrder: 1,
      },
      {
        name: 'Intelligence',
        slug: 'intelligence',
        verticalId: sfId,
        categoryId: catMap['marketing-cloud'],
        sortOrder: 2,
      },
      {
        name: 'Loyalty Management',
        slug: 'loyalty-management',
        verticalId: sfId,
        categoryId: catMap['marketing-cloud'],
        sortOrder: 3,
      },
      {
        name: 'Personalisation',
        slug: 'personalisation',
        verticalId: sfId,
        categoryId: catMap['marketing-cloud'],
        sortOrder: 4,
      },
      // Slack
      { name: 'Slack', slug: 'slack', verticalId: sfId, categoryId: catMap['slack'], sortOrder: 0 },
      // Experience Cloud
      {
        name: 'Experience Cloud',
        slug: 'experience-cloud',
        verticalId: sfId,
        categoryId: catMap['experience-cloud'],
        sortOrder: 0,
      },
      // Commerce Cloud
      {
        name: 'B2B Commerce',
        slug: 'b2b-commerce',
        verticalId: sfId,
        categoryId: catMap['commerce-cloud'],
        sortOrder: 0,
      },
      {
        name: 'B2C Commerce',
        slug: 'b2c-commerce',
        verticalId: sfId,
        categoryId: catMap['commerce-cloud'],
        sortOrder: 1,
      },
      {
        name: 'Order Management',
        slug: 'order-management',
        verticalId: sfId,
        categoryId: catMap['commerce-cloud'],
        sortOrder: 2,
      },
      // Platform
      {
        name: 'AppExchange',
        slug: 'appexchange',
        verticalId: sfId,
        categoryId: catMap['platform'],
        sortOrder: 0,
      },
      {
        name: 'Heroku',
        slug: 'heroku',
        verticalId: sfId,
        categoryId: catMap['platform'],
        sortOrder: 1,
      },
      {
        name: 'Hyperforce',
        slug: 'hyperforce',
        verticalId: sfId,
        categoryId: catMap['platform'],
        sortOrder: 2,
      },
      {
        name: 'Salesforce Platform',
        slug: 'salesforce-platform',
        verticalId: sfId,
        categoryId: catMap['platform'],
        sortOrder: 3,
      },
      {
        name: 'Security',
        slug: 'security',
        verticalId: sfId,
        categoryId: catMap['platform'],
        sortOrder: 4,
      },
      {
        name: 'Shield',
        slug: 'shield',
        verticalId: sfId,
        categoryId: catMap['platform'],
        sortOrder: 5,
      },
      // Tableau
      {
        name: 'CRM Analytics',
        slug: 'crm-analytics',
        verticalId: sfId,
        categoryId: catMap['tableau'],
        sortOrder: 0,
      },
      {
        name: 'Tableau',
        slug: 'tableau',
        verticalId: sfId,
        categoryId: catMap['tableau'],
        sortOrder: 1,
      },
      // Mulesoft
      {
        name: 'MuleSoft',
        slug: 'mulesoft',
        verticalId: sfId,
        categoryId: catMap['mulesoft'],
        sortOrder: 0,
      },
      // Industries
      {
        name: 'Communications Cloud',
        slug: 'communications-cloud',
        verticalId: sfId,
        categoryId: catMap['industries'],
        sortOrder: 0,
      },
      {
        name: 'Consumer Goods Cloud',
        slug: 'consumer-goods-cloud',
        verticalId: sfId,
        categoryId: catMap['industries'],
        sortOrder: 1,
      },
      {
        name: 'Education Cloud',
        slug: 'education-cloud',
        verticalId: sfId,
        categoryId: catMap['industries'],
        sortOrder: 2,
      },
      {
        name: 'Energy & Utilities Cloud',
        slug: 'energy-utilities-cloud',
        verticalId: sfId,
        categoryId: catMap['industries'],
        sortOrder: 3,
      },
      {
        name: 'Financial Services Cloud',
        slug: 'financial-services-cloud',
        verticalId: sfId,
        categoryId: catMap['industries'],
        sortOrder: 4,
      },
      {
        name: 'Government Cloud',
        slug: 'government-cloud',
        verticalId: sfId,
        categoryId: catMap['industries'],
        sortOrder: 5,
      },
      {
        name: 'Health Cloud',
        slug: 'health-cloud',
        verticalId: sfId,
        categoryId: catMap['industries'],
        sortOrder: 6,
      },
      {
        name: 'Manufacturing Cloud',
        slug: 'manufacturing-cloud',
        verticalId: sfId,
        categoryId: catMap['industries'],
        sortOrder: 7,
      },
      {
        name: 'Media Cloud',
        slug: 'media-cloud',
        verticalId: sfId,
        categoryId: catMap['industries'],
        sortOrder: 8,
      },
      {
        name: 'Nonprofit Cloud',
        slug: 'nonprofit-cloud',
        verticalId: sfId,
        categoryId: catMap['industries'],
        sortOrder: 9,
      },
      {
        name: 'OmniStudio',
        slug: 'omnistudio',
        verticalId: sfId,
        categoryId: catMap['industries'],
        sortOrder: 10,
      },
      // Net Zero Cloud
      {
        name: 'Net Zero Cloud',
        slug: 'net-zero-cloud',
        verticalId: sfId,
        categoryId: catMap['net-zero-cloud'],
        sortOrder: 0,
      },
    ])
    .onConflictDoNothing();

  // ──────────────────────────────────────────────
  // 5. Certification Categories
  // ──────────────────────────────────────────────
  console.log('  Seeding certification categories...');
  await db
    .insert(schema.certificationCategories)
    .values([
      { name: 'Associate', slug: 'associate', sortOrder: 0 },
      { name: 'Salesforce Administrator', slug: 'salesforce-administrator', sortOrder: 1 },
      { name: 'Salesforce Architect', slug: 'salesforce-architect', sortOrder: 2 },
      { name: 'Salesforce Consultant', slug: 'salesforce-consultant', sortOrder: 3 },
      { name: 'Salesforce Designer', slug: 'salesforce-designer', sortOrder: 4 },
      { name: 'Salesforce Developer', slug: 'salesforce-developer', sortOrder: 5 },
      { name: 'Salesforce Marketer', slug: 'salesforce-marketer', sortOrder: 6 },
      { name: 'Sales Professional', slug: 'sales-professional', sortOrder: 7 },
      { name: 'Tableau', slug: 'tableau', sortOrder: 8 },
    ])
    .onConflictDoNothing();

  const certCats = await db.select().from(schema.certificationCategories);
  const certCatMap = Object.fromEntries(certCats.map((c) => [c.slug, c.id]));

  // ──────────────────────────────────────────────
  // 6. Certifications
  // ──────────────────────────────────────────────
  console.log('  Seeding certifications...');
  await db
    .insert(schema.certifications)
    .values([
      // Associate
      {
        name: 'AI Associate',
        slug: 'ai-associate',
        verticalId: sfId,
        categoryId: certCatMap['associate'],
      },
      {
        name: 'Marketing Associate',
        slug: 'marketing-associate',
        verticalId: sfId,
        categoryId: certCatMap['associate'],
      },
      {
        name: 'Salesforce Associate',
        slug: 'salesforce-associate',
        verticalId: sfId,
        categoryId: certCatMap['associate'],
      },
      {
        name: 'MuleSoft Associate',
        slug: 'mulesoft-associate',
        verticalId: sfId,
        categoryId: certCatMap['associate'],
      },
      // Salesforce Administrator
      {
        name: 'Administrator',
        slug: 'administrator',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-administrator'],
      },
      {
        name: 'Advanced Administrator',
        slug: 'advanced-administrator',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-administrator'],
      },
      {
        name: 'AI Specialist',
        slug: 'ai-specialist-admin',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-administrator'],
      },
      {
        name: 'Business Analyst',
        slug: 'business-analyst-admin',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-administrator'],
      },
      {
        name: 'CPQ Specialist',
        slug: 'cpq-specialist',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-administrator'],
      },
      {
        name: 'Marketing Cloud Administrator',
        slug: 'marketing-cloud-administrator-admin',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-administrator'],
      },
      {
        name: 'Platform App Builder',
        slug: 'platform-app-builder-admin',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-administrator'],
      },
      {
        name: 'Slack Administrator',
        slug: 'slack-administrator',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-administrator'],
      },
      // Salesforce Architect
      {
        name: 'Application Architect',
        slug: 'application-architect',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-architect'],
      },
      {
        name: 'B2B Solution Architect',
        slug: 'b2b-solution-architect',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-architect'],
      },
      {
        name: 'B2C Commerce Architect',
        slug: 'b2c-commerce-architect',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-architect'],
      },
      {
        name: 'B2C Solution Architect',
        slug: 'b2c-solution-architect',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-architect'],
      },
      {
        name: 'Catalyst Specialist',
        slug: 'catalyst-specialist',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-architect'],
      },
      {
        name: 'Data Architect',
        slug: 'data-architect',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-architect'],
      },
      {
        name: 'Development Lifecycle and Deployment Architect',
        slug: 'devlifecycle-deployment-architect',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-architect'],
      },
      {
        name: 'Heroku Architect',
        slug: 'heroku-architect',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-architect'],
      },
      {
        name: 'Identity and Access Management Architect',
        slug: 'identity-access-management-architect',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-architect'],
      },
      {
        name: 'Integration Architect',
        slug: 'integration-architect',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-architect'],
      },
      {
        name: 'MuleSoft Integration Architect I',
        slug: 'mulesoft-integration-architect-i',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-architect'],
      },
      {
        name: 'MuleSoft Platform Architect I',
        slug: 'mulesoft-platform-architect-i',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-architect'],
      },
      {
        name: 'Sharing and Visibility Architect',
        slug: 'sharing-visibility-architect',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-architect'],
      },
      {
        name: 'System Architect',
        slug: 'system-architect',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-architect'],
      },
      {
        name: 'Technical Architect',
        slug: 'technical-architect',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-architect'],
      },
      {
        name: 'AI Specialist',
        slug: 'ai-specialist-architect',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-architect'],
      },
      // Salesforce Consultant
      {
        name: 'CRM Analytics and Einstein Discovery Consultant',
        slug: 'crm-analytics-einstein-discovery-consultant',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-consultant'],
      },
      {
        name: 'Data Cloud Consultant',
        slug: 'data-cloud-consultant',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-consultant'],
      },
      {
        name: 'Education Cloud Consultant',
        slug: 'education-cloud-consultant',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-consultant'],
      },
      {
        name: 'Experience Cloud Consultant',
        slug: 'experience-cloud-consultant',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-consultant'],
      },
      {
        name: 'Field Service Consultant',
        slug: 'field-service-consultant',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-consultant'],
      },
      {
        name: 'Nonprofit Cloud Consultant',
        slug: 'nonprofit-cloud-consultant',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-consultant'],
      },
      {
        name: 'OmniStudio Consultant',
        slug: 'omnistudio-consultant',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-consultant'],
      },
      {
        name: 'Sales Cloud Consultant',
        slug: 'sales-cloud-consultant',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-consultant'],
      },
      {
        name: 'Service Cloud Consultant',
        slug: 'service-cloud-consultant',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-consultant'],
      },
      {
        name: 'Slack Consultant',
        slug: 'slack-consultant',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-consultant'],
      },
      {
        name: 'Business Analyst',
        slug: 'business-analyst-consultant',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-consultant'],
      },
      {
        name: 'Marketing Cloud Account Engagement Consultant',
        slug: 'mc-account-engagement-consultant',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-consultant'],
      },
      // Salesforce Designer
      {
        name: 'Strategy Designer',
        slug: 'strategy-designer',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-designer'],
      },
      {
        name: 'User Experience (UX) Designer',
        slug: 'ux-designer',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-designer'],
      },
      // Salesforce Developer
      {
        name: 'B2C Commerce Developer',
        slug: 'b2c-commerce-developer',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-developer'],
      },
      {
        name: 'Hyperautomation Specialist',
        slug: 'hyperautomation-specialist',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-developer'],
      },
      {
        name: 'Industries CPQ Developer',
        slug: 'industries-cpq-developer',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-developer'],
      },
      {
        name: 'JavaScript Developer I',
        slug: 'javascript-developer-i',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-developer'],
      },
      {
        name: 'Marketing Cloud Developer',
        slug: 'marketing-cloud-developer-dev',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-developer'],
      },
      {
        name: 'MuleSoft Developer I',
        slug: 'mulesoft-developer-i',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-developer'],
      },
      {
        name: 'MuleSoft Developer II',
        slug: 'mulesoft-developer-ii',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-developer'],
      },
      {
        name: 'OmniStudio Developer',
        slug: 'omnistudio-developer',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-developer'],
      },
      {
        name: 'Platform Developer I',
        slug: 'platform-developer-i',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-developer'],
      },
      {
        name: 'Platform Developer II',
        slug: 'platform-developer-ii',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-developer'],
      },
      {
        name: 'Slack Developer',
        slug: 'slack-developer',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-developer'],
      },
      {
        name: 'AI Specialist',
        slug: 'ai-specialist-developer',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-developer'],
      },
      {
        name: 'Platform App Builder',
        slug: 'platform-app-builder-developer',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-developer'],
      },
      // Salesforce Marketer
      {
        name: 'Marketing Cloud Account Engagement Consultant',
        slug: 'mc-account-engagement-consultant-marketer',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-marketer'],
      },
      {
        name: 'Marketing Cloud Account Engagement Specialist',
        slug: 'mc-account-engagement-specialist',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-marketer'],
      },
      {
        name: 'Marketing Cloud Consultant',
        slug: 'marketing-cloud-consultant',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-marketer'],
      },
      {
        name: 'Marketing Cloud Email Specialist',
        slug: 'mc-email-specialist',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-marketer'],
      },
      {
        name: 'Marketing Cloud Administrator',
        slug: 'marketing-cloud-administrator-marketer',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-marketer'],
      },
      {
        name: 'Marketing Cloud Developer',
        slug: 'marketing-cloud-developer-marketer',
        verticalId: sfId,
        categoryId: certCatMap['salesforce-marketer'],
      },
      // Sales Professional
      {
        name: 'Sales Representative',
        slug: 'sales-representative',
        verticalId: sfId,
        categoryId: certCatMap['sales-professional'],
      },
      // Tableau
      {
        name: 'Tableau Desktop Specialist',
        slug: 'tableau-desktop-specialist',
        verticalId: sfId,
        categoryId: certCatMap['tableau'],
      },
      {
        name: 'Tableau Certified Data Analyst',
        slug: 'tableau-certified-data-analyst',
        verticalId: sfId,
        categoryId: certCatMap['tableau'],
      },
      {
        name: 'Tableau Server Certified Associate',
        slug: 'tableau-server-certified-associate',
        verticalId: sfId,
        categoryId: certCatMap['tableau'],
      },
      {
        name: 'Tableau Certified Consultant',
        slug: 'tableau-certified-consultant',
        verticalId: sfId,
        categoryId: certCatMap['tableau'],
      },
      {
        name: 'Tableau Certified Architect',
        slug: 'tableau-certified-architect',
        verticalId: sfId,
        categoryId: certCatMap['tableau'],
      },
    ])
    .onConflictDoNothing();

  // ──────────────────────────────────────────────
  // 7. Languages
  // ──────────────────────────────────────────────
  console.log('  Seeding languages...');
  await db
    .insert(schema.languages)
    .values([
      { name: 'English', code: 'en', flagEmoji: '\ud83c\uddec\ud83c\udde7', sortOrder: 0 },
      { name: 'French', code: 'fr', flagEmoji: '\ud83c\uddeb\ud83c\uddf7', sortOrder: 1 },
      { name: 'Spanish', code: 'es', flagEmoji: '\ud83c\uddea\ud83c\uddf8', sortOrder: 2 },
      { name: 'Italian', code: 'it', flagEmoji: '\ud83c\uddee\ud83c\uddf9', sortOrder: 3 },
      { name: 'German', code: 'de', flagEmoji: '\ud83c\udde9\ud83c\uddea', sortOrder: 4 },
      { name: 'Korean', code: 'ko', flagEmoji: '\ud83c\uddf0\ud83c\uddf7', sortOrder: 5 },
      { name: 'Chinese', code: 'zh', flagEmoji: '\ud83c\udde8\ud83c\uddf3', sortOrder: 6 },
      { name: 'Russian', code: 'ru', flagEmoji: '\ud83c\uddf7\ud83c\uddfa', sortOrder: 7 },
      { name: 'Japanese', code: 'ja', flagEmoji: '\ud83c\uddef\ud83c\uddf5', sortOrder: 8 },
      { name: 'Hindi', code: 'hi', flagEmoji: '\ud83c\uddee\ud83c\uddf3', sortOrder: 9 },
      { name: 'Danish', code: 'da', flagEmoji: '\ud83c\udde9\ud83c\uddf0', sortOrder: 10 },
      { name: 'Vietnamese', code: 'vi', flagEmoji: '\ud83c\uddfb\ud83c\uddf3', sortOrder: 11 },
      { name: 'Portuguese', code: 'pt', flagEmoji: '\ud83c\uddf5\ud83c\uddf9', sortOrder: 12 },
      { name: 'Polish', code: 'pl', flagEmoji: '\ud83c\uddf5\ud83c\uddf1', sortOrder: 13 },
      { name: 'Arabic', code: 'ar', flagEmoji: '\ud83c\uddf8\ud83c\udde6', sortOrder: 14 },
      { name: 'Filipino', code: 'fil', flagEmoji: '\ud83c\uddf5\ud83c\udded', sortOrder: 15 },
      { name: 'Turkish', code: 'tr', flagEmoji: '\ud83c\uddf9\ud83c\uddf7', sortOrder: 16 },
    ])
    .onConflictDoNothing();

  // ──────────────────────────────────────────────
  // 8. Industries
  // ──────────────────────────────────────────────
  console.log('  Seeding industries...');
  await db
    .insert(schema.industries)
    .values([
      { name: 'Agriculture & Mining', slug: 'agriculture-mining', sortOrder: 0 },
      { name: 'Automotive', slug: 'automotive', sortOrder: 1 },
      { name: 'Communications', slug: 'communications', sortOrder: 2 },
      { name: 'Consumer Goods', slug: 'consumer-goods', sortOrder: 3 },
      { name: 'Education', slug: 'education', sortOrder: 4 },
      { name: 'Energy & Utilities', slug: 'energy-utilities', sortOrder: 5 },
      { name: 'Engineering', slug: 'engineering', sortOrder: 6 },
      { name: 'Financial Services', slug: 'financial-services', sortOrder: 7 },
      { name: 'Healthcare & Life Sciences', slug: 'healthcare-life-sciences', sortOrder: 8 },
      { name: 'Manufacturing', slug: 'manufacturing', sortOrder: 9 },
      { name: 'Media & Entertainment', slug: 'media-entertainment', sortOrder: 10 },
      { name: 'Non-profit', slug: 'non-profit', sortOrder: 11 },
      { name: 'Professional Services', slug: 'professional-services', sortOrder: 12 },
      { name: 'Public Sector & Government', slug: 'public-sector-government', sortOrder: 13 },
      { name: 'Real Estate & Construction', slug: 'real-estate-construction', sortOrder: 14 },
      { name: 'Retail', slug: 'retail', sortOrder: 15 },
      { name: 'Technology', slug: 'technology', sortOrder: 16 },
      { name: 'Transportation', slug: 'transportation', sortOrder: 17 },
      { name: 'Travel & Hospitality', slug: 'travel-hospitality', sortOrder: 18 },
    ])
    .onConflictDoNothing();

  // ──────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────
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

try {
  await seed();
} catch (err) {
  console.error('Seed failed:', err);
  process.exit(1);
}
