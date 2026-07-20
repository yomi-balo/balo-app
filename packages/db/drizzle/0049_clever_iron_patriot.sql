CREATE TYPE "public"."action_item_assignee_party" AS ENUM('client', 'expert');--> statement-breakpoint
CREATE TYPE "public"."action_item_source" AS ENUM('ai_extracted', 'manual');--> statement-breakpoint
CREATE TYPE "public"."action_item_status" AS ENUM('open', 'done');--> statement-breakpoint
CREATE TABLE "action_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"meeting_id" uuid,
	"body" text NOT NULL,
	"status" "action_item_status" DEFAULT 'open' NOT NULL,
	"source" "action_item_source" NOT NULL,
	"assignee_party" "action_item_assignee_party",
	"due_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"assigned_by_user_id" uuid,
	"assigned_at" timestamp with time zone,
	"completed_by_user_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "action_item_body_nonempty" CHECK (length(btrim("action_items"."body")) > 0)
);
--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_item_engagement_idx" ON "action_items" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "action_item_engagement_status_idx" ON "action_items" USING btree ("engagement_id","status") WHERE "action_items"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "action_item_meeting_idx" ON "action_items" USING btree ("meeting_id") WHERE "action_items"."meeting_id" IS NOT NULL AND "action_items"."deleted_at" IS NULL;