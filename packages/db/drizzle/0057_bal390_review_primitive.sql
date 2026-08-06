CREATE TYPE "public"."review_auth_method" AS ENUM('session', 'magic_link');--> statement-breakpoint
CREATE TYPE "public"."review_surface" AS ENUM('end_of_call', 'recap', 'email');--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"reviewer_user_id" uuid NOT NULL,
	"expert_profile_id" uuid NOT NULL,
	"rating" integer NOT NULL,
	"body" text,
	"surface" "review_surface" NOT NULL,
	"auth_method" "review_auth_method" NOT NULL,
	"last_edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "review_rating_range" CHECK ("reviews"."rating" >= 1 AND "reviews"."rating" <= 5),
	CONSTRAINT "review_body_nonempty_when_present" CHECK ("reviews"."body" IS NULL OR length(btrim("reviews"."body")) > 0)
);
--> statement-breakpoint
CREATE TABLE "review_invite_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"reviewer_user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '30 days' NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_accessed_at" timestamp with time zone,
	"access_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "review_invite_token_access_count_nonneg" CHECK ("review_invite_tokens"."access_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagement_id_expert_uq" UNIQUE("id","expert_profile_id");--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "review_engagement_expert_fk" FOREIGN KEY ("engagement_id","expert_profile_id") REFERENCES "public"."engagements"("id","expert_profile_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_invite_tokens" ADD CONSTRAINT "review_invite_tokens_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_invite_tokens" ADD CONSTRAINT "review_invite_tokens_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_engagement_reviewer_expert_live_idx" ON "reviews" USING btree ("engagement_id","reviewer_user_id","expert_profile_id") WHERE "reviews"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "review_expert_live_idx" ON "reviews" USING btree ("expert_profile_id","rating") WHERE "reviews"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "review_engagement_expert_idx" ON "reviews" USING btree ("engagement_id","expert_profile_id");--> statement-breakpoint
CREATE INDEX "review_reviewer_idx" ON "reviews" USING btree ("reviewer_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_invite_token_hash_idx" ON "review_invite_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "review_invite_token_engagement_reviewer_idx" ON "review_invite_tokens" USING btree ("engagement_id","reviewer_user_id");--> statement-breakpoint
CREATE INDEX "review_invite_token_reviewer_idx" ON "review_invite_tokens" USING btree ("reviewer_user_id");--> statement-breakpoint
CREATE INDEX "project_engagement_accepted_at_idx" ON "project_engagements" USING btree ("accepted_at") WHERE "project_engagements"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "case_engagement_closed_at_idx" ON "case_engagements" USING btree ("closed_at") WHERE "case_engagements"."deleted_at" IS NULL;