ALTER TABLE "expert_profiles" ADD COLUMN "username" text;--> statement-breakpoint
CREATE UNIQUE INDEX "expert_profiles_username_idx" ON "expert_profiles" USING btree ("username");