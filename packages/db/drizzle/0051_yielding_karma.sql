CREATE TYPE "public"."transcript_artifact_kind" AS ENUM('cleaned', 'summary');--> statement-breakpoint
CREATE TYPE "public"."transcript_status" AS ENUM('processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."transcript_vendor" AS ENUM('daily_deepgram', 'recall');--> statement-breakpoint
CREATE TABLE "transcript_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transcript_id" uuid NOT NULL,
	"kind" "transcript_artifact_kind" NOT NULL,
	"content" text NOT NULL,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"model_version" text,
	"prompt_id" text NOT NULL,
	"prompt_version" text NOT NULL,
	"prompt" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"meeting_id" uuid,
	"capture_id" text NOT NULL,
	"vendor" "transcript_vendor" NOT NULL,
	"status" "transcript_status" DEFAULT 'processing' NOT NULL,
	"language" text,
	"duration_ms" integer,
	"filler_words" boolean DEFAULT true NOT NULL,
	"canonical" jsonb NOT NULL,
	"recording_ref" text,
	"extracted_action_items" jsonb,
	"action_items_extracted_at" timestamp with time zone,
	"recap_ready_published_at" timestamp with time zone,
	"failed_stage" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "transcript_artifacts" ADD CONSTRAINT "transcript_artifacts_transcript_id_transcripts_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_artifact_kind_idx" ON "transcript_artifacts" USING btree ("transcript_id","kind") WHERE "transcript_artifacts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "transcript_artifact_transcript_idx" ON "transcript_artifacts" USING btree ("transcript_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_capture_id_idx" ON "transcripts" USING btree ("capture_id") WHERE "transcripts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "transcript_engagement_idx" ON "transcripts" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "transcript_meeting_idx" ON "transcripts" USING btree ("meeting_id") WHERE "transcripts"."meeting_id" IS NOT NULL AND "transcripts"."deleted_at" IS NULL;