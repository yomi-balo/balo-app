CREATE TYPE "public"."project_request_close_reason" AS ENUM('withdrawn', 'declined', 'unfilled', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."relationship_decline_reason" AS ENUM('request_closed', 'client_declined', 'balo_declined');--> statement-breakpoint
ALTER TYPE "public"."project_request_status" ADD VALUE 'closed';--> statement-breakpoint
ALTER TYPE "public"."proposal_status" ADD VALUE 'declined';--> statement-breakpoint
ALTER TABLE "project_requests" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_requests" ADD COLUMN "closed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "project_requests" ADD COLUMN "close_reason" "project_request_close_reason";--> statement-breakpoint
ALTER TABLE "project_requests" ADD COLUMN "close_note" text;--> statement-breakpoint
ALTER TABLE "request_expert_relationships" ADD COLUMN "declined_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "request_expert_relationships" ADD COLUMN "decline_reason" "relationship_decline_reason";--> statement-breakpoint
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_expert_relationships" ADD CONSTRAINT "request_expert_relationships_declined_by_user_id_users_id_fk" FOREIGN KEY ("declined_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_requests_closed_by_idx" ON "project_requests" USING btree ("closed_by_user_id");--> statement-breakpoint
CREATE INDEX "request_expert_relationship_declined_by_idx" ON "request_expert_relationships" USING btree ("declined_by_user_id");