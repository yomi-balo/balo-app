CREATE TABLE "project_change_request_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"change_request_id" uuid NOT NULL,
	"engagement_milestone_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"note" text NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "project_change_request_milestones" ADD CONSTRAINT "project_change_request_milestones_change_request_id_project_change_requests_id_fk" FOREIGN KEY ("change_request_id") REFERENCES "public"."project_change_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_change_request_milestones" ADD CONSTRAINT "project_change_request_milestones_engagement_milestone_id_engagement_milestones_id_fk" FOREIGN KEY ("engagement_milestone_id") REFERENCES "public"."engagement_milestones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_change_requests" ADD CONSTRAINT "project_change_requests_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_change_requests" ADD CONSTRAINT "project_change_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_change_request_milestone_pair_uq" ON "project_change_request_milestones" USING btree ("change_request_id","engagement_milestone_id") WHERE "project_change_request_milestones"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "project_change_request_milestone_milestone_idx" ON "project_change_request_milestones" USING btree ("engagement_milestone_id");--> statement-breakpoint
CREATE INDEX "project_change_request_engagement_requested_idx" ON "project_change_requests" USING btree ("engagement_id","requested_at") WHERE "project_change_requests"."deleted_at" IS NULL;