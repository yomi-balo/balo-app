-- BAL-475 — Balo-organised ICS calendar invites: a persisted RFC 5545 UID + SEQUENCE on each
-- (meeting, party) `meeting_calendar_events` row, the "provider_event ⇒ expert" CHECK, and the
-- per-recipient send ledger `meeting_calendar_deliveries` (decision O4).
--
-- HEADER-ONLY HAND EDIT after `drizzle-kit generate`: every statement below is exactly what was
-- generated, unreordered and unmodified. drizzle-kit already emitted the uid UNIQUE INDEX after
-- the uid ADD COLUMN, so no reordering was needed. (Precedent for an explanatory header on
-- generated SQL: 0076_bal433_meeting_calendar_events_per_party.sql,
-- 0095_bal489_guest_conversion_linkage.sql.)
-- ⚠ If main lands its own 0096 first, REGENERATE against main's snapshot — never hand-rename.
--
-- ⚠ REGENERATED for fix round 1 (F11, R10): added `meeting_calendar_delivery_calendar_event_idx`
-- — a NON-PARTIAL index on `calendar_event_id`, which the FK's cascade delete needs and neither
-- of the table's two PARTIAL uniques (both `WHERE recipient_… IS NOT NULL AND deleted_at IS
-- NULL`) can serve, since Postgres will not select a partial index for a query whose WHERE
-- clause does not repeat its predicate. 0096 was still unmerged, so this is a genuine
-- regeneration (0096 stays 0096), not a hand-added 0097.
--
-- ── WHY EACH STATEMENT IS SAFE ON A POPULATED TABLE, WHICH CI CANNOT TELL YOU ───────────
-- ⚠ THE INTEGRATION HARNESS MIGRATES AN **EMPTY** DATABASE, so CI passing on this migration
-- proves nothing about `meeting_calendar_events`, which is NOT empty in production (every
-- `case` / `request_interaction` booking since 0068 wrote a row). Each statement carries its
-- own argument:
--
--   1. `ADD COLUMN "uid" uuid DEFAULT gen_random_uuid() NOT NULL` — the default is VOLATILE, so
--      Postgres REWRITES the table evaluating it PER EXISTING ROW: every row gets a distinct
--      value, the NOT NULL cannot fail, and the unique index built AFTER it cannot collide.
--      ⚠ The `meeting_calendar_event_uid_uq` statement MUST stay after this ADD COLUMN.
--      ACCESS EXCLUSIVE for the rewrite, on a small pre-launch table.
--   2. `ADD COLUMN "sequence" integer DEFAULT 0 NOT NULL` — non-volatile default, metadata-only
--      (no rewrite). 0 is the correct RFC 5545 value for every existing series: none was ever
--      sent an ICS before this ticket.
--   3. `meeting_calendar_event_uid_uq` — a plain (non-CONCURRENT) build, because drizzle-kit
--      migrations run in a transaction; every value is distinct by (1).
--   4. `meeting_calendar_event_sequence_non_negative` — the validation scan sees only 0s (2).
--   5. `meeting_calendar_event_provider_event_is_expert` — the validation scan cannot reject a
--      row: the only `provider_event` writer is `writeConsultationEvent`, which hard-codes
--      `party: 'expert'` (apps/api `write-consultation-event.ts`); 0076 back-filled every
--      pre-existing row to `party = 'expert'`; no seed or other path writes this table outside
--      `meetingCalendarEventsRepository`. Both literals predate this migration
--      (`meeting_participant_party` in 0056, `meeting_calendar_delivery_mode` in 0076), so there
--      is no same-transaction enum hazard. Verified on a populated throwaway Postgres 16 (see
--      the BAL-475 PR: count = count(DISTINCT uid), sequence 0..0).
--   6. `CREATE TYPE meeting_calendar_delivery_outcome` + `CREATE TABLE` whose CHECKs name its
--      labels, in the same migration — SAFE: the hazard is `ALTER TYPE … ADD VALUE` then use
--      (`reference_enum_default_same_tx_migration_hazard`); 0076 does the identical
--      CREATE-then-CHECK. The new table, its FKs and its indexes are built empty (this includes
--      the new `meeting_calendar_delivery_calendar_event_idx`, added in fix round 1).
--
-- ── THE LEDGER'S TWO PARTIAL UNIQUES ────────────────────────────────────────────────────
-- TWO, not one over both nullable recipient columns: Postgres treats NULLs as distinct, so a
-- single unique could never conflict. Both predicates are `IS [NOT] NULL` only — no literal —
-- so the ON CONFLICT arbiters restating them carry no bind parameter (42P10 trap).
CREATE TYPE "public"."meeting_calendar_delivery_outcome" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "meeting_calendar_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"calendar_event_id" uuid NOT NULL,
	"recipient_user_id" uuid,
	"recipient_guest_id" uuid,
	"channel" text NOT NULL,
	"method" text NOT NULL,
	"sequence" integer NOT NULL,
	"outcome" "meeting_calendar_delivery_outcome" NOT NULL,
	"claim_token" text NOT NULL,
	"attempt_count" integer NOT NULL,
	"last_attempted_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"failure_reason" text,
	"provider_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "meeting_calendar_delivery_recipient_exactly_one" CHECK (("meeting_calendar_deliveries"."recipient_user_id" IS NULL) <> ("meeting_calendar_deliveries"."recipient_guest_id" IS NULL)),
	CONSTRAINT "meeting_calendar_delivery_channel_known" CHECK ("meeting_calendar_deliveries"."channel" IN ('email')),
	CONSTRAINT "meeting_calendar_delivery_method_known" CHECK ("meeting_calendar_deliveries"."method" IN ('REQUEST')),
	CONSTRAINT "meeting_calendar_delivery_sequence_non_negative" CHECK ("meeting_calendar_deliveries"."sequence" >= 0),
	CONSTRAINT "meeting_calendar_delivery_attempt_count_positive" CHECK ("meeting_calendar_deliveries"."attempt_count" >= 1),
	CONSTRAINT "meeting_calendar_delivery_sent_at_paired" CHECK (("meeting_calendar_deliveries"."outcome" = 'sent') = ("meeting_calendar_deliveries"."sent_at" IS NOT NULL)),
	CONSTRAINT "meeting_calendar_delivery_failure_reason_paired" CHECK (("meeting_calendar_deliveries"."outcome" = 'failed') = ("meeting_calendar_deliveries"."failure_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "meeting_calendar_events" ADD COLUMN "uid" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_calendar_events" ADD COLUMN "sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_calendar_deliveries" ADD CONSTRAINT "meeting_calendar_deliveries_calendar_event_id_meeting_calendar_events_id_fk" FOREIGN KEY ("calendar_event_id") REFERENCES "public"."meeting_calendar_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_calendar_deliveries" ADD CONSTRAINT "meeting_calendar_deliveries_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_calendar_deliveries" ADD CONSTRAINT "meeting_calendar_deliveries_recipient_guest_id_meeting_guests_id_fk" FOREIGN KEY ("recipient_guest_id") REFERENCES "public"."meeting_guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_calendar_delivery_user_send_uq" ON "meeting_calendar_deliveries" USING btree ("calendar_event_id","recipient_user_id","sequence","method") WHERE "meeting_calendar_deliveries"."recipient_user_id" IS NOT NULL AND "meeting_calendar_deliveries"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_calendar_delivery_guest_send_uq" ON "meeting_calendar_deliveries" USING btree ("calendar_event_id","recipient_guest_id","sequence","method") WHERE "meeting_calendar_deliveries"."recipient_guest_id" IS NOT NULL AND "meeting_calendar_deliveries"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "meeting_calendar_delivery_calendar_event_idx" ON "meeting_calendar_deliveries" USING btree ("calendar_event_id");--> statement-breakpoint
CREATE INDEX "meeting_calendar_delivery_recipient_user_idx" ON "meeting_calendar_deliveries" USING btree ("recipient_user_id");--> statement-breakpoint
CREATE INDEX "meeting_calendar_delivery_recipient_guest_idx" ON "meeting_calendar_deliveries" USING btree ("recipient_guest_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_calendar_event_uid_uq" ON "meeting_calendar_events" USING btree ("uid");--> statement-breakpoint
ALTER TABLE "meeting_calendar_events" ADD CONSTRAINT "meeting_calendar_event_sequence_non_negative" CHECK ("meeting_calendar_events"."sequence" >= 0);--> statement-breakpoint
ALTER TABLE "meeting_calendar_events" ADD CONSTRAINT "meeting_calendar_event_provider_event_is_expert" CHECK ("meeting_calendar_events"."delivery_mode" <> 'provider_event' OR "meeting_calendar_events"."party" = 'expert');