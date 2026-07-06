CREATE TABLE "expert_referral_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expert_profile_id" uuid NOT NULL,
	"email" text NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "expert_referral_invites" ADD CONSTRAINT "expert_referral_invites_expert_profile_id_expert_profiles_id_fk" FOREIGN KEY ("expert_profile_id") REFERENCES "public"."expert_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_referral_invites" ADD CONSTRAINT "expert_referral_invites_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expert_referral_invite_unique_idx" ON "expert_referral_invites" USING btree ("expert_profile_id","email") WHERE "expert_referral_invites"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "expert_referral_invite_expert_idx" ON "expert_referral_invites" USING btree ("expert_profile_id");--> statement-breakpoint
CREATE INDEX "expert_referral_invite_invited_by_idx" ON "expert_referral_invites" USING btree ("invited_by_user_id");--> statement-breakpoint
CREATE INDEX "expert_referral_invite_email_idx" ON "expert_referral_invites" USING btree ("email");