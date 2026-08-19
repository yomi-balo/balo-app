-- BAL-468 — Apiroc calendar webhooks: subscription lifecycle + the svix-id marker log.
-- ADR-1021 amendment 2026-08-15 (the webhook is a BARE TRIGGER into rebuildAvailabilityCache).
--
-- BOTH TABLES ARE NEW. There is no backfill, no NOT NULL added to existing rows, and no
-- drop-and-re-add rename — so the non-empty-table hazards the integration harness cannot see
-- (it migrates an EMPTY container) DO NOT APPLY HERE. Stated explicitly so a reviewer does
-- not go looking for a pre-flight gate like 0069's; there is deliberately none to find.
--
-- ⚠ THE THREE cal_wsub_* INDEXES ARE PARTIAL ON deleted_at IS NULL, and the predicates below
-- are the SOURCE OF TRUTH (same posture as cal_conn_expert_provider_idx in 0067 and
-- availability_cache_earliest_idx). calendar_subscriptions soft-deletes on renewal and on
-- disconnect teardown; a NON-partial unique on webhook_subscription_id would let a
-- soft-deleted row keep occupying its vendor id forever. Verify all three WHERE clauses
-- survive any regeneration of this file.
--
-- ⚠⚠ THERE IS DELIBERATELY NO UNIQUE ON (connection_id, calendar_id) — that index is
-- NON-unique on purpose (BAL-468 plan ruling #5). Renewal is create-then-delete, so the new
-- subscription is inserted while the incumbent is still live: TWO LIVE ROWS FOR ONE PAIR IS
-- THE LEGITIMATE STEADY STATE. Adding a unique there (partial or not) rejects the second
-- INSERT with 23505 and breaks every renewal. Do not "fix" it.
--
-- ⚠ apiroc_webhook_events_svix_id_idx is NON-partial, and that is safe BECAUSE that table is
-- append-only (no deleted_at, no writer that could add one). Its repository's
-- onConflictDoNothing therefore needs no arbiter predicate — a partial one would force every
-- such statement to restate inlined literals or fail 42P10.
CREATE TABLE "calendar_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"calendar_id" text NOT NULL,
	"webhook_subscription_id" text NOT NULL,
	"endpoint_secret" text NOT NULL,
	"webhook_url" text NOT NULL,
	"expiration" timestamp with time zone,
	"expiration_synced_at" timestamp with time zone,
	"last_delivery_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "apiroc_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"svix_id" text NOT NULL,
	"calendar_subscription_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "calendar_subscriptions" ADD CONSTRAINT "calendar_subscriptions_connection_id_calendar_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."calendar_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apiroc_webhook_events" ADD CONSTRAINT "apiroc_webhook_events_calendar_subscription_id_calendar_subscriptions_id_fk" FOREIGN KEY ("calendar_subscription_id") REFERENCES "public"."calendar_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cal_wsub_vendor_id_idx" ON "calendar_subscriptions" USING btree ("webhook_subscription_id") WHERE "calendar_subscriptions"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "cal_wsub_conn_calendar_idx" ON "calendar_subscriptions" USING btree ("connection_id","calendar_id") WHERE "calendar_subscriptions"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "cal_wsub_expiration_idx" ON "calendar_subscriptions" USING btree ("expiration") WHERE "calendar_subscriptions"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "apiroc_webhook_events_svix_id_idx" ON "apiroc_webhook_events" USING btree ("svix_id");--> statement-breakpoint
CREATE INDEX "apiroc_webhook_events_subscription_idx" ON "apiroc_webhook_events" USING btree ("calendar_subscription_id","received_at");