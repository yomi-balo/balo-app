CREATE TYPE "public"."credit_entry_type" AS ENUM('purchase', 'consume', 'refund', 'expiry', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."credit_hold_status" AS ENUM('active', 'settled', 'released');--> statement-breakpoint
CREATE TYPE "public"."credit_ledger_reason" AS ENUM('manual_purchase', 'auto_topup', 'overdraft_settlement', 'session_consume', 'dormancy_expiry', 'promo', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."fx_display_quote" AS ENUM('GBP', 'EUR', 'USD');--> statement-breakpoint
CREATE TYPE "public"."low_balance_mode" AS ENUM('auto_topup', 'keep_going', 'notify_only');--> statement-breakpoint
CREATE TABLE "credit_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"balance_minor" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'AUD' NOT NULL,
	"expires_at" timestamp with time zone,
	"overdraft_ceiling_minor" integer,
	"low_balance_mode" "low_balance_mode" DEFAULT 'notify_only' NOT NULL,
	"topup_threshold_minor" integer DEFAULT 2000 NOT NULL,
	"topup_reload_minor" integer DEFAULT 10000 NOT NULL,
	"stripe_payment_method_id" text,
	"mandate_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_wallets_currency_aud" CHECK ("credit_wallets"."currency" = 'AUD'),
	CONSTRAINT "credit_wallets_overdraft_ceiling_nonneg" CHECK ("credit_wallets"."overdraft_ceiling_minor" IS NULL OR "credit_wallets"."overdraft_ceiling_minor" >= 0),
	CONSTRAINT "credit_wallets_topup_threshold_nonneg" CHECK ("credit_wallets"."topup_threshold_minor" >= 0),
	CONSTRAINT "credit_wallets_topup_reload_pos" CHECK ("credit_wallets"."topup_reload_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "credit_ledger_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"wallet_id" uuid NOT NULL,
	"entry_type" "credit_entry_type" NOT NULL,
	"reason" "credit_ledger_reason" NOT NULL,
	"amount_minor" integer NOT NULL,
	"balance_after_minor" bigint NOT NULL,
	"member_id" uuid,
	"session_id" uuid,
	"charged_currency" text,
	"charged_amount_minor" integer,
	"fx_rate" numeric(18, 8),
	"stripe_payment_intent_id" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_ledger_amount_nonzero" CHECK ("credit_ledger"."amount_minor" <> 0),
	CONSTRAINT "credit_ledger_charged_amount_nonneg" CHECK ("credit_ledger"."charged_amount_minor" IS NULL OR "credit_ledger"."charged_amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "credit_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"session_id" uuid,
	"member_id" uuid,
	"amount_minor" integer NOT NULL,
	"status" "credit_hold_status" DEFAULT 'active' NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "credit_holds_amount_pos" CHECK ("credit_holds"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "fx_display_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base" text DEFAULT 'AUD' NOT NULL,
	"quote" "fx_display_quote" NOT NULL,
	"rate" numeric(18, 8) NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_display_rates_base_aud" CHECK ("fx_display_rates"."base" = 'AUD')
);
--> statement-breakpoint
ALTER TABLE "credit_wallets" ADD CONSTRAINT "credit_wallets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_wallet_id_credit_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."credit_wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_member_id_users_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_wallet_id_credit_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."credit_wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_member_id_users_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_wallets_company_idx" ON "credit_wallets" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_idempotency_key_idx" ON "credit_ledger" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "credit_ledger_wallet_idx" ON "credit_ledger" USING btree ("wallet_id","seq");--> statement-breakpoint
CREATE INDEX "credit_ledger_session_idx" ON "credit_ledger" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "credit_holds_wallet_idx" ON "credit_holds" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "credit_holds_wallet_active_idx" ON "credit_holds" USING btree ("wallet_id") WHERE "credit_holds"."status" = 'active' AND "credit_holds"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "fx_display_rates_base_quote_idx" ON "fx_display_rates" USING btree ("base","quote");