CREATE TYPE "public"."credit_settlement_shape" AS ENUM('held', 'no_show_client', 'missed_call', 'abandoned_wait');--> statement-breakpoint
ALTER TYPE "public"."credit_duration_source" ADD VALUE 'presence';--> statement-breakpoint
ALTER TYPE "public"."credit_finalization_path" ADD VALUE 'presence';--> statement-breakpoint
ALTER TABLE "credit_sessions" ADD COLUMN "actual_minutes" integer;--> statement-breakpoint
ALTER TABLE "credit_sessions" ADD COLUMN "billing_floor_minutes" integer;--> statement-breakpoint
ALTER TABLE "credit_sessions" ADD COLUMN "settlement_shape" "credit_settlement_shape";--> statement-breakpoint
ALTER TABLE "credit_sessions" ADD COLUMN "floor_applied" boolean;--> statement-breakpoint
CREATE INDEX "credit_sessions_presence_unsettled_idx" ON "credit_sessions" USING btree ("duration_source","meeting_id") WHERE "credit_sessions"."billing_finalized_at" IS NULL AND "credit_sessions"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "credit_sessions" ADD CONSTRAINT "credit_sessions_actual_minutes_nonneg" CHECK ("credit_sessions"."actual_minutes" IS NULL OR "credit_sessions"."actual_minutes" >= 0);--> statement-breakpoint
ALTER TABLE "credit_sessions" ADD CONSTRAINT "credit_sessions_billing_floor_minutes_nonneg" CHECK ("credit_sessions"."billing_floor_minutes" IS NULL OR "credit_sessions"."billing_floor_minutes" >= 0);