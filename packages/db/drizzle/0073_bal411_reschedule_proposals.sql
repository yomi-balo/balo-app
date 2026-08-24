CREATE TYPE "public"."reschedule_proposal_status" AS ENUM('pending', 'accepted', 'declined', 'withdrawn', 'expired');--> statement-breakpoint
CREATE TABLE "reschedule_proposal_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"scheduled_start" timestamp with time zone NOT NULL,
	"scheduled_end" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "reschedule_proposal_option_start_before_end" CHECK ("reschedule_proposal_options"."scheduled_start" < "reschedule_proposal_options"."scheduled_end"),
	CONSTRAINT "reschedule_proposal_option_position_range" CHECK ("reschedule_proposal_options"."position" >= 0 AND "reschedule_proposal_options"."position" < 3)
);
--> statement-breakpoint
CREATE TABLE "reschedule_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"proposed_by_user_id" uuid NOT NULL,
	"status" "reschedule_proposal_status" DEFAULT 'pending' NOT NULL,
	"original_scheduled_start" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "reschedule_proposal_resolution_paired" CHECK (("reschedule_proposals"."status" = 'pending') = ("reschedule_proposals"."resolved_at" IS NULL)),
	CONSTRAINT "reschedule_proposal_expires_within_window" CHECK ("reschedule_proposals"."expires_at" <= "reschedule_proposals"."original_scheduled_start")
);
--> statement-breakpoint
ALTER TABLE "reschedule_proposal_options" ADD CONSTRAINT "reschedule_proposal_options_proposal_id_reschedule_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."reschedule_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reschedule_proposals" ADD CONSTRAINT "reschedule_proposals_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reschedule_proposals" ADD CONSTRAINT "reschedule_proposals_proposed_by_user_id_users_id_fk" FOREIGN KEY ("proposed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reschedule_proposals" ADD CONSTRAINT "reschedule_proposals_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reschedule_proposal_option_position_idx" ON "reschedule_proposal_options" USING btree ("proposal_id","position") WHERE "reschedule_proposal_options"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "reschedule_proposal_option_start_idx" ON "reschedule_proposal_options" USING btree ("proposal_id","scheduled_start") WHERE "reschedule_proposal_options"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "reschedule_proposal_option_accepted_idx" ON "reschedule_proposal_options" USING btree ("proposal_id") WHERE "reschedule_proposal_options"."accepted_at" IS NOT NULL AND "reschedule_proposal_options"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "reschedule_proposal_one_pending_idx" ON "reschedule_proposals" USING btree ("meeting_id") WHERE "reschedule_proposals"."status" = 'pending' AND "reschedule_proposals"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "reschedule_proposal_meeting_idx" ON "reschedule_proposals" USING btree ("meeting_id") WHERE "reschedule_proposals"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "reschedule_proposal_proposed_by_idx" ON "reschedule_proposals" USING btree ("proposed_by_user_id");--> statement-breakpoint
CREATE INDEX "reschedule_proposal_resolved_by_idx" ON "reschedule_proposals" USING btree ("resolved_by_user_id");