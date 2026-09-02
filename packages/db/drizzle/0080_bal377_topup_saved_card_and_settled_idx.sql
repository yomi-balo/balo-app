ALTER TABLE "credit_wallets" ADD COLUMN "card_brand" text;--> statement-breakpoint
ALTER TABLE "credit_wallets" ADD COLUMN "card_last4" text;--> statement-breakpoint
ALTER TABLE "credit_wallets" ADD COLUMN "card_exp_month" integer;--> statement-breakpoint
ALTER TABLE "credit_wallets" ADD COLUMN "card_exp_year" integer;--> statement-breakpoint
CREATE INDEX "credit_sessions_settled_missing_credit_idx" ON "credit_sessions" USING btree ("settled_at") WHERE "credit_sessions"."settlement_status" = 'settled' AND "credit_sessions"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "credit_wallets" ADD CONSTRAINT "credit_wallets_card_display_all_or_none" CHECK (("credit_wallets"."card_brand" IS NULL AND "credit_wallets"."card_last4" IS NULL AND "credit_wallets"."card_exp_month" IS NULL AND "credit_wallets"."card_exp_year" IS NULL)
          OR ("credit_wallets"."card_brand" IS NOT NULL AND "credit_wallets"."card_last4" IS NOT NULL AND "credit_wallets"."card_exp_month" IS NOT NULL AND "credit_wallets"."card_exp_year" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "credit_wallets" ADD CONSTRAINT "credit_wallets_card_last4_format" CHECK ("credit_wallets"."card_last4" IS NULL OR "credit_wallets"."card_last4" ~ '^[0-9]{4}$');--> statement-breakpoint
ALTER TABLE "credit_wallets" ADD CONSTRAINT "credit_wallets_card_exp_month_range" CHECK ("credit_wallets"."card_exp_month" IS NULL OR ("credit_wallets"."card_exp_month" BETWEEN 1 AND 12));--> statement-breakpoint
ALTER TABLE "credit_wallets" ADD CONSTRAINT "credit_wallets_card_exp_year_range" CHECK ("credit_wallets"."card_exp_year" IS NULL OR ("credit_wallets"."card_exp_year" BETWEEN 2000 AND 2100));