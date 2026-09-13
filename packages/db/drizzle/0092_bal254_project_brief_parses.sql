CREATE TABLE "project_brief_parses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"source_documents" jsonb NOT NULL,
	"result" jsonb,
	"failure_reason" text,
	"completed_at" timestamp with time zone,
	"model_id" text,
	"model_version" text,
	"prompt_id" text,
	"prompt_version" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "project_brief_parses_single_outcome" CHECK ("project_brief_parses"."result" IS NULL OR "project_brief_parses"."failure_reason" IS NULL),
	CONSTRAINT "project_brief_parses_completion_carries_an_outcome" CHECK (("project_brief_parses"."completed_at" IS NOT NULL) = ("project_brief_parses"."result" IS NOT NULL OR "project_brief_parses"."failure_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "project_brief_parses" ADD CONSTRAINT "project_brief_parses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_brief_parses" ADD CONSTRAINT "project_brief_parses_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_brief_parses_owner_idx" ON "project_brief_parses" USING btree ("requested_by_user_id","created_at") WHERE "project_brief_parses"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "project_brief_parses_company_idx" ON "project_brief_parses" USING btree ("company_id");