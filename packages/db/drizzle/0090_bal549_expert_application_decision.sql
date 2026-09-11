CREATE TYPE "public"."expert_decline_reason" AS ENUM('experience_depth', 'credentials_unverified', 'application_incomplete', 'not_a_fit');--> statement-breakpoint
ALTER TABLE "expert_profiles" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expert_profiles" ADD COLUMN "decided_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "expert_profiles" ADD COLUMN "decline_reason" "expert_decline_reason";--> statement-breakpoint
ALTER TABLE "expert_profiles" ADD COLUMN "decline_note" text;--> statement-breakpoint
ALTER TABLE "expert_profiles" ADD CONSTRAINT "expert_profiles_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expert_profiles_decided_by_idx" ON "expert_profiles" USING btree ("decided_by_user_id");--> statement-breakpoint
CREATE INDEX "expert_profiles_decided_at_idx" ON "expert_profiles" USING btree ("decided_at") WHERE "expert_profiles"."decided_at" IS NOT NULL;