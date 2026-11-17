CREATE TYPE "public"."meeting_ring_placement" AS ENUM('new_meeting', 'in_place');--> statement-breakpoint
CREATE TYPE "public"."meeting_ring_reach" AS ENUM('app', 'sms');--> statement-breakpoint
CREATE TYPE "public"."meeting_ring_side" AS ENUM('client', 'expert');--> statement-breakpoint
CREATE TYPE "public"."meeting_ring_status" AS ENUM('ringing', 'connected', 'unanswered', 'declined', 'stopped');--> statement-breakpoint
ALTER TYPE "public"."meeting_outcome" ADD VALUE 'no_answer';--> statement-breakpoint
CREATE TABLE "meeting_rings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"caller_user_id" uuid NOT NULL,
	"callee_user_id" uuid NOT NULL,
	"caller_side" "meeting_ring_side" NOT NULL,
	"placement" "meeting_ring_placement" NOT NULL,
	"status" "meeting_ring_status" DEFAULT 'ringing' NOT NULL,
	"reached_by" "meeting_ring_reach" DEFAULT 'app' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "meeting_ring_ended_iff_not_ringing" CHECK (("meeting_rings"."status" = 'ringing') = ("meeting_rings"."ended_at" IS NULL)),
	CONSTRAINT "meeting_ring_expires_after_created" CHECK ("meeting_rings"."expires_at" > "meeting_rings"."created_at"),
	CONSTRAINT "meeting_ring_caller_not_callee" CHECK ("meeting_rings"."caller_user_id" <> "meeting_rings"."callee_user_id")
);
--> statement-breakpoint
ALTER TABLE "meeting_rings" ADD CONSTRAINT "meeting_rings_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_rings" ADD CONSTRAINT "meeting_rings_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_rings" ADD CONSTRAINT "meeting_rings_caller_user_id_users_id_fk" FOREIGN KEY ("caller_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_rings" ADD CONSTRAINT "meeting_rings_callee_user_id_users_id_fk" FOREIGN KEY ("callee_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_ring_one_ringing_per_engagement_idx" ON "meeting_rings" USING btree ("engagement_id") WHERE "meeting_rings"."status" = 'ringing' AND "meeting_rings"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "meeting_ring_meeting_idx" ON "meeting_rings" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "meeting_ring_ringing_expiry_idx" ON "meeting_rings" USING btree ("expires_at") WHERE "meeting_rings"."status" = 'ringing' AND "meeting_rings"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "meeting_ring_caller_idx" ON "meeting_rings" USING btree ("caller_user_id");--> statement-breakpoint
CREATE INDEX "meeting_ring_callee_idx" ON "meeting_rings" USING btree ("callee_user_id");--> statement-breakpoint
CREATE INDEX "meeting_presence_open_user_idx" ON "meeting_presence" USING btree ("user_id") WHERE "meeting_presence"."user_id" IS NOT NULL AND "meeting_presence"."left_at" IS NULL AND "meeting_presence"."deleted_at" IS NULL;