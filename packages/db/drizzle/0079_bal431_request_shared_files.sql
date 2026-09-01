CREATE TYPE "public"."request_file_audience" AS ENUM('all_live_tracks', 'grants', 'own_track');--> statement-breakpoint
CREATE TYPE "public"."request_file_side" AS ENUM('client', 'expert');--> statement-breakpoint
CREATE TABLE "request_file_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"relationship_id" uuid NOT NULL,
	"project_request_id" uuid NOT NULL,
	"granted_by_user_id" uuid NOT NULL,
	"revoked_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "request_file_grant_revoke_attribution" CHECK (("request_file_grants"."deleted_at" IS NULL) = ("request_file_grants"."revoked_by_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "request_shared_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_request_id" uuid NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"side" "request_file_side" NOT NULL,
	"audience" "request_file_audience" NOT NULL,
	"expert_relationship_id" uuid,
	"r2_key" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"deleted_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "request_shared_file_id_request_uq" UNIQUE("id","project_request_id"),
	CONSTRAINT "request_shared_file_side_shape" CHECK (("request_shared_files"."side" = 'expert'
             AND "request_shared_files"."audience" = 'own_track'
             AND "request_shared_files"."expert_relationship_id" IS NOT NULL)
          OR
          ("request_shared_files"."side" = 'client'
             AND "request_shared_files"."audience" IN ('all_live_tracks','grants')
             AND "request_shared_files"."expert_relationship_id" IS NULL)),
	CONSTRAINT "request_shared_file_delete_attribution" CHECK (("request_shared_files"."deleted_at" IS NULL) = ("request_shared_files"."deleted_by_user_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "request_expert_relationships" ADD COLUMN "not_selected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "request_file_grants" ADD CONSTRAINT "request_file_grants_file_id_request_shared_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."request_shared_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_file_grants" ADD CONSTRAINT "request_file_grants_relationship_id_request_expert_relationships_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."request_expert_relationships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_file_grants" ADD CONSTRAINT "request_file_grants_project_request_id_project_requests_id_fk" FOREIGN KEY ("project_request_id") REFERENCES "public"."project_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_file_grants" ADD CONSTRAINT "request_file_grants_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_file_grants" ADD CONSTRAINT "request_file_grants_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_file_grants" ADD CONSTRAINT "request_file_grant_file_request_match_fk" FOREIGN KEY ("file_id","project_request_id") REFERENCES "public"."request_shared_files"("id","project_request_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_file_grants" ADD CONSTRAINT "request_file_grant_rel_request_match_fk" FOREIGN KEY ("relationship_id","project_request_id") REFERENCES "public"."request_expert_relationships"("id","project_request_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_shared_files" ADD CONSTRAINT "request_shared_files_project_request_id_project_requests_id_fk" FOREIGN KEY ("project_request_id") REFERENCES "public"."project_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_shared_files" ADD CONSTRAINT "request_shared_files_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_shared_files" ADD CONSTRAINT "request_shared_files_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_shared_files" ADD CONSTRAINT "request_shared_file_rel_request_match_fk" FOREIGN KEY ("expert_relationship_id","project_request_id") REFERENCES "public"."request_expert_relationships"("id","project_request_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "request_file_grant_unique_idx" ON "request_file_grants" USING btree ("file_id","relationship_id") WHERE "request_file_grants"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "request_file_grant_file_idx" ON "request_file_grants" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "request_file_grant_relationship_idx" ON "request_file_grants" USING btree ("relationship_id");--> statement-breakpoint
CREATE INDEX "request_file_grant_request_idx" ON "request_file_grants" USING btree ("project_request_id");--> statement-breakpoint
CREATE INDEX "request_file_grant_granted_by_idx" ON "request_file_grants" USING btree ("granted_by_user_id");--> statement-breakpoint
CREATE INDEX "request_file_grant_revoked_by_idx" ON "request_file_grants" USING btree ("revoked_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "request_shared_file_key_idx" ON "request_shared_files" USING btree ("r2_key");--> statement-breakpoint
CREATE INDEX "request_shared_file_request_idx" ON "request_shared_files" USING btree ("project_request_id","created_at") WHERE "request_shared_files"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "request_shared_file_request_all_idx" ON "request_shared_files" USING btree ("project_request_id");--> statement-breakpoint
CREATE INDEX "request_shared_file_uploaded_by_idx" ON "request_shared_files" USING btree ("uploaded_by_user_id");--> statement-breakpoint
CREATE INDEX "request_shared_file_deleted_by_idx" ON "request_shared_files" USING btree ("deleted_by_user_id");--> statement-breakpoint
CREATE INDEX "request_shared_file_relationship_idx" ON "request_shared_files" USING btree ("expert_relationship_id");