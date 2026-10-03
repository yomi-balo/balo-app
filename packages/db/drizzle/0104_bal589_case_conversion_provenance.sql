ALTER TABLE "project_requests" ADD COLUMN "source_case_id" uuid;--> statement-breakpoint
ALTER TABLE "project_brief_parses" ADD COLUMN "source_engagement_id" uuid;--> statement-breakpoint
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_source_case_fk" FOREIGN KEY ("source_case_id") REFERENCES "public"."case_engagements"("engagement_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_brief_parses" ADD CONSTRAINT "project_brief_parses_source_case_fk" FOREIGN KEY ("source_engagement_id") REFERENCES "public"."case_engagements"("engagement_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_requests_source_case_idx" ON "project_requests" USING btree ("source_case_id");--> statement-breakpoint
CREATE INDEX "project_brief_parses_source_engagement_idx" ON "project_brief_parses" USING btree ("source_engagement_id");--> statement-breakpoint
ALTER TABLE "project_brief_parses" ADD CONSTRAINT "project_brief_parses_exactly_one_source" CHECK ((jsonb_array_length("project_brief_parses"."source_documents") > 0) <> ("project_brief_parses"."source_engagement_id" IS NOT NULL));