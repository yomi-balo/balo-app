CREATE TYPE "public"."meeting_file_source" AS ENUM('chat', 'files_tab');--> statement-breakpoint
CREATE TABLE "meeting_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"party" "meeting_participant_party" NOT NULL,
	"source" "meeting_file_source" NOT NULL,
	"r2_key" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "meeting_file_party_two_sided" CHECK ("meeting_files"."party" IN ('client','expert'))
);
--> statement-breakpoint
ALTER TABLE "meeting_files" ADD CONSTRAINT "meeting_files_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_files" ADD CONSTRAINT "meeting_files_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_file_key_idx" ON "meeting_files" USING btree ("r2_key");--> statement-breakpoint
CREATE INDEX "meeting_file_meeting_idx" ON "meeting_files" USING btree ("meeting_id","created_at") WHERE "meeting_files"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "meeting_file_uploaded_by_idx" ON "meeting_files" USING btree ("uploaded_by_user_id");