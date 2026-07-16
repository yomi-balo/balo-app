CREATE TYPE "public"."mandate_status" AS ENUM('pending', 'active', 'requires_action', 'failed');--> statement-breakpoint
CREATE TABLE "stripe_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"payload_hash" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "credit_wallets" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "credit_wallets" ADD COLUMN "mandate_status" "mandate_status";--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "stripe_charge_id" text;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "stripe_balance_transaction_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_webhook_events_event_id_idx" ON "stripe_webhook_events" USING btree ("event_id");