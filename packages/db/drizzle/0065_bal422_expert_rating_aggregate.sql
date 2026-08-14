DROP INDEX "review_expert_live_idx";--> statement-breakpoint
ALTER TABLE "expert_profiles" ADD COLUMN "rating_average" numeric(2, 1);--> statement-breakpoint
ALTER TABLE "expert_profiles" ADD COLUMN "rating_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "review_expert_live_idx" ON "reviews" USING btree ("expert_profile_id","engagement_id","rating") WHERE "reviews"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "expert_profiles" ADD CONSTRAINT "expert_profiles_rating_average_range" CHECK ("expert_profiles"."rating_average" IS NULL OR ("expert_profiles"."rating_average" >= 1.0 AND "expert_profiles"."rating_average" <= 5.0));--> statement-breakpoint
ALTER TABLE "expert_profiles" ADD CONSTRAINT "expert_profiles_rating_count_non_negative" CHECK ("expert_profiles"."rating_count" >= 0);