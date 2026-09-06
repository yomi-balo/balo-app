ALTER TABLE "credit_sessions" ADD COLUMN "settlement_stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "credit_sessions" ADD COLUMN "settlement_stripe_payment_method_id" text;--> statement-breakpoint
ALTER TABLE "credit_sessions" ADD COLUMN "settlement_instrument_pinned_at" timestamp with time zone;--> statement-breakpoint
-- BAL-525 Qodo follow-up: `credit_sessions` is a hot money-path table (per-minute meter sweep +
-- terminal settlement write to it constantly). A plain `ADD CONSTRAINT ... CHECK (...)` validates
-- INLINE — Postgres takes ACCESS EXCLUSIVE and full-scans the table for the duration of the scan,
-- blocking every concurrent read and write on this table for as long as that takes. Every
-- pre-existing row has all three new columns NULL and satisfies both predicates trivially, so that
-- blocking scan buys nothing. Split each constraint into NOT VALID (brief ACCESS EXCLUSIVE, no
-- scan — just the catalog write) + a separate VALIDATE CONSTRAINT (takes only SHARE UPDATE
-- EXCLUSIVE, which blocks other DDL but NOT normal reads/writes). Do NOT collapse this back into a
-- single ADD CONSTRAINT ... CHECK statement — that reintroduces the blocking scan this split exists
-- to avoid.
ALTER TABLE "credit_sessions" ADD CONSTRAINT "credit_sessions_settlement_instrument_pair" CHECK (("credit_sessions"."settlement_stripe_payment_method_id" IS NULL) = ("credit_sessions"."settlement_stripe_customer_id" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "credit_sessions" ADD CONSTRAINT "credit_sessions_settlement_instrument_pinned_at_pair" CHECK (("credit_sessions"."settlement_stripe_payment_method_id" IS NULL) = ("credit_sessions"."settlement_instrument_pinned_at" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "credit_sessions" VALIDATE CONSTRAINT "credit_sessions_settlement_instrument_pair";--> statement-breakpoint
ALTER TABLE "credit_sessions" VALIDATE CONSTRAINT "credit_sessions_settlement_instrument_pinned_at_pair";