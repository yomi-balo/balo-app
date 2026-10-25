CREATE TYPE "public"."proposal_draft_generation_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "proposal_draft_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"relationship_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"status" "proposal_draft_generation_status" DEFAULT 'pending' NOT NULL,
	"output" jsonb,
	"failure_reason" text,
	"completed_at" timestamp with time zone,
	"model_id" text,
	"prompt_version" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "proposal_draft_generations_output_iff_succeeded" CHECK (("proposal_draft_generations"."status" = 'succeeded') = ("proposal_draft_generations"."output" IS NOT NULL)),
	CONSTRAINT "proposal_draft_generations_reason_iff_failed" CHECK (("proposal_draft_generations"."status" = 'failed') = ("proposal_draft_generations"."failure_reason" IS NOT NULL)),
	CONSTRAINT "proposal_draft_generations_completed_iff_terminal" CHECK (("proposal_draft_generations"."status" = 'pending') = ("proposal_draft_generations"."completed_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "proposal_draft_generations" ADD CONSTRAINT "proposal_draft_generations_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_draft_generations" ADD CONSTRAINT "proposal_draft_generations_relationship_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."request_expert_relationships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_draft_generations_relationship_live_idx" ON "proposal_draft_generations" USING btree ("relationship_id") WHERE "proposal_draft_generations"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "proposal_draft_generations_relationship_idx" ON "proposal_draft_generations" USING btree ("relationship_id");--> statement-breakpoint
CREATE INDEX "proposal_draft_generations_requester_idx" ON "proposal_draft_generations" USING btree ("requested_by_user_id","created_at");