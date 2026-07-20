CREATE TYPE "public"."credit_duration_source" AS ENUM('live_capture', 'external');--> statement-breakpoint
CREATE TYPE "public"."credit_finalization_path" AS ENUM('live_capture', 'confirmed', 'disputed', 'auto_confirmed');--> statement-breakpoint
CREATE TYPE "public"."expert_payout_record_status" AS ENUM('recorded', 'disbursing', 'paid', 'failed');--> statement-breakpoint
CREATE TABLE "expert_payout_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"expert_profile_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" char(3) DEFAULT 'AUD' NOT NULL,
	"duration_minutes" integer NOT NULL,
	"finalization_path" "credit_finalization_path" NOT NULL,
	"status" "expert_payout_record_status" DEFAULT 'recorded'::text::expert_payout_record_status NOT NULL,
	"idempotency_key" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "expert_payout_records_amount_nonneg" CHECK ("expert_payout_records"."amount_minor" >= 0),
	CONSTRAINT "expert_payout_records_duration_nonneg" CHECK ("expert_payout_records"."duration_minutes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "credit_sessions" ADD COLUMN "duration_source" "credit_duration_source" DEFAULT 'live_capture'::text::credit_duration_source NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_sessions" ADD COLUMN "billing_finalized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credit_sessions" ADD COLUMN "finalization_path" "credit_finalization_path";--> statement-breakpoint
ALTER TABLE "expert_payout_records" ADD CONSTRAINT "expert_payout_records_session_id_credit_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."credit_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_payout_records" ADD CONSTRAINT "expert_payout_records_expert_profile_id_expert_profiles_id_fk" FOREIGN KEY ("expert_profile_id") REFERENCES "public"."expert_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_payout_records" ADD CONSTRAINT "expert_payout_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expert_payout_records_session_uq" ON "expert_payout_records" USING btree ("session_id") WHERE "expert_payout_records"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "expert_payout_records_idem_uq" ON "expert_payout_records" USING btree ("idempotency_key") WHERE "expert_payout_records"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "expert_payout_records_expert_idx" ON "expert_payout_records" USING btree ("expert_profile_id");--> statement-breakpoint
CREATE INDEX "expert_payout_records_status_idx" ON "expert_payout_records" USING btree ("status") WHERE "expert_payout_records"."status" = 'recorded' AND "expert_payout_records"."deleted_at" IS NULL;