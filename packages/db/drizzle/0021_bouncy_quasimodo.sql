CREATE TYPE "public"."project_request_source" AS ENUM('manual', 'ai', 'quickstart');--> statement-breakpoint
CREATE TYPE "public"."project_request_status" AS ENUM('draft', 'submitted');--> statement-breakpoint
CREATE TABLE "project_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"expert_profile_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"status" "project_request_status" DEFAULT 'submitted' NOT NULL,
	"source" "project_request_source" DEFAULT 'manual' NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"focus_area" text,
	"budget" text,
	"timeline" text,
	"package_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_expert_profile_id_expert_profiles_id_fk" FOREIGN KEY ("expert_profile_id") REFERENCES "public"."expert_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_requests_company_idx" ON "project_requests" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "project_requests_expert_profile_idx" ON "project_requests" USING btree ("expert_profile_id");--> statement-breakpoint
CREATE INDEX "project_requests_created_by_idx" ON "project_requests" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "project_requests_expert_status_idx" ON "project_requests" USING btree ("expert_profile_id","status") WHERE "project_requests"."deleted_at" IS NULL;