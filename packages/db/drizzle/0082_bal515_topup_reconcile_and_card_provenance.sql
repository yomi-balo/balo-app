ALTER TABLE "credit_wallets" ADD COLUMN "card_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credit_wallets" ADD COLUMN "pending_topup_triggering_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_wallets" ADD COLUMN "pending_topup_payment_intent_id" text;--> statement-breakpoint
CREATE INDEX "credit_wallets_pending_topup_idx" ON "credit_wallets" USING btree ("pending_topup_at") WHERE "credit_wallets"."pending_topup_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "credit_wallets_stripe_payment_method_idx" ON "credit_wallets" USING btree ("stripe_payment_method_id") WHERE "credit_wallets"."stripe_payment_method_id" IS NOT NULL;