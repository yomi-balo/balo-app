CREATE TABLE "engagement_time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"engagement_milestone_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"worked_on" date NOT NULL,
	"minutes" integer NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "engagement_time_entry_minutes_positive" CHECK ("engagement_time_entries"."minutes" > 0),
	CONSTRAINT "engagement_time_entry_note_present" CHECK (length(btrim("engagement_time_entries"."note")) > 0)
);
--> statement-breakpoint
ALTER TABLE "engagement_time_entries" ADD CONSTRAINT "engagement_time_entries_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_time_entries" ADD CONSTRAINT "engagement_time_entries_engagement_milestone_id_engagement_milestones_id_fk" FOREIGN KEY ("engagement_milestone_id") REFERENCES "public"."engagement_milestones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_time_entries" ADD CONSTRAINT "engagement_time_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "engagement_time_entry_milestone_idx" ON "engagement_time_entries" USING btree ("engagement_milestone_id") WHERE "engagement_time_entries"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "engagement_time_entry_engagement_worked_idx" ON "engagement_time_entries" USING btree ("engagement_id","worked_on") WHERE "engagement_time_entries"."deleted_at" IS NULL;