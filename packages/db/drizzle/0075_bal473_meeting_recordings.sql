CREATE TYPE "public"."recording_status" AS ENUM('recording', 'source_ready', 'ingesting', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "meeting_recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"status" "recording_status" DEFAULT 'recording' NOT NULL,
	"daily_recording_id" text,
	"mux_asset_id" text,
	"mux_playback_id" text,
	"failed_stage" text,
	"failure_reason" text,
	"started_at" timestamp with time zone,
	"capture_ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"ready_at" timestamp with time zone,
	"source_deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "meeting_recording_capture_slot" CHECK ("meeting_recordings"."capture_ended_at" IS NOT NULL OR "meeting_recordings"."status" = 'recording'),
	CONSTRAINT "meeting_recording_duration_non_negative" CHECK ("meeting_recordings"."duration_seconds" IS NULL OR "meeting_recordings"."duration_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mux_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"passthrough" text,
	"payload_hash" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "meeting_recordings" ADD CONSTRAINT "meeting_recordings_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_recording_capturing_idx" ON "meeting_recordings" USING btree ("meeting_id") WHERE "meeting_recordings"."capture_ended_at" IS NULL AND "meeting_recordings"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "meeting_recording_meeting_idx" ON "meeting_recordings" USING btree ("meeting_id","created_at") WHERE "meeting_recordings"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_recording_daily_id_idx" ON "meeting_recordings" USING btree ("daily_recording_id") WHERE "meeting_recordings"."daily_recording_id" IS NOT NULL AND "meeting_recordings"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_recording_mux_asset_idx" ON "meeting_recordings" USING btree ("mux_asset_id") WHERE "meeting_recordings"."mux_asset_id" IS NOT NULL AND "meeting_recordings"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mux_webhook_events_event_id_idx" ON "mux_webhook_events" USING btree ("event_id");