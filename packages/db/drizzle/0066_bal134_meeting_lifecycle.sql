CREATE TYPE "public"."meeting_ended_by" AS ENUM('client_principal', 'expert_host', 'system_idle');--> statement-breakpoint
CREATE TABLE "daily_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"room_name" text,
	"payload_hash" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "ended_by" "meeting_ended_by";--> statement-breakpoint
CREATE UNIQUE INDEX "daily_webhook_events_event_id_idx" ON "daily_webhook_events" USING btree ("event_id");--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meeting_ended_by_requires_ended" CHECK ("meetings"."ended_by" IS NULL OR "meetings"."status" = 'ended');