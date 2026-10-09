CREATE TYPE "public"."expert_application_decision" AS ENUM('declined');--> statement-breakpoint
CREATE TABLE "expert_application_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expert_profile_id" uuid NOT NULL,
	"decision" "expert_application_decision" NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decline_reason" "expert_decline_reason",
	"decline_note" text,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "expert_application_decisions" ADD CONSTRAINT "expert_application_decisions_expert_profile_id_expert_profiles_id_fk" FOREIGN KEY ("expert_profile_id") REFERENCES "public"."expert_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_application_decisions" ADD CONSTRAINT "expert_application_decisions_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expert_application_decisions_profile_idx" ON "expert_application_decisions" USING btree ("expert_profile_id","created_at");--> statement-breakpoint
CREATE INDEX "expert_application_decisions_decided_by_idx" ON "expert_application_decisions" USING btree ("decided_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_settings_key_live_uidx" ON "platform_settings" USING btree ("key") WHERE "platform_settings"."deleted_at" IS NULL;--> statement-breakpoint
INSERT INTO "platform_settings" ("key", "value") VALUES ('expert_reapply_cooldown_days', '60'::jsonb);
