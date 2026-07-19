CREATE TYPE "public"."credit_receivable_reason" AS ENUM('settlement_declined', 'settlement_requires_action');--> statement-breakpoint
CREATE TYPE "public"."credit_receivable_status" AS ENUM('open', 'cleared', 'written_off');--> statement-breakpoint
CREATE TYPE "public"."credit_session_status" AS ENUM('pending', 'active', 'grace', 'wrapped', 'ended', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."credit_settlement_status" AS ENUM('not_required', 'processing', 'settled', 'failed', 'requires_action');--> statement-breakpoint
CREATE TABLE "credit_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"expert_profile_id" uuid NOT NULL,
	"initiating_member_id" uuid NOT NULL,
	"hold_id" uuid,
	"status" "credit_session_status" DEFAULT 'pending' NOT NULL,
	"settlement_status" "credit_settlement_status" DEFAULT 'not_required' NOT NULL,
	"estimated_minutes" integer NOT NULL,
	"expert_rate_minor_per_hour" integer NOT NULL,
	"balo_fee_bps" integer DEFAULT 2500 NOT NULL,
	"client_rate_minor_per_minute" integer NOT NULL,
	"expert_rate_minor_per_minute" integer NOT NULL,
	"effective_ceiling_minor" integer NOT NULL,
	"grace_bound_minutes" integer DEFAULT 30 NOT NULL,
	"connected_at" timestamp with time zone,
	"last_tick_seq" integer DEFAULT 0 NOT NULL,
	"connected_minutes" integer DEFAULT 0 NOT NULL,
	"expert_accrued_minor" integer DEFAULT 0 NOT NULL,
	"low_warned_at" timestamp with time zone,
	"grace_entered_at" timestamp with time zone,
	"near_wrap_warned_at" timestamp with time zone,
	"wrapped_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"overdraft_settled_minor" integer,
	"stripe_payment_intent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "credit_sessions_estimated_minutes_pos" CHECK ("credit_sessions"."estimated_minutes" > 0),
	CONSTRAINT "credit_sessions_expert_hourly_pos" CHECK ("credit_sessions"."expert_rate_minor_per_hour" > 0),
	CONSTRAINT "credit_sessions_client_minute_pos" CHECK ("credit_sessions"."client_rate_minor_per_minute" > 0),
	CONSTRAINT "credit_sessions_expert_minute_pos" CHECK ("credit_sessions"."expert_rate_minor_per_minute" > 0),
	CONSTRAINT "credit_sessions_ceiling_nonneg" CHECK ("credit_sessions"."effective_ceiling_minor" >= 0),
	CONSTRAINT "credit_sessions_balo_fee_bps_range" CHECK ("credit_sessions"."balo_fee_bps" >= 0 AND "credit_sessions"."balo_fee_bps" <= 10000),
	CONSTRAINT "credit_sessions_overdraft_settled_nonneg" CHECK ("credit_sessions"."overdraft_settled_minor" IS NULL OR "credit_sessions"."overdraft_settled_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "credit_receivables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"amount_minor" integer NOT NULL,
	"reason" "credit_receivable_reason" NOT NULL,
	"status" "credit_receivable_status" DEFAULT 'open' NOT NULL,
	"stripe_payment_intent_id" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone,
	"last_dunning_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "credit_receivables_amount_pos" CHECK ("credit_receivables"."amount_minor" > 0)
);
--> statement-breakpoint
ALTER TABLE "credit_sessions" ADD CONSTRAINT "credit_sessions_wallet_id_credit_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."credit_wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_sessions" ADD CONSTRAINT "credit_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_sessions" ADD CONSTRAINT "credit_sessions_expert_profile_id_expert_profiles_id_fk" FOREIGN KEY ("expert_profile_id") REFERENCES "public"."expert_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_sessions" ADD CONSTRAINT "credit_sessions_initiating_member_id_users_id_fk" FOREIGN KEY ("initiating_member_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_sessions" ADD CONSTRAINT "credit_sessions_hold_id_credit_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."credit_holds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_receivables" ADD CONSTRAINT "credit_receivables_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_receivables" ADD CONSTRAINT "credit_receivables_wallet_id_credit_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."credit_wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_receivables" ADD CONSTRAINT "credit_receivables_session_id_credit_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."credit_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_sessions_wallet_idx" ON "credit_sessions" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "credit_sessions_company_idx" ON "credit_sessions" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "credit_sessions_meter_idx" ON "credit_sessions" USING btree ("status") WHERE "credit_sessions"."status" IN ('active', 'grace') AND "credit_sessions"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "credit_sessions_settling_idx" ON "credit_sessions" USING btree ("settlement_status") WHERE "credit_sessions"."settlement_status" = 'processing' AND "credit_sessions"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "credit_receivables_company_open_idx" ON "credit_receivables" USING btree ("company_id") WHERE "credit_receivables"."status" = 'open' AND "credit_receivables"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_receivables_session_uidx" ON "credit_receivables" USING btree ("session_id") WHERE "credit_receivables"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_session_id_credit_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."credit_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_session_id_credit_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."credit_sessions"("id") ON DELETE restrict ON UPDATE no action;