-- BAL-424: PRE-LAUNCH, NO LIVE DATA. The three messaging tables are repointed DIRECTLY from
-- `relationship_id` to `conversation_id` — no expand-contract, no backfill. Existing rows in a
-- developer database have no conversation to point at, so they are dropped rather than
-- migrated. ⚠ THIS HAZARD IS INVISIBLE TO CI: the integration harness migrates an EMPTY
-- container (memory `reference_db_migrations_tested_against_empty_db`), so the NOT NULL add
-- would pass every gate and fail only on a seeded local/staging database.
TRUNCATE TABLE "conversation_read_states", "conversation_files", "conversation_messages";--> statement-breakpoint
CREATE TYPE "public"."conversation_context_type" AS ENUM('relationship', 'engagement');--> statement-breakpoint
CREATE TABLE "conversation_contexts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"context_type" "conversation_context_type" NOT NULL,
	"context_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "conversation_files" DROP CONSTRAINT "conversation_files_relationship_id_request_expert_relationships_id_fk";
--> statement-breakpoint
ALTER TABLE "conversation_messages" DROP CONSTRAINT "conversation_messages_relationship_id_request_expert_relationships_id_fk";
--> statement-breakpoint
ALTER TABLE "conversation_read_states" DROP CONSTRAINT "conversation_read_states_relationship_id_request_expert_relationships_id_fk";
--> statement-breakpoint
DROP INDEX "conversation_file_relationship_idx";--> statement-breakpoint
DROP INDEX "conversation_message_relationship_idx";--> statement-breakpoint
DROP INDEX "conversation_read_state_relationship_idx";--> statement-breakpoint
DROP INDEX "conversation_message_thread_idx";--> statement-breakpoint
DROP INDEX "conversation_read_state_unique_idx";--> statement-breakpoint
ALTER TABLE "conversation_files" ADD COLUMN "conversation_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD COLUMN "conversation_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD COLUMN "sent_during_meeting_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_read_states" ADD COLUMN "conversation_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_contexts" ADD CONSTRAINT "conversation_contexts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_context_subject_idx" ON "conversation_contexts" USING btree ("context_type","context_id") WHERE "conversation_contexts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "conversation_context_conversation_idx" ON "conversation_contexts" USING btree ("conversation_id") WHERE "conversation_contexts"."deleted_at" IS NULL;--> statement-breakpoint
-- BAL-424: NON-PARTIAL twin of the index above, for the ON DELETE CASCADE from
-- `conversations`. Postgres runs that cascade as an unqualified
-- `DELETE FROM conversation_contexts WHERE conversation_id = $1` (it must remove
-- soft-deleted children too), which a partial index cannot serve — without this the
-- cascade seq-scans the table on every conversation delete.
CREATE INDEX "conversation_context_conversation_fk_idx" ON "conversation_contexts" USING btree ("conversation_id");--> statement-breakpoint
ALTER TABLE "conversation_files" ADD CONSTRAINT "conversation_files_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_sent_during_meeting_id_meetings_id_fk" FOREIGN KEY ("sent_during_meeting_id") REFERENCES "public"."meetings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_read_states" ADD CONSTRAINT "conversation_read_states_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_file_conversation_idx" ON "conversation_files" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_message_conversation_idx" ON "conversation_messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_message_meeting_idx" ON "conversation_messages" USING btree ("sent_during_meeting_id","created_at") WHERE "conversation_messages"."sent_during_meeting_id" IS NOT NULL AND "conversation_messages"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "conversation_read_state_conversation_idx" ON "conversation_read_states" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_message_thread_idx" ON "conversation_messages" USING btree ("conversation_id","created_at") WHERE "conversation_messages"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_read_state_unique_idx" ON "conversation_read_states" USING btree ("conversation_id","user_id") WHERE "conversation_read_states"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "conversation_files" DROP COLUMN "relationship_id";--> statement-breakpoint
ALTER TABLE "conversation_messages" DROP COLUMN "relationship_id";--> statement-breakpoint
ALTER TABLE "conversation_read_states" DROP COLUMN "relationship_id";