ALTER TABLE "project_requests" ADD COLUMN "budget_min_cents" integer;--> statement-breakpoint
ALTER TABLE "project_requests" ADD COLUMN "budget_max_cents" integer;--> statement-breakpoint
ALTER TABLE "project_requests" ADD COLUMN "budget_currency" text DEFAULT 'aud' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_requests" ADD COLUMN "timeline" text;--> statement-breakpoint
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_budget_min_nonneg" CHECK ("project_requests"."budget_min_cents" IS NULL OR "project_requests"."budget_min_cents" >= 0);--> statement-breakpoint
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_budget_max_nonneg" CHECK ("project_requests"."budget_max_cents" IS NULL OR "project_requests"."budget_max_cents" >= 0);--> statement-breakpoint
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_budget_range" CHECK ("project_requests"."budget_min_cents" IS NULL OR "project_requests"."budget_max_cents" IS NULL
          OR "project_requests"."budget_max_cents" >= "project_requests"."budget_min_cents");