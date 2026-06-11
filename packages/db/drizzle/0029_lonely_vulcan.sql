CREATE TYPE "public"."engagement_status" AS ENUM('active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."pricing_method" AS ENUM('fixed', 'tm');--> statement-breakpoint
CREATE TYPE "public"."proposal_cadence" AS ENUM('monthly', 'fortnightly');--> statement-breakpoint
CREATE TYPE "public"."proposal_change_section" AS ENUM('general', 'milestones', 'pricing', 'payment_terms', 'timeline');--> statement-breakpoint
CREATE TYPE "public"."proposal_document_kind" AS ENUM('terms', 'ref');--> statement-breakpoint
ALTER TYPE "public"."proposal_status" ADD VALUE 'draft';--> statement-breakpoint
ALTER TYPE "public"."proposal_status" ADD VALUE 'changes_requested';--> statement-breakpoint
ALTER TYPE "public"."proposal_status" ADD VALUE 'resubmitted';--> statement-breakpoint
CREATE TABLE "proposal_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"section" "proposal_change_section" DEFAULT 'general' NOT NULL,
	"note" text NOT NULL,
	"proposal_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "proposal_change_request_version_positive" CHECK ("proposal_change_requests"."proposal_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "proposal_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"kind" "proposal_document_kind" NOT NULL,
	"r2_key" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "proposal_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"title" text NOT NULL,
	"description_html" text,
	"acceptance_criteria" text,
	"value_cents" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "proposal_milestone_value_nonneg" CHECK ("proposal_milestones"."value_cents" IS NULL OR "proposal_milestones"."value_cents" >= 0),
	CONSTRAINT "proposal_milestone_sort_nonneg" CHECK ("proposal_milestones"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "proposal_payment_installments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"label" text NOT NULL,
	"pct" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "proposal_installment_pct_range" CHECK ("proposal_payment_installments"."pct" >= 0 AND "proposal_payment_installments"."pct" <= 100),
	CONSTRAINT "proposal_installment_sort_nonneg" CHECK ("proposal_payment_installments"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "engagements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"expert_profile_id" uuid NOT NULL,
	"source_proposal_id" uuid,
	"relationship_id" uuid,
	"project_request_id" uuid,
	"pricing_method" "pricing_method" NOT NULL,
	"price_cents" integer NOT NULL,
	"currency" text DEFAULT 'aud' NOT NULL,
	"deposit_cents" integer,
	"rate_cents" integer,
	"cadence" "proposal_cadence",
	"billing_model" text DEFAULT 'proposal' NOT NULL,
	"approval_model" text DEFAULT 'admin_invoice' NOT NULL,
	"status" "engagement_status" DEFAULT 'active' NOT NULL,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "engagement_price_cents_nonneg" CHECK ("engagements"."price_cents" >= 0),
	CONSTRAINT "engagement_deposit_cents_nonneg" CHECK ("engagements"."deposit_cents" IS NULL OR "engagements"."deposit_cents" >= 0),
	CONSTRAINT "engagement_rate_cents_nonneg" CHECK ("engagements"."rate_cents" IS NULL OR "engagements"."rate_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "pricing_method" "pricing_method" DEFAULT 'fixed' NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "is_current" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "overview" text NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "exclusions" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "timeframe_weeks" integer;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "deposit_cents" integer;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "rate_cents" integer;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "cadence" "proposal_cadence";--> statement-breakpoint
ALTER TABLE "proposal_change_requests" ADD CONSTRAINT "proposal_change_requests_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_change_requests" ADD CONSTRAINT "proposal_change_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_documents" ADD CONSTRAINT "proposal_documents_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_documents" ADD CONSTRAINT "proposal_documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_milestones" ADD CONSTRAINT "proposal_milestones_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_payment_installments" ADD CONSTRAINT "proposal_payment_installments_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_expert_profile_id_expert_profiles_id_fk" FOREIGN KEY ("expert_profile_id") REFERENCES "public"."expert_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_source_proposal_id_proposals_id_fk" FOREIGN KEY ("source_proposal_id") REFERENCES "public"."proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_relationship_id_request_expert_relationships_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."request_expert_relationships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_project_request_id_project_requests_id_fk" FOREIGN KEY ("project_request_id") REFERENCES "public"."project_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposal_change_request_proposal_idx" ON "proposal_change_requests" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "proposal_change_request_requested_by_idx" ON "proposal_change_requests" USING btree ("requested_by_user_id");--> statement-breakpoint
CREATE INDEX "proposal_change_request_created_idx" ON "proposal_change_requests" USING btree ("proposal_id","created_at") WHERE "proposal_change_requests"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_document_key_idx" ON "proposal_documents" USING btree ("r2_key");--> statement-breakpoint
CREATE INDEX "proposal_document_proposal_idx" ON "proposal_documents" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "proposal_document_uploaded_by_idx" ON "proposal_documents" USING btree ("uploaded_by_user_id");--> statement-breakpoint
CREATE INDEX "proposal_milestone_proposal_idx" ON "proposal_milestones" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "proposal_milestone_order_idx" ON "proposal_milestones" USING btree ("proposal_id","sort_order") WHERE "proposal_milestones"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "proposal_installment_proposal_idx" ON "proposal_payment_installments" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "proposal_installment_order_idx" ON "proposal_payment_installments" USING btree ("proposal_id","sort_order") WHERE "proposal_payment_installments"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "engagement_company_idx" ON "engagements" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "engagement_expert_idx" ON "engagements" USING btree ("expert_profile_id");--> statement-breakpoint
CREATE INDEX "engagement_source_proposal_idx" ON "engagements" USING btree ("source_proposal_id");--> statement-breakpoint
CREATE INDEX "engagement_relationship_idx" ON "engagements" USING btree ("relationship_id");--> statement-breakpoint
CREATE INDEX "engagement_request_idx" ON "engagements" USING btree ("project_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_current_per_relationship_idx" ON "proposals" USING btree ("relationship_id") WHERE "proposals"."deleted_at" IS NULL AND "proposals"."is_current";--> statement-breakpoint
ALTER TABLE "proposals" DROP COLUMN "scope";--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposal_version_positive" CHECK ("proposals"."version" >= 1);--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposal_deposit_cents_nonneg" CHECK ("proposals"."deposit_cents" IS NULL OR "proposals"."deposit_cents" >= 0);--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposal_rate_cents_nonneg" CHECK ("proposals"."rate_cents" IS NULL OR "proposals"."rate_cents" >= 0);--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposal_timeframe_positive" CHECK ("proposals"."timeframe_weeks" IS NULL OR "proposals"."timeframe_weeks" >= 1);