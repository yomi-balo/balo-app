ALTER TABLE "meeting_recordings" ADD COLUMN "transcript_job_id" text;--> statement-breakpoint
ALTER TABLE "meeting_recordings" ADD COLUMN "transcript_job_submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meeting_recordings" ADD COLUMN "transcript_job_finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meeting_recordings" ADD COLUMN "transcript_job_failure_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_recording_transcript_job_idx" ON "meeting_recordings" USING btree ("transcript_job_id") WHERE "meeting_recordings"."transcript_job_id" IS NOT NULL AND "meeting_recordings"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "meeting_recordings" ADD CONSTRAINT "meeting_recording_transcript_job_submitted" CHECK ("meeting_recordings"."transcript_job_id" IS NULL OR "meeting_recordings"."transcript_job_submitted_at" IS NOT NULL);