CREATE TYPE "public"."engagement_acceptance_method" AS ENUM('client', 'auto');--> statement-breakpoint
CREATE TYPE "public"."engagement_milestone_status" AS ENUM('pending', 'in_progress', 'completed');--> statement-breakpoint
ALTER TYPE "public"."engagement_status" ADD VALUE 'pending_acceptance';--> statement-breakpoint
CREATE TABLE "engagement_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"source_proposal_milestone_id" uuid,
	"sort_order" integer NOT NULL,
	"title" text NOT NULL,
	"description_html" text,
	"acceptance_criteria" text,
	"value_cents" integer,
	"estimated_minutes" integer,
	"status" "engagement_milestone_status" DEFAULT 'pending' NOT NULL,
	"started_by_user_id" uuid,
	"started_at" timestamp with time zone,
	"completed_by_user_id" uuid,
	"completed_at" timestamp with time zone,
	"completion_note" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "engagement_milestone_value_nonneg" CHECK ("engagement_milestones"."value_cents" IS NULL OR "engagement_milestones"."value_cents" >= 0),
	CONSTRAINT "engagement_milestone_estimated_minutes_nonneg" CHECK ("engagement_milestones"."estimated_minutes" IS NULL OR "engagement_milestones"."estimated_minutes" >= 0),
	CONSTRAINT "engagement_milestone_sort_nonneg" CHECK ("engagement_milestones"."sort_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "engagements" ADD COLUMN "completion_requested_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "engagements" ADD COLUMN "completion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "engagements" ADD COLUMN "accepted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "engagements" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "engagements" ADD COLUMN "acceptance_method" "engagement_acceptance_method";--> statement-breakpoint
ALTER TABLE "engagements" ADD COLUMN "change_request_note" text;--> statement-breakpoint
ALTER TABLE "engagements" ADD COLUMN "change_requested_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "engagements" ADD COLUMN "change_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "engagements" ADD COLUMN "cancelled_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "engagements" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "engagements" ADD COLUMN "cancellation_reason" text;--> statement-breakpoint
ALTER TABLE "engagement_milestones" ADD CONSTRAINT "engagement_milestones_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_milestones" ADD CONSTRAINT "engagement_milestones_source_proposal_milestone_id_proposal_milestones_id_fk" FOREIGN KEY ("source_proposal_milestone_id") REFERENCES "public"."proposal_milestones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_milestones" ADD CONSTRAINT "engagement_milestones_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_milestones" ADD CONSTRAINT "engagement_milestones_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_milestones" ADD CONSTRAINT "engagement_milestones_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "engagement_milestone_engagement_idx" ON "engagement_milestones" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "engagement_milestone_status_idx" ON "engagement_milestones" USING btree ("engagement_id","status") WHERE "engagement_milestones"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "engagement_milestone_order_idx" ON "engagement_milestones" USING btree ("engagement_id","sort_order") WHERE "engagement_milestones"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_completion_requested_by_user_id_users_id_fk" FOREIGN KEY ("completion_requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_change_requested_by_user_id_users_id_fk" FOREIGN KEY ("change_requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "engagement_status_completion_requested_idx" ON "engagements" USING btree ("status","completion_requested_at") WHERE "engagements"."deleted_at" IS NULL;