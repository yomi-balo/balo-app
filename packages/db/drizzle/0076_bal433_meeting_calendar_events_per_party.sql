-- BAL-433 Slice 1 — `meeting_calendar_events` moves to the (meeting, party) grain and gains
-- a delivery-mode discriminator (ADR-1044 amendment 2026-08-25, Ruling 1).
--
-- ⚠⚠ HAND-ADJUSTED AFTER `pnpm db:generate`, DELIBERATELY. drizzle-kit emitted a bare
--    `ADD COLUMN … NOT NULL` for both new columns, which fails **23502** on a table that is
--    NOT EMPTY in production (every `case` / `request_interaction` booking since migration
--    0068 wrote a row). The three-step add-nullable → backfill → SET NOT NULL form below is
--    the house precedent (`0006_oval_hawkeye.sql:2`). A Drizzle `.default()` would make the
--    migration pass and leave a default that silently answers for a future writer that
--    forgets the column — the worse of the two failures.
-- ⚠ THE INTEGRATION HARNESS MIGRATES AN EMPTY CONTAINER FROM SCRATCH, so a 23502 here would
--    pass every gate. This form cannot be validated by CI; do not "simplify" it back.
-- ⚠ RENUMBERED 0075 → 0076 when BAL-473 (#237) landed its own 0075 on main. Regenerated
--    against main's 0075 snapshot rather than hand-renamed, so the snapshot `prevId` chain is
--    intact.

CREATE TYPE "public"."meeting_calendar_delivery_mode" AS ENUM('provider_event', 'ics');--> statement-breakpoint

-- 1. party — ADDED NULLABLE, BACKFILLED, THEN SET NOT NULL. ⚠ NOT `ADD COLUMN … NOT NULL
--    DEFAULT 'expert'`. Every pre-existing row IS an expert-party row: the only writer was
--    the expert-calendar projection, and `calendar_connections` is keyed on
--    `expert_profile_id`.
ALTER TABLE "meeting_calendar_events" ADD COLUMN "party" "meeting_participant_party";--> statement-breakpoint
UPDATE "meeting_calendar_events" SET "party" = 'expert' WHERE "party" IS NULL;--> statement-breakpoint
ALTER TABLE "meeting_calendar_events" ALTER COLUMN "party" SET NOT NULL;--> statement-breakpoint

-- 2. delivery_mode — same three-step form. Every pre-existing row IS a provider write.
ALTER TABLE "meeting_calendar_events" ADD COLUMN "delivery_mode" "meeting_calendar_delivery_mode";--> statement-breakpoint
UPDATE "meeting_calendar_events" SET "delivery_mode" = 'provider_event' WHERE "delivery_mode" IS NULL;--> statement-breakpoint
ALTER TABLE "meeting_calendar_events" ALTER COLUMN "delivery_mode" SET NOT NULL;--> statement-breakpoint

-- 3. The four PROVIDER-EVENT columns become nullable: an `ics` row has no vendor event to
--    point at, and `connection_id`'s FK targets a table keyed on `expert_profile_id`.
ALTER TABLE "meeting_calendar_events" ALTER COLUMN "connection_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_calendar_events" ALTER COLUMN "calendar_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_calendar_events" ALTER COLUMN "vendor_event_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_calendar_events" ALTER COLUMN "balo_booking_id" DROP NOT NULL;--> statement-breakpoint

-- 4. The unique moves to (meeting_id, party). ⚠ THE `deleted_at IS NULL` PREDICATE STAYS —
--    a cancelled-then-rebooked meeting must be able to write a SECOND entry, and both
--    upserts restate this predicate as `targetWhere` or every write raises 42P10 at PLAN
--    time. ⚠ MUST come AFTER step 1 — the index references `party`.
DROP INDEX "meeting_calendar_event_meeting_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_calendar_event_meeting_party_uq" ON "meeting_calendar_events" USING btree ("meeting_id","party") WHERE "meeting_calendar_events"."deleted_at" IS NULL;--> statement-breakpoint

-- 5. Two CHECKs: the two-sided party narrowing, and the delivery-payload rule — the latter
--    written as ONE ARM PER LABEL (`provider_event` ⇒ all four present) OR (`ics` ⇒ all four
--    absent), so a row matching NEITHER arm is rejected. ⚠ NOT the equality form
--    `(mode='provider_event') = (all present) AND (mode='ics') = (all absent)`: that is
--    equivalent for today's two labels and FAIL-OPEN for a third, where both conjuncts read
--    `false = false` on a PARTIAL payload and the stale-vendor-id row this constraint exists
--    to forbid is accepted.
--    `meeting_participant_party` already exists (a standalone `CREATE TYPE` in 0056), so
--    naming its ORIGINAL labels in a CHECK here carries no same-transaction enum hazard;
--    `meeting_calendar_delivery_mode` is a fresh `CREATE TYPE` above, which is likewise safe.
ALTER TABLE "meeting_calendar_events" ADD CONSTRAINT "meeting_calendar_event_party_two_sided" CHECK ("meeting_calendar_events"."party" IN ('client','expert'));--> statement-breakpoint
ALTER TABLE "meeting_calendar_events" ADD CONSTRAINT "meeting_calendar_event_delivery_payload" CHECK (("meeting_calendar_events"."delivery_mode" = 'provider_event' AND "meeting_calendar_events"."connection_id" IS NOT NULL AND "meeting_calendar_events"."calendar_id" IS NOT NULL AND "meeting_calendar_events"."vendor_event_id" IS NOT NULL AND "meeting_calendar_events"."balo_booking_id" IS NOT NULL) OR ("meeting_calendar_events"."delivery_mode" = 'ics' AND "meeting_calendar_events"."connection_id" IS NULL AND "meeting_calendar_events"."calendar_id" IS NULL AND "meeting_calendar_events"."vendor_event_id" IS NULL AND "meeting_calendar_events"."balo_booking_id" IS NULL));--> statement-breakpoint

-- ⚠⚠ NOT BAL-433's CHANGE — INHERITED DRIFT FROM BAL-473 (#237), CARRIED HERE DELIBERATELY.
--    BAL-473 removed `transcripts.recording_ref` from the TS schema and its docblock states
--    "DROPPED BY BAL-473 (D3, migration 0076)" — but #237 shipped as 0075 and that migration
--    never drops the column. Main is therefore drifted: the schema says gone, the database
--    still has it, and `db:generate` hands the orphaned DROP to whoever generates next. That
--    happened to be this migration, which drew 0076 — the very number their comment names.
--    Omitting it is NOT the safe option: this migration's snapshot is generated from the TS
--    schema and already lacks the column, so a snapshot without the DROP would misrepresent
--    the live database and lose the change silently.
--    SAFE TO DROP: it was a producer-less nullable `text` and every write site passed `null`
--    (their docblock, and the column has no writer anywhere in the repo), so no data is lost.
ALTER TABLE "transcripts" DROP COLUMN "recording_ref";
