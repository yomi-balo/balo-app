-- BAL-592 — `product_aliases` + `products.ai_hint`, and the Salesforce alias/hint seed.
--
-- HAND-EDITED after `drizzle-kit generate` (precedent for an explanatory header on generated
-- SQL: 0056_bal418_meetings_primitive.sql, 0064_bal132_lobby_self_claim.sql). The snapshot is
-- untouched. Two edits:
--
--   1. STATEMENT ORDER. drizzle-kit emits `products`' `product_id_vertical_uq` UNIQUE AFTER the
--      composite FK that references it, and Postgres refuses an FK whose target columns carry no
--      unique constraint yet (42830). The UNIQUE statement was moved, unmodified, to just before
--      the FK. It is always satisfiable: `products.id` alone is already the primary key.
--
--   2. THE SEED, APPENDED after the generated statements. It is the verbatim output of
--      `renderProductAliasSeedSql('salesforce', SALESFORCE_PRODUCT_ALIASES)`
--      (`src/reference-data/taxonomy-seed.ts` + `salesforce-taxonomy.ts`), pinned by
--      `src/invariants/product-alias-migration-matches-the-seed-constant.test.ts`. Product ids
--      are resolved by slug within the `salesforce` vertical — never hardcoded. On a FRESH
--      database products do not exist yet, so both statements match no row and are no-ops by
--      design; `seed.ts` seeds those environments from the same constant. On an environment whose
--      products already exist they insert the aliases (`ON CONFLICT DO NOTHING`) and set the hints.
CREATE TYPE "public"."product_alias_kind" AS ENUM('feature', 'alt_name');--> statement-breakpoint
CREATE TABLE "product_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"vertical_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"kind" "product_alias_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "product_alias_shape" CHECK (char_length("product_aliases"."alias") BETWEEN 1 AND 80 AND strpos("product_aliases"."alias", '<') = 0 AND strpos("product_aliases"."alias", '>') = 0 AND strpos("product_aliases"."alias", chr(10)) = 0 AND strpos("product_aliases"."alias", chr(13)) = 0)
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "ai_hint" text;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "product_id_vertical_uq" UNIQUE("id","vertical_id");--> statement-breakpoint
ALTER TABLE "product_aliases" ADD CONSTRAINT "product_alias_product_vertical_fk" FOREIGN KEY ("product_id","vertical_id") REFERENCES "public"."products"("id","vertical_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_alias_vertical_alias_unique_idx" ON "product_aliases" USING btree ("vertical_id",lower("alias")) WHERE "product_aliases"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "product_alias_product_id_idx" ON "product_aliases" USING btree ("product_id");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "product_ai_hint_shape" CHECK ("products"."ai_hint" IS NULL OR (char_length("products"."ai_hint") BETWEEN 1 AND 240 AND strpos("products"."ai_hint", '<') = 0 AND strpos("products"."ai_hint", '>') = 0 AND strpos("products"."ai_hint", chr(10)) = 0 AND strpos("products"."ai_hint", chr(13)) = 0));--> statement-breakpoint
INSERT INTO "product_aliases" ("product_id", "vertical_id", "alias", "kind")
SELECT p."id", p."vertical_id", v.alias, v.kind::"product_alias_kind"
FROM (VALUES
  ('agentforce', 'Agent Builder', 'feature'),
  ('agentforce', 'Prompt Builder', 'feature'),
  ('agentforce', 'Atlas Reasoning Engine', 'feature'),
  ('agentforce', 'Einstein Trust Layer', 'feature'),
  ('agentforce', 'Agentforce Voice', 'feature'),
  ('agentforce', 'Einstein Copilot', 'alt_name'),
  ('agentforce', 'Einstein GPT', 'alt_name'),
  ('data-cloud', 'Identity Resolution', 'feature'),
  ('data-cloud', 'Calculated Insights', 'feature'),
  ('data-cloud', 'Data Streams', 'feature'),
  ('data-cloud', 'Zero Copy', 'feature'),
  ('data-cloud', 'Data 360', 'alt_name'),
  ('data-cloud', 'Salesforce CDP', 'alt_name'),
  ('data-cloud', 'Customer Data Platform', 'alt_name'),
  ('data-cloud', 'Customer 360 Audiences', 'alt_name'),
  ('data-cloud', 'Salesforce Genie', 'alt_name'),
  ('data-cloud', 'Marketing Cloud Customer Data Platform', 'alt_name'),
  ('sales-cloud', 'Sales Engagement', 'feature'),
  ('sales-cloud', 'High Velocity Sales', 'feature'),
  ('sales-cloud', 'Sales Dialer', 'feature'),
  ('sales-cloud', 'Lightning Dialer', 'feature'),
  ('sales-cloud', 'Pipeline Inspection', 'feature'),
  ('sales-cloud', 'Collaborative Forecasting', 'feature'),
  ('sales-cloud', 'Enterprise Territory Management', 'feature'),
  ('sales-cloud', 'Agentforce Sales', 'alt_name'),
  ('cpq', 'Steelbrick', 'alt_name'),
  ('cpq', 'Steelbrick CPQ', 'alt_name'),
  ('service-cloud', 'Omni-Channel', 'feature'),
  ('service-cloud', 'Salesforce Knowledge', 'feature'),
  ('service-cloud', 'Service Console', 'feature'),
  ('service-cloud', 'Entitlements', 'feature'),
  ('service-cloud', 'Agentforce Service', 'alt_name'),
  ('digital-engagement', 'Messaging', 'feature'),
  ('digital-engagement', 'Messaging for In-App and Web', 'feature'),
  ('digital-engagement', 'Enhanced Chat', 'feature'),
  ('digital-engagement', 'Embedded Service', 'feature'),
  ('digital-engagement', 'Live Agent', 'alt_name'),
  ('digital-engagement', 'LiveMessage', 'alt_name'),
  ('digital-engagement', 'Service Cloud Digital Engagement', 'alt_name'),
  ('field-service', 'Dispatcher Console', 'feature'),
  ('field-service', 'Field Service Mobile', 'feature'),
  ('field-service', 'Field Service Lightning', 'alt_name'),
  ('field-service', 'FSL', 'alt_name'),
  ('field-service', 'ClickSoftware', 'alt_name'),
  ('voice', 'Open CTI', 'feature'),
  ('voice', 'Amazon Connect', 'feature'),
  ('voice', 'Partner Telephony', 'feature'),
  ('voice', 'Service Cloud Voice', 'alt_name'),
  ('account-engagement', 'Engagement Studio', 'feature'),
  ('account-engagement', 'B2B Marketing Analytics', 'feature'),
  ('account-engagement', 'Pardot', 'alt_name'),
  ('account-engagement', 'Marketing Cloud Account Engagement', 'alt_name'),
  ('account-engagement', 'MCAE', 'alt_name'),
  ('engagement', 'Journey Builder', 'feature'),
  ('engagement', 'Email Studio', 'feature'),
  ('engagement', 'Mobile Studio', 'feature'),
  ('engagement', 'MobileConnect', 'feature'),
  ('engagement', 'MobilePush', 'feature'),
  ('engagement', 'Automation Studio', 'feature'),
  ('engagement', 'Contact Builder', 'feature'),
  ('engagement', 'Content Builder', 'feature'),
  ('engagement', 'Advertising Studio', 'feature'),
  ('engagement', 'CloudPages', 'feature'),
  ('engagement', 'AMPscript', 'feature'),
  ('engagement', 'Marketing Cloud Engagement', 'alt_name'),
  ('engagement', 'ExactTarget', 'alt_name'),
  ('engagement', 'SFMC', 'alt_name'),
  ('engagement', 'MCE', 'alt_name'),
  ('engagement', 'Marketing Cloud', 'alt_name'),
  ('intelligence', 'Marketing Cloud Intelligence', 'alt_name'),
  ('intelligence', 'Datorama', 'alt_name'),
  ('personalisation', 'Marketing Cloud Personalization', 'alt_name'),
  ('personalisation', 'Personalization', 'alt_name'),
  ('personalisation', 'Interaction Studio', 'alt_name'),
  ('personalisation', 'Evergage', 'alt_name'),
  ('slack', 'Slack Connect', 'feature'),
  ('slack', 'Slack Workflow Builder', 'feature'),
  ('experience-cloud', 'Experience Builder', 'feature'),
  ('experience-cloud', 'Customer Portal', 'feature'),
  ('experience-cloud', 'Partner Portal', 'feature'),
  ('experience-cloud', 'Partner Relationship Management', 'feature'),
  ('experience-cloud', 'Community Cloud', 'alt_name'),
  ('experience-cloud', 'Communities', 'alt_name'),
  ('b2b-commerce', 'CloudCraze', 'alt_name'),
  ('b2b-commerce', 'B2B Commerce on Lightning', 'alt_name'),
  ('b2c-commerce', 'SFRA', 'feature'),
  ('b2c-commerce', 'Storefront Reference Architecture', 'feature'),
  ('b2c-commerce', 'PWA Kit', 'feature'),
  ('b2c-commerce', 'Composable Storefront', 'feature'),
  ('b2c-commerce', 'Business Manager', 'feature'),
  ('b2c-commerce', 'Demandware', 'alt_name'),
  ('b2c-commerce', 'SFCC', 'alt_name'),
  ('b2c-commerce', 'Commerce Cloud Digital', 'alt_name'),
  ('b2c-commerce', 'Commerce Cloud', 'alt_name'),
  ('order-management', 'SOM', 'alt_name'),
  ('salesforce-platform', 'Apex', 'feature'),
  ('salesforce-platform', 'Lightning Web Components', 'feature'),
  ('salesforce-platform', 'LWC', 'feature'),
  ('salesforce-platform', 'Visualforce', 'feature'),
  ('salesforce-platform', 'Flow', 'feature'),
  ('salesforce-platform', 'Flow Builder', 'feature'),
  ('salesforce-platform', 'Process Builder', 'feature'),
  ('salesforce-platform', 'Workflow Rules', 'feature'),
  ('salesforce-platform', 'Lightning App Builder', 'feature'),
  ('salesforce-platform', 'Platform Events', 'feature'),
  ('salesforce-platform', 'SOQL', 'feature'),
  ('salesforce-platform', 'Salesforce DX', 'feature'),
  ('salesforce-platform', 'DevOps Center', 'feature'),
  ('salesforce-platform', 'Force.com', 'alt_name'),
  ('salesforce-platform', 'Lightning Platform', 'alt_name'),
  ('heroku', 'Heroku Connect', 'feature'),
  ('heroku', 'Heroku Postgres', 'feature'),
  ('security', 'Security Center', 'feature'),
  ('security', 'Privacy Center', 'feature'),
  ('security', 'Backup and Recover', 'feature'),
  ('shield', 'Platform Encryption', 'feature'),
  ('shield', 'Shield Platform Encryption', 'feature'),
  ('shield', 'Event Monitoring', 'feature'),
  ('shield', 'Field Audit Trail', 'feature'),
  ('shield', 'Data Detect', 'feature'),
  ('crm-analytics', 'Einstein Discovery', 'feature'),
  ('crm-analytics', 'Tableau CRM', 'alt_name'),
  ('crm-analytics', 'Einstein Analytics', 'alt_name'),
  ('crm-analytics', 'Analytics Cloud', 'alt_name'),
  ('crm-analytics', 'Wave Analytics', 'alt_name'),
  ('tableau', 'Tableau Desktop', 'feature'),
  ('tableau', 'Tableau Server', 'feature'),
  ('tableau', 'Tableau Cloud', 'feature'),
  ('tableau', 'Tableau Prep', 'feature'),
  ('tableau', 'Tableau Pulse', 'feature'),
  ('tableau', 'Tableau Online', 'alt_name'),
  ('mulesoft', 'Anypoint Platform', 'feature'),
  ('mulesoft', 'Anypoint', 'feature'),
  ('mulesoft', 'Mule ESB', 'feature'),
  ('mulesoft', 'DataWeave', 'feature'),
  ('mulesoft', 'MuleSoft Composer', 'feature'),
  ('mulesoft', 'MuleSoft RPA', 'feature'),
  ('communications-cloud', 'Vlocity Communications', 'alt_name'),
  ('consumer-goods-cloud', 'Retail Execution', 'feature'),
  ('education-cloud', 'Education Data Architecture', 'alt_name'),
  ('education-cloud', 'EDA', 'alt_name'),
  ('education-cloud', 'HEDA', 'alt_name'),
  ('energy-utilities-cloud', 'Vlocity Energy and Utilities', 'alt_name'),
  ('financial-services-cloud', 'FSC', 'alt_name'),
  ('financial-services-cloud', 'Vlocity Insurance', 'alt_name'),
  ('government-cloud', 'Government Cloud Plus', 'alt_name'),
  ('government-cloud', 'Public Sector Solutions', 'alt_name'),
  ('government-cloud', 'Vlocity Public Sector', 'alt_name'),
  ('health-cloud', 'Vlocity Health', 'alt_name'),
  ('manufacturing-cloud', 'Sales Agreements', 'feature'),
  ('media-cloud', 'Advertising Sales Management', 'feature'),
  ('media-cloud', 'Vlocity Media', 'alt_name'),
  ('nonprofit-cloud', 'Program Management Module', 'feature'),
  ('nonprofit-cloud', 'PMM', 'feature'),
  ('nonprofit-cloud', 'NPSP', 'alt_name'),
  ('nonprofit-cloud', 'Nonprofit Success Pack', 'alt_name'),
  ('omnistudio', 'OmniScript', 'feature'),
  ('omnistudio', 'FlexCards', 'feature'),
  ('omnistudio', 'DataRaptor', 'feature'),
  ('omnistudio', 'Data Mapper', 'feature'),
  ('omnistudio', 'Integration Procedures', 'feature'),
  ('omnistudio', 'Vlocity', 'alt_name'),
  ('net-zero-cloud', 'Sustainability Cloud', 'alt_name')
) AS v(slug, alias, kind)
JOIN "products" p ON p."slug" = v.slug
JOIN "verticals" vt ON vt."id" = p."vertical_id" AND vt."slug" = 'salesforce'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "products" p SET "ai_hint" = v.hint
FROM (VALUES
  ('agentforce', 'AI agents. Select only when the work is building, configuring or deploying AI agents — not for clouds renamed with an "Agentforce" prefix.'),
  ('voice', 'Contact-centre telephony integrated with Service Cloud.'),
  ('engagement', 'Marketing Cloud Engagement: email, SMS and push messaging and journeys.'),
  ('intelligence', 'Marketing Cloud Intelligence: cross-channel marketing performance analytics.'),
  ('personalisation', 'Marketing Cloud Personalization: real-time web and app personalisation.'),
  ('loyalty-management', 'Loyalty programmes: members, tiers, points and vouchers.'),
  ('appexchange', 'Building, packaging or listing an AppExchange app (ISV work).'),
  ('hyperforce', 'Salesforce''s public-cloud infrastructure: Hyperforce migrations and data residency.'),
  ('security', 'Org security posture: Security Center, Privacy Center, backup and recovery, access reviews.')
) AS v(slug, hint), "verticals" vt
WHERE p."slug" = v.slug AND vt."id" = p."vertical_id" AND vt."slug" = 'salesforce';
