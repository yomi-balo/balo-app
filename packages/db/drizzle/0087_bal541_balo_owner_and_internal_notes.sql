CREATE TYPE "public"."internal_note_entity_type" AS ENUM('project_request');--> statement-breakpoint
CREATE TABLE "internal_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" "internal_note_entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"body" text NOT NULL,
	"author_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "project_requests" ADD COLUMN "balo_owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "internal_notes" ADD CONSTRAINT "internal_notes_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "internal_notes_entity_idx" ON "internal_notes" USING btree ("entity_type","entity_id","created_at") WHERE "internal_notes"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "internal_notes_author_idx" ON "internal_notes" USING btree ("author_user_id");--> statement-breakpoint
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_balo_owner_user_id_users_id_fk" FOREIGN KEY ("balo_owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_requests_balo_owner_idx" ON "project_requests" USING btree ("balo_owner_user_id");