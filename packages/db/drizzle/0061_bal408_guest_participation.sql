CREATE TYPE "public"."guest_access_scope" AS ENUM('meeting', 'engagement');--> statement-breakpoint
CREATE TYPE "public"."meeting_guest_admission" AS ENUM('pre_admitted', 'pending', 'admitted', 'denied');--> statement-breakpoint
CREATE TYPE "public"."meeting_guest_invite_channel" AS ENUM('email', 'link');--> statement-breakpoint
CREATE TYPE "public"."meeting_participation_role" AS ENUM('guest', 'delegate');--> statement-breakpoint
ALTER TABLE "meeting_guests" DROP CONSTRAINT "meeting_guests_access_token_unique";--> statement-breakpoint
ALTER TABLE "meeting_guests" DROP CONSTRAINT "meeting_guests_invited_by_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "meeting_guests" ADD COLUMN "party" "meeting_participant_party" NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_guests" ADD COLUMN "participation_role" "meeting_participation_role" NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_guests" ADD COLUMN "access_scope" "guest_access_scope" NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_guests" ADD COLUMN "invite_channel" "meeting_guest_invite_channel" NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_guests" ADD COLUMN "admission" "meeting_guest_admission" NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_guests" ADD COLUMN "token_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_guests" ADD COLUMN "expires_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_guests" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meeting_guests" ADD COLUMN "revoked_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "meeting_guests" ADD COLUMN "admission_decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meeting_guests" ADD COLUMN "admitted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "meeting_guests" ADD COLUMN "last_accessed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meeting_guests" ADD COLUMN "access_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_guests" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_guests" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meeting_presence" ADD COLUMN "meeting_guest_id" uuid;--> statement-breakpoint
ALTER TABLE "meeting_guests" ADD CONSTRAINT "meeting_guests_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_guests" ADD CONSTRAINT "meeting_guests_admitted_by_user_id_users_id_fk" FOREIGN KEY ("admitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_guests" ADD CONSTRAINT "meeting_guests_invited_by_id_users_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_presence" ADD CONSTRAINT "meeting_presence_meeting_guest_id_meeting_guests_id_fk" FOREIGN KEY ("meeting_guest_id") REFERENCES "public"."meeting_guests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_guest_token_hash_idx" ON "meeting_guests" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_guest_meeting_email_live_idx" ON "meeting_guests" USING btree ("meeting_id","party","email") WHERE "meeting_guests"."deleted_at" IS NULL AND "meeting_guests"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "meeting_guest_meeting_live_idx" ON "meeting_guests" USING btree ("meeting_id") WHERE "meeting_guests"."deleted_at" IS NULL AND "meeting_guests"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "meeting_guest_invited_by_idx" ON "meeting_guests" USING btree ("invited_by_id");--> statement-breakpoint
CREATE INDEX "meeting_guest_user_idx" ON "meeting_guests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "meeting_guest_converted_to_user_idx" ON "meeting_guests" USING btree ("converted_to_user_id");--> statement-breakpoint
CREATE INDEX "meeting_guest_revoked_by_idx" ON "meeting_guests" USING btree ("revoked_by_user_id");--> statement-breakpoint
CREATE INDEX "meeting_guest_admitted_by_idx" ON "meeting_guests" USING btree ("admitted_by_user_id");--> statement-breakpoint
CREATE INDEX "meeting_presence_guest_idx" ON "meeting_presence" USING btree ("meeting_guest_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_presence_one_open_per_guest_idx" ON "meeting_presence" USING btree ("meeting_id","meeting_guest_id") WHERE "meeting_presence"."meeting_guest_id" IS NOT NULL AND "meeting_presence"."left_at" IS NULL AND "meeting_presence"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "meeting_guests" DROP COLUMN "access_token";--> statement-breakpoint
ALTER TABLE "meeting_guests" ADD CONSTRAINT "meeting_guest_party_two_sided" CHECK ("meeting_guests"."party" IN ('client','expert'));--> statement-breakpoint
ALTER TABLE "meeting_guests" ADD CONSTRAINT "meeting_guest_delegate_is_client_side" CHECK ("meeting_guests"."participation_role" <> 'delegate' OR "meeting_guests"."party" = 'client');--> statement-breakpoint
ALTER TABLE "meeting_guests" ADD CONSTRAINT "meeting_guest_admission_terminal_stamped" CHECK (("meeting_guests"."admission" IN ('admitted','denied')) = ("meeting_guests"."admission_decided_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "meeting_guests" ADD CONSTRAINT "meeting_guest_admission_attributed" CHECK ("meeting_guests"."admitted_by_user_id" IS NULL OR "meeting_guests"."admission_decided_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "meeting_guests" ADD CONSTRAINT "meeting_guest_revocation_attributed" CHECK ("meeting_guests"."revoked_by_user_id" IS NULL OR "meeting_guests"."revoked_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "meeting_guests" ADD CONSTRAINT "meeting_guest_access_count_nonneg" CHECK ("meeting_guests"."access_count" >= 0);--> statement-breakpoint
ALTER TABLE "meeting_presence" ADD CONSTRAINT "meeting_presence_identity_not_both" CHECK (NOT ("meeting_presence"."user_id" IS NOT NULL AND "meeting_presence"."meeting_guest_id" IS NOT NULL));