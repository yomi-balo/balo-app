-- 0022 — project_request_status: rename 'submitted'→'requested', then append 7 downstream states.
-- Hand-edited (see plan §6): drizzle-kit cannot express an enum value RENAME, so it emitted a
-- destructive cast-to-text / DROP TYPE / CREATE TYPE / cast-back block that would FAIL on existing
-- 'submitted' rows. Replaced with an in-place RENAME (carries existing rows for free) + ordered
-- ADD VALUE appends. Safe in one transaction on PG15+: we only RENAME and ADD VALUE and never USE a
-- newly-added label in this migration (SET DEFAULT 'requested' uses the RENAMED — not added — value).
ALTER TYPE "public"."project_request_status" RENAME VALUE 'submitted' TO 'requested';--> statement-breakpoint
ALTER TYPE "public"."project_request_status" ADD VALUE 'exploratory_meeting_requested' AFTER 'requested';--> statement-breakpoint
ALTER TYPE "public"."project_request_status" ADD VALUE 'experts_invited' AFTER 'exploratory_meeting_requested';--> statement-breakpoint
ALTER TYPE "public"."project_request_status" ADD VALUE 'eoi_submitted' AFTER 'experts_invited';--> statement-breakpoint
ALTER TYPE "public"."project_request_status" ADD VALUE 'proposal_requested' AFTER 'eoi_submitted';--> statement-breakpoint
ALTER TYPE "public"."project_request_status" ADD VALUE 'proposal_submitted' AFTER 'proposal_requested';--> statement-breakpoint
ALTER TYPE "public"."project_request_status" ADD VALUE 'accepted' AFTER 'proposal_submitted';--> statement-breakpoint
ALTER TYPE "public"."project_request_status" ADD VALUE 'kickoff_approved' AFTER 'accepted';--> statement-breakpoint
ALTER TABLE "project_requests" ALTER COLUMN "status" SET DEFAULT 'requested';--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('submitted', 'accepted', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."request_expert_relationship_status" AS ENUM('invited', 'eoi_submitted', 'proposal_requested', 'proposal_submitted', 'accepted', 'declined');--> statement-breakpoint
CREATE TABLE "conversation_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"relationship_id" uuid NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"r2_key" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"relationship_id" uuid NOT NULL,
	"sender_user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "expressions_of_interest" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"relationship_id" uuid NOT NULL,
	"project_request_id" uuid NOT NULL,
	"expert_profile_id" uuid NOT NULL,
	"message" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"relationship_id" uuid NOT NULL,
	"project_request_id" uuid NOT NULL,
	"expert_profile_id" uuid NOT NULL,
	"status" "proposal_status" DEFAULT 'submitted' NOT NULL,
	"scope" text NOT NULL,
	"price_cents" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "proposal_price_cents_nonneg" CHECK ("proposals"."price_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "request_expert_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_request_id" uuid NOT NULL,
	"expert_profile_id" uuid NOT NULL,
	"status" "request_expert_relationship_status" DEFAULT 'invited' NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"declined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "project_requests" ADD COLUMN "proposal_cap" integer;--> statement-breakpoint
ALTER TABLE "conversation_files" ADD CONSTRAINT "conversation_files_relationship_id_request_expert_relationships_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."request_expert_relationships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_files" ADD CONSTRAINT "conversation_files_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_relationship_id_request_expert_relationships_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."request_expert_relationships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expressions_of_interest" ADD CONSTRAINT "expressions_of_interest_relationship_id_request_expert_relationships_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."request_expert_relationships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expressions_of_interest" ADD CONSTRAINT "expressions_of_interest_project_request_id_project_requests_id_fk" FOREIGN KEY ("project_request_id") REFERENCES "public"."project_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expressions_of_interest" ADD CONSTRAINT "expressions_of_interest_expert_profile_id_expert_profiles_id_fk" FOREIGN KEY ("expert_profile_id") REFERENCES "public"."expert_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_relationship_id_request_expert_relationships_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."request_expert_relationships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_project_request_id_project_requests_id_fk" FOREIGN KEY ("project_request_id") REFERENCES "public"."project_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_expert_profile_id_expert_profiles_id_fk" FOREIGN KEY ("expert_profile_id") REFERENCES "public"."expert_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_expert_relationships" ADD CONSTRAINT "request_expert_relationships_project_request_id_project_requests_id_fk" FOREIGN KEY ("project_request_id") REFERENCES "public"."project_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_expert_relationships" ADD CONSTRAINT "request_expert_relationships_expert_profile_id_expert_profiles_id_fk" FOREIGN KEY ("expert_profile_id") REFERENCES "public"."expert_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_expert_relationships" ADD CONSTRAINT "request_expert_relationships_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_file_key_idx" ON "conversation_files" USING btree ("r2_key");--> statement-breakpoint
CREATE INDEX "conversation_file_relationship_idx" ON "conversation_files" USING btree ("relationship_id");--> statement-breakpoint
CREATE INDEX "conversation_file_uploaded_by_idx" ON "conversation_files" USING btree ("uploaded_by_user_id");--> statement-breakpoint
CREATE INDEX "conversation_message_relationship_idx" ON "conversation_messages" USING btree ("relationship_id");--> statement-breakpoint
CREATE INDEX "conversation_message_sender_idx" ON "conversation_messages" USING btree ("sender_user_id");--> statement-breakpoint
CREATE INDEX "conversation_message_thread_idx" ON "conversation_messages" USING btree ("relationship_id","created_at") WHERE "conversation_messages"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "expression_of_interest_relationship_idx" ON "expressions_of_interest" USING btree ("relationship_id");--> statement-breakpoint
CREATE INDEX "expression_of_interest_request_idx" ON "expressions_of_interest" USING btree ("project_request_id");--> statement-breakpoint
CREATE INDEX "expression_of_interest_expert_idx" ON "expressions_of_interest" USING btree ("expert_profile_id");--> statement-breakpoint
CREATE INDEX "proposal_relationship_idx" ON "proposals" USING btree ("relationship_id");--> statement-breakpoint
CREATE INDEX "proposal_request_idx" ON "proposals" USING btree ("project_request_id");--> statement-breakpoint
CREATE INDEX "proposal_expert_idx" ON "proposals" USING btree ("expert_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "request_expert_relationship_unique_idx" ON "request_expert_relationships" USING btree ("project_request_id","expert_profile_id");--> statement-breakpoint
CREATE INDEX "request_expert_relationship_request_idx" ON "request_expert_relationships" USING btree ("project_request_id");--> statement-breakpoint
CREATE INDEX "request_expert_relationship_expert_idx" ON "request_expert_relationships" USING btree ("expert_profile_id");--> statement-breakpoint
CREATE INDEX "request_expert_relationship_invited_by_idx" ON "request_expert_relationships" USING btree ("invited_by_user_id");--> statement-breakpoint
CREATE INDEX "request_expert_relationship_status_idx" ON "request_expert_relationships" USING btree ("project_request_id","status") WHERE "request_expert_relationships"."deleted_at" IS NULL;
