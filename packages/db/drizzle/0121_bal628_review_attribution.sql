CREATE TYPE "public"."review_body_visibility" AS ENUM('public', 'private');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "job_title" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "industry_id" uuid;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "review_name_hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "review_name_hidden_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "body_visibility" "review_body_visibility" DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "show_company" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "reviewer_role" text;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_industry_id_industries_id_fk" FOREIGN KEY ("industry_id") REFERENCES "public"."industries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_review_name_hidden_by_user_id_users_id_fk" FOREIGN KEY ("review_name_hidden_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "companies_industry_id_idx" ON "companies" USING btree ("industry_id");--> statement-breakpoint
CREATE INDEX "companies_review_name_hidden_by_user_id_idx" ON "companies" USING btree ("review_name_hidden_by_user_id");--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "review_reviewer_role_length" CHECK ("reviews"."reviewer_role" IS NULL OR length(btrim("reviews"."reviewer_role")) BETWEEN 1 AND 60);--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "review_reviewer_role_charset" CHECK ("reviews"."reviewer_role" IS NULL OR "reviews"."reviewer_role" !~ '[@[:cntrl:]]');