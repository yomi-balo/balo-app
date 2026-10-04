/**
 * The Salesforce vertical's product taxonomy as seed data — the ONE source both `seed.ts` (fresh
 * environments) and migration 0105 (existing environments, via `renderProductAliasSeedSql`) read.
 *
 * Its own module, rather than constants inside `seed.ts`, because `seed.ts` opens a database
 * connection at import time: tests need the product names, slugs and aliases without one.
 *
 * Not exported from `@balo/db`'s index — seed data, not an application API.
 */

/** [categoryName, categorySlug, productNames[]] */
export const PRODUCT_CATEGORIES: Array<[string, string, string[]]> = [
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
 * BAL-592 — one product's aliases and prompt hint. `features` become `product_aliases` rows of
 * kind `feature` ("includes"), `altNames` rows of kind `alt_name` ("also called"); `hint` becomes
 * `products.ai_hint`. Absent `hint` leaves the column untouched.
 */
export interface ProductAliasSeed {
  readonly hint?: string;
  readonly features: readonly string[];
  readonly altNames: readonly string[];
}

/**
 * BAL-592 — the Salesforce product aliases and hints, keyed by product slug (`slugify` of a
 * `PRODUCT_CATEGORIES` name).
 *
 * Integrity rules, all pinned by `salesforce-taxonomy.test.ts`: every key is a seeded product
 * slug; under `normalizeTaxonomyLabel` no alias collides with another alias or with any product
 * name; every alias and hint satisfies its CHECK. Deliberately NOT seeded: "Salesforce X" variants
 * (the normaliser strips the prefix, so they would collide with the bare name); Revenue Cloud,
 * Salesforce Billing and Life Sciences Cloud (taxonomy gaps — they should keep surfacing in the
 * unmatched footnote); "Agentforce Marketing" (ambiguous between products).
 *
 * ⚠ Migration 0105 embeds this constant rendered as SQL. An alias change ships as a NEW migration
 * carrying the delta, and re-points the comparison in
 * `invariants/product-alias-migration-matches-the-seed-constant.test.ts`; an applied migration is
 * never edited.
 */
export const SALESFORCE_PRODUCT_ALIASES: Readonly<Record<string, ProductAliasSeed>> = {
  agentforce: {
    features: [
      'Agent Builder',
      'Prompt Builder',
      'Atlas Reasoning Engine',
      'Einstein Trust Layer',
      'Agentforce Voice',
    ],
    altNames: ['Einstein Copilot', 'Einstein GPT'],
    hint: 'AI agents. Select only when the work is building, configuring or deploying AI agents — not for clouds renamed with an "Agentforce" prefix.',
  },
  'data-cloud': {
    features: ['Identity Resolution', 'Calculated Insights', 'Data Streams', 'Zero Copy'],
    altNames: [
      'Data 360',
      'Salesforce CDP',
      'Customer Data Platform',
      'Customer 360 Audiences',
      'Salesforce Genie',
      'Marketing Cloud Customer Data Platform',
    ],
  },
  'sales-cloud': {
    features: [
      'Sales Engagement',
      'High Velocity Sales',
      'Sales Dialer',
      'Lightning Dialer',
      'Pipeline Inspection',
      'Collaborative Forecasting',
      'Enterprise Territory Management',
    ],
    altNames: ['Agentforce Sales'],
  },
  cpq: {
    features: [],
    altNames: ['Steelbrick', 'Steelbrick CPQ'],
  },
  'service-cloud': {
    features: ['Omni-Channel', 'Salesforce Knowledge', 'Service Console', 'Entitlements'],
    altNames: ['Agentforce Service'],
  },
  'digital-engagement': {
    features: ['Messaging', 'Messaging for In-App and Web', 'Enhanced Chat', 'Embedded Service'],
    altNames: ['Live Agent', 'LiveMessage', 'Service Cloud Digital Engagement'],
  },
  'field-service': {
    features: ['Dispatcher Console', 'Field Service Mobile'],
    altNames: ['Field Service Lightning', 'FSL', 'ClickSoftware'],
  },
  voice: {
    features: ['Open CTI', 'Amazon Connect', 'Partner Telephony'],
    altNames: ['Service Cloud Voice'],
    hint: 'Contact-centre telephony integrated with Service Cloud.',
  },
  'account-engagement': {
    features: ['Engagement Studio', 'B2B Marketing Analytics'],
    altNames: ['Pardot', 'Marketing Cloud Account Engagement', 'MCAE'],
  },
  engagement: {
    features: [
      'Journey Builder',
      'Email Studio',
      'Mobile Studio',
      'MobileConnect',
      'MobilePush',
      'Automation Studio',
      'Contact Builder',
      'Content Builder',
      'Advertising Studio',
      'CloudPages',
      'AMPscript',
    ],
    altNames: ['Marketing Cloud Engagement', 'ExactTarget', 'SFMC', 'MCE', 'Marketing Cloud'],
    hint: 'Marketing Cloud Engagement: email, SMS and push messaging and journeys.',
  },
  intelligence: {
    features: [],
    altNames: ['Marketing Cloud Intelligence', 'Datorama'],
    hint: 'Marketing Cloud Intelligence: cross-channel marketing performance analytics.',
  },
  personalisation: {
    features: [],
    altNames: [
      'Marketing Cloud Personalization',
      'Personalization',
      'Interaction Studio',
      'Evergage',
    ],
    hint: 'Marketing Cloud Personalization: real-time web and app personalisation.',
  },
  'loyalty-management': {
    features: [],
    altNames: [],
    hint: 'Loyalty programmes: members, tiers, points and vouchers.',
  },
  slack: {
    features: ['Slack Connect', 'Slack Workflow Builder'],
    altNames: [],
  },
  'experience-cloud': {
    features: [
      'Experience Builder',
      'Customer Portal',
      'Partner Portal',
      'Partner Relationship Management',
    ],
    altNames: ['Community Cloud', 'Communities'],
  },
  'b2b-commerce': {
    features: [],
    altNames: ['CloudCraze', 'B2B Commerce on Lightning'],
  },
  'b2c-commerce': {
    features: [
      'SFRA',
      'Storefront Reference Architecture',
      'PWA Kit',
      'Composable Storefront',
      'Business Manager',
    ],
    altNames: ['Demandware', 'SFCC', 'Commerce Cloud Digital', 'Commerce Cloud'],
  },
  'order-management': {
    features: [],
    altNames: ['SOM'],
  },
  'salesforce-platform': {
    features: [
      'Apex',
      'Lightning Web Components',
      'LWC',
      'Visualforce',
      'Flow',
      'Flow Builder',
      'Process Builder',
      'Workflow Rules',
      'Lightning App Builder',
      'Platform Events',
      'SOQL',
      'Salesforce DX',
      'DevOps Center',
    ],
    altNames: ['Force.com', 'Lightning Platform'],
  },
  appexchange: {
    features: [],
    altNames: [],
    hint: 'Building, packaging or listing an AppExchange app (ISV work).',
  },
  heroku: {
    features: ['Heroku Connect', 'Heroku Postgres'],
    altNames: [],
  },
  hyperforce: {
    features: [],
    altNames: [],
    hint: "Salesforce's public-cloud infrastructure: Hyperforce migrations and data residency.",
  },
  security: {
    features: ['Security Center', 'Privacy Center', 'Backup and Recover'],
    altNames: [],
    hint: 'Org security posture: Security Center, Privacy Center, backup and recovery, access reviews.',
  },
  shield: {
    features: [
      'Platform Encryption',
      'Shield Platform Encryption',
      'Event Monitoring',
      'Field Audit Trail',
      'Data Detect',
    ],
    altNames: [],
  },
  'crm-analytics': {
    features: ['Einstein Discovery'],
    altNames: ['Tableau CRM', 'Einstein Analytics', 'Analytics Cloud', 'Wave Analytics'],
  },
  tableau: {
    features: [
      'Tableau Desktop',
      'Tableau Server',
      'Tableau Cloud',
      'Tableau Prep',
      'Tableau Pulse',
    ],
    altNames: ['Tableau Online'],
  },
  mulesoft: {
    features: [
      'Anypoint Platform',
      'Anypoint',
      'Mule ESB',
      'DataWeave',
      'MuleSoft Composer',
      'MuleSoft RPA',
    ],
    altNames: [],
  },
  'communications-cloud': {
    features: [],
    altNames: ['Vlocity Communications'],
  },
  'consumer-goods-cloud': {
    features: ['Retail Execution'],
    altNames: [],
  },
  'education-cloud': {
    features: [],
    altNames: ['Education Data Architecture', 'EDA', 'HEDA'],
  },
  'energy-utilities-cloud': {
    features: [],
    altNames: ['Vlocity Energy and Utilities'],
  },
  'financial-services-cloud': {
    features: [],
    altNames: ['FSC', 'Vlocity Insurance'],
  },
  'government-cloud': {
    features: [],
    altNames: ['Government Cloud Plus', 'Public Sector Solutions', 'Vlocity Public Sector'],
  },
  'health-cloud': {
    features: [],
    altNames: ['Vlocity Health'],
  },
  'manufacturing-cloud': {
    features: ['Sales Agreements'],
    altNames: [],
  },
  'media-cloud': {
    features: ['Advertising Sales Management'],
    altNames: ['Vlocity Media'],
  },
  'nonprofit-cloud': {
    features: ['Program Management Module', 'PMM'],
    altNames: ['NPSP', 'Nonprofit Success Pack'],
  },
  omnistudio: {
    features: ['OmniScript', 'FlexCards', 'DataRaptor', 'Data Mapper', 'Integration Procedures'],
    altNames: ['Vlocity'],
  },
  'net-zero-cloud': {
    features: [],
    altNames: ['Sustainability Cloud'],
  },
};
