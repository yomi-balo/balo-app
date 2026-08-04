-- BAL-417 / ADR-1045 §1 — engagements becomes a SUPERTYPE.
--
-- THIS FILE WAS HAND-EDITED after `drizzle-kit generate`. Three deviations from the
-- generated output, all required for it to apply at all (precedent for hand-edited
-- generated enum SQL with an explanatory header: 0022_even_ozymandias.sql,
-- 0030_heavy_kang.sql):
--
--   1. `ALTER TABLE "engagements" ADD CONSTRAINT "engagement_id_type_uq" UNIQUE(...)`
--      was MOVED UP, ahead of the two composite FKs that reference it
--      (`project_engagement_parent_type_fk`, `case_engagement_parent_type_fk`).
--      Drizzle emitted it AFTER them, which fails: Postgres requires the referenced
--      unique constraint to exist before a FK can target it.
--
--   2. THE ENUM SHRINK was REWRITTEN. Drizzle emits
--      SET DATA TYPE text → DROP TYPE → CREATE TYPE → SET DATA TYPE enum, which FAILS
--      on an EMPTY database with `2BP01: cannot drop type engagement_status because
--      other objects depend on it — default value for column status ...`. It never
--      drops the column DEFAULT, and `SET DATA TYPE text` does not rewrite it. The
--      DROP DEFAULT / SET DEFAULT pair below is what fixes it.
--
--   3. `CREATE INDEX "engagement_type_status_created_idx"` was MOVED to the END, after
--      the enum shrink. It indexes `status`, whose type the shrink changes twice;
--      creating it first would force two index rebuilds through a partial predicate
--      for no benefit.
--
-- There is deliberately NO DATA MIGRATION here — no `INSERT INTO project_engagements
-- … SELECT`, no interim `DEFAULT 'project'` on `engagement_type`, no
-- `UPDATE … SET status='active' WHERE status='pending_acceptance'`. Pre-launch, no
-- live data (D6): the ONLY apply target is an EMPTY database (the integration
-- testcontainer via postgres-js `migrate()`, and the E2E job's `drizzle-kit migrate`
-- against a fresh service container). A database that already holds `engagements` rows
-- fails LOUDLY — `23502` on the NOT NULL `engagement_type` add, or `22P02` on the
-- USING cast for a surviving `pending_acceptance` row. That is the intended outcome;
-- the fix is to reset that database (`DELETE FROM engagements;`), not to soften this
-- migration.
--
-- The trailing `SET DEFAULT 'active'` needs no `::text::` cast — `engagement_status`
-- is CREATE TYPE'd in this same transaction, so its labels are immediately usable (the
-- ADD-VALUE hazard applies only to `ALTER TYPE … ADD VALUE`, not to a standalone
-- CREATE TYPE). The same reasoning covers `case_close_reason` inside
-- `case_engagement_close_coherent` and `engagement_type` inside the two child CHECKs.
CREATE TYPE "public"."case_close_reason" AS ENUM('resolved', 'auto_inactive');--> statement-breakpoint
CREATE TYPE "public"."engagement_type" AS ENUM('case', 'project', 'package', 'retainer');--> statement-breakpoint
CREATE TYPE "public"."project_delivery_status" AS ENUM('active', 'pending_acceptance', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "project_engagements" (
	"engagement_id" uuid PRIMARY KEY NOT NULL,
	"engagement_type" "engagement_type" DEFAULT 'project' NOT NULL,
	"delivery_status" "project_delivery_status" DEFAULT 'active' NOT NULL,
	"source_proposal_id" uuid,
	"relationship_id" uuid,
	"project_request_id" uuid,
	"pricing_method" "pricing_method" NOT NULL,
	"price_cents" integer NOT NULL,
	"deposit_cents" integer,
	"rate_cents" integer,
	"cadence" "proposal_cadence",
	"billing_model" text DEFAULT 'proposal' NOT NULL,
	"approval_model" text DEFAULT 'admin_invoice' NOT NULL,
	"completion_requested_by_user_id" uuid,
	"completion_requested_at" timestamp with time zone,
	"accepted_by_user_id" uuid,
	"accepted_at" timestamp with time zone,
	"acceptance_method" "engagement_acceptance_method",
	"change_request_note" text,
	"change_requested_by_user_id" uuid,
	"change_requested_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "project_engagement_type_is_project" CHECK ("project_engagements"."engagement_type" = 'project'),
	CONSTRAINT "project_engagement_price_cents_nonneg" CHECK ("project_engagements"."price_cents" >= 0),
	CONSTRAINT "project_engagement_deposit_cents_nonneg" CHECK ("project_engagements"."deposit_cents" IS NULL OR "project_engagements"."deposit_cents" >= 0),
	CONSTRAINT "project_engagement_rate_cents_nonneg" CHECK ("project_engagements"."rate_cents" IS NULL OR "project_engagements"."rate_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "case_engagements" (
	"engagement_id" uuid PRIMARY KEY NOT NULL,
	"engagement_type" "engagement_type" DEFAULT 'case' NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by_user_id" uuid,
	"close_reason" "case_close_reason",
	"resolution_requested_at" timestamp with time zone,
	"resolution_requested_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "case_engagement_type_is_case" CHECK ("case_engagements"."engagement_type" = 'case'),
	CONSTRAINT "case_engagement_title_nonempty" CHECK (length(btrim("case_engagements"."title")) > 0),
	CONSTRAINT "case_engagement_description_nonempty" CHECK (length(btrim("case_engagements"."description")) > 0),
	CONSTRAINT "case_engagement_close_coherent" CHECK (("case_engagements"."closed_at" IS NULL AND "case_engagements"."close_reason" IS NULL AND "case_engagements"."closed_by_user_id" IS NULL)
        OR ("case_engagements"."closed_at" IS NOT NULL AND "case_engagements"."close_reason" IS NOT DISTINCT FROM 'resolved' AND "case_engagements"."closed_by_user_id" IS NOT NULL)
        OR ("case_engagements"."closed_at" IS NOT NULL AND "case_engagements"."close_reason" IS NOT DISTINCT FROM 'auto_inactive' AND "case_engagements"."closed_by_user_id" IS NULL)),
	CONSTRAINT "case_engagement_resolution_request_paired" CHECK (("case_engagements"."resolution_requested_at" IS NULL) = ("case_engagements"."resolution_requested_by_user_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "engagements" DROP CONSTRAINT "engagement_price_cents_nonneg";--> statement-breakpoint
ALTER TABLE "engagements" DROP CONSTRAINT "engagement_deposit_cents_nonneg";--> statement-breakpoint
ALTER TABLE "engagements" DROP CONSTRAINT "engagement_rate_cents_nonneg";--> statement-breakpoint
ALTER TABLE "engagements" DROP CONSTRAINT "engagements_source_proposal_id_proposals_id_fk";
--> statement-breakpoint
ALTER TABLE "engagements" DROP CONSTRAINT "engagements_relationship_id_request_expert_relationships_id_fk";
--> statement-breakpoint
ALTER TABLE "engagements" DROP CONSTRAINT "engagements_project_request_id_project_requests_id_fk";
--> statement-breakpoint
ALTER TABLE "engagements" DROP CONSTRAINT "engagements_completion_requested_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "engagements" DROP CONSTRAINT "engagements_accepted_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "engagements" DROP CONSTRAINT "engagements_change_requested_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "engagements" DROP CONSTRAINT "engagements_cancelled_by_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "engagement_source_proposal_idx";--> statement-breakpoint
DROP INDEX "engagement_relationship_idx";--> statement-breakpoint
DROP INDEX "engagement_request_idx";--> statement-breakpoint
DROP INDEX "engagement_request_unique_idx";--> statement-breakpoint
DROP INDEX "engagement_status_completion_requested_idx";--> statement-breakpoint
ALTER TABLE "engagements" ADD COLUMN "engagement_type" "engagement_type" NOT NULL;--> statement-breakpoint
-- HAND-EDIT 1 (see header): MOVED UP from after the child FKs. The composite FKs below
-- reference this constraint, so it must exist first.
ALTER TABLE "engagements" ADD CONSTRAINT "engagement_id_type_uq" UNIQUE("id","engagement_type");--> statement-breakpoint
ALTER TABLE "project_engagements" ADD CONSTRAINT "project_engagements_source_proposal_id_proposals_id_fk" FOREIGN KEY ("source_proposal_id") REFERENCES "public"."proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_engagements" ADD CONSTRAINT "project_engagements_relationship_id_request_expert_relationships_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."request_expert_relationships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_engagements" ADD CONSTRAINT "project_engagements_project_request_id_project_requests_id_fk" FOREIGN KEY ("project_request_id") REFERENCES "public"."project_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_engagements" ADD CONSTRAINT "project_engagements_completion_requested_by_user_id_users_id_fk" FOREIGN KEY ("completion_requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_engagements" ADD CONSTRAINT "project_engagements_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_engagements" ADD CONSTRAINT "project_engagements_change_requested_by_user_id_users_id_fk" FOREIGN KEY ("change_requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_engagements" ADD CONSTRAINT "project_engagements_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_engagements" ADD CONSTRAINT "project_engagement_parent_type_fk" FOREIGN KEY ("engagement_id","engagement_type") REFERENCES "public"."engagements"("id","engagement_type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_engagements" ADD CONSTRAINT "case_engagements_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_engagements" ADD CONSTRAINT "case_engagements_resolution_requested_by_user_id_users_id_fk" FOREIGN KEY ("resolution_requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_engagements" ADD CONSTRAINT "case_engagement_parent_type_fk" FOREIGN KEY ("engagement_id","engagement_type") REFERENCES "public"."engagements"("id","engagement_type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_engagement_source_proposal_idx" ON "project_engagements" USING btree ("source_proposal_id");--> statement-breakpoint
CREATE INDEX "project_engagement_relationship_idx" ON "project_engagements" USING btree ("relationship_id");--> statement-breakpoint
CREATE INDEX "project_engagement_request_idx" ON "project_engagements" USING btree ("project_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_engagement_request_unique_idx" ON "project_engagements" USING btree ("project_request_id") WHERE "project_engagements"."project_request_id" IS NOT NULL AND "project_engagements"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "project_engagement_delivery_completion_idx" ON "project_engagements" USING btree ("delivery_status","completion_requested_at") WHERE "project_engagements"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "case_engagement_open_idx" ON "case_engagements" USING btree ("engagement_id") WHERE "case_engagements"."closed_at" IS NULL AND "case_engagements"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "engagements" DROP COLUMN "source_proposal_id";--> statement-breakpoint
ALTER TABLE "engagements" DROP COLUMN "relationship_id";--> statement-breakpoint
ALTER TABLE "engagements" DROP COLUMN "project_request_id";--> statement-breakpoint
ALTER TABLE "engagements" DROP COLUMN "pricing_method";--> statement-breakpoint
ALTER TABLE "engagements" DROP COLUMN "price_cents";--> statement-breakpoint
ALTER TABLE "engagements" DROP COLUMN "deposit_cents";--> statement-breakpoint
ALTER TABLE "engagements" DROP COLUMN "rate_cents";--> statement-breakpoint
ALTER TABLE "engagements" DROP COLUMN "cadence";--> statement-breakpoint
ALTER TABLE "engagements" DROP COLUMN "billing_model";--> statement-breakpoint
ALTER TABLE "engagements" DROP COLUMN "approval_model";--> statement-breakpoint
ALTER TABLE "engagements" DROP COLUMN "completion_requested_by_user_id";--> statement-breakpoint
ALTER TABLE "engagements" DROP COLUMN "completion_requested_at";--> statement-breakpoint
ALTER TABLE "engagements" DROP COLUMN "accepted_by_user_id";--> statement-breakpoint
ALTER TABLE "engagements" DROP COLUMN "accepted_at";--> statement-breakpoint
ALTER TABLE "engagements" DROP COLUMN "acceptance_method";--> statement-breakpoint
ALTER TABLE "engagements" DROP COLUMN "change_request_note";--> statement-breakpoint
ALTER TABLE "engagements" DROP COLUMN "change_requested_by_user_id";--> statement-breakpoint
ALTER TABLE "engagements" DROP COLUMN "change_requested_at";--> statement-breakpoint
ALTER TABLE "engagements" DROP COLUMN "cancelled_by_user_id";--> statement-breakpoint
ALTER TABLE "engagements" DROP COLUMN "cancelled_at";--> statement-breakpoint
ALTER TABLE "engagements" DROP COLUMN "cancellation_reason";--> statement-breakpoint
-- HAND-EDIT 2 (see header): the enum shrink, rewritten. Drizzle's generated block
-- omits the DROP DEFAULT / SET DEFAULT pair and fails 2BP01 on an EMPTY database.
ALTER TABLE "public"."engagements" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "public"."engagements" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."engagement_status";--> statement-breakpoint
CREATE TYPE "public"."engagement_status" AS ENUM('active', 'completed', 'cancelled');--> statement-breakpoint
ALTER TABLE "public"."engagements" ALTER COLUMN "status" SET DATA TYPE "public"."engagement_status" USING "status"::"public"."engagement_status";--> statement-breakpoint
ALTER TABLE "public"."engagements" ALTER COLUMN "status" SET DEFAULT 'active';--> statement-breakpoint
-- HAND-EDIT 3 (see header): MOVED DOWN, after the enum shrink settled `status`'s type.
CREATE INDEX "engagement_type_status_created_idx" ON "engagements" USING btree ("engagement_type","status","created_at") WHERE "engagements"."deleted_at" IS NULL;
