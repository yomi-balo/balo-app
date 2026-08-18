-- BAL-396 — ADR-1021 amendment 18 Aug 2026 §3: the credential-status vocabulary.
--
-- ⚠ STATEMENT ORDER IS LOAD-BEARING AND THE INTEGRATION HARNESS CANNOT PROVE IT. The harness
-- migrates an EMPTY container, so the UPDATE below touches 0 rows there and a wrong order
-- passes green. On a NON-EMPTY database:
--   · dropping the OLD check FIRST is mandatory — otherwise the UPDATE to 'ACTIVE' violates
--     `cal_conn_status_check` (which only permits connected|sync_pending|auth_error) and the
--     whole migration rolls back;
--   · dropping the OLD default before the UPDATE keeps 'connected' from being re-introduced
--     by any concurrent insert between the UPDATE and the new CHECK;
--   · the NEW check is added LAST, after every row already satisfies it.
--
-- ⚠ HAND-ORDERED, AND TWO STATEMENTS ARE HAND-ADDED. `drizzle-kit generate` emitted the
-- RENAME and both ADD COLUMNs but NOTHING about the column DEFAULT: the old default is
-- `'connected'`, the snapshot records `'ACTIVE'`, and without steps 3 and 5 below the
-- database would keep handing new rows a value the new CHECK rejects — silent drift that
-- typecheck, the snapshot and the empty-container harness all miss. Step 4 (the value
-- translation) is likewise something no generator can infer.

-- 1. Old CHECK first. Nothing may constrain the column while its vocabulary is in flight.
ALTER TABLE "calendar_connections" DROP CONSTRAINT "cal_conn_status_check";--> statement-breakpoint

-- 2. RENAME, never DROP+ADD. ⚠ drizzle-kit offers "rename column?" interactively; answering
--    it wrong emits DROP COLUMN "status" + ADD COLUMN "credential_status", which silently
--    DISCARDS EVERY EXISTING VALUE and still passes the empty-DB harness. Verify the emitted
--    SQL says RENAME before committing.
ALTER TABLE "calendar_connections" RENAME COLUMN "status" TO "credential_status";--> statement-breakpoint

-- 3. Drop the stale default ('connected') before translating values.
ALTER TABLE "calendar_connections" ALTER COLUMN "credential_status" DROP DEFAULT;--> statement-breakpoint

-- 4. Translate. `auth_error` collapses to EXPIRED: a user-initiated revoke surfaces as
--    EXPIRED and REVOKED is unreachable on Google (apiroc skill, credential-expiry table),
--    and the ticket rules that any non-ACTIVE value means "reconnect required" with no
--    distinct UX. The ELSE arm is unreachable (the dropped CHECK admitted only three
--    values) and fails CLOSED if it ever is reached.
UPDATE "calendar_connections" SET "credential_status" = CASE "credential_status"
  WHEN 'connected'    THEN 'ACTIVE'
  WHEN 'sync_pending' THEN 'SYNC_PENDING'
  WHEN 'auth_error'   THEN 'EXPIRED'
  ELSE 'EXPIRED'
END;--> statement-breakpoint

-- 5. New default.
ALTER TABLE "calendar_connections" ALTER COLUMN "credential_status" SET DEFAULT 'ACTIVE';--> statement-breakpoint

-- 6. New CHECK last.
ALTER TABLE "calendar_connections" ADD CONSTRAINT "cal_conn_credential_status_check" CHECK ("calendar_connections"."credential_status" IN ('ACTIVE', 'SYNC_PENDING', 'EXPIRED', 'REVOKED'));--> statement-breakpoint

-- 7. Probe + notification-idempotency columns. Both NULLABLE — a NOT NULL add on a non-empty
--    table without a default is the other hazard the empty harness hides.
ALTER TABLE "calendar_connections" ADD COLUMN "credential_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD COLUMN "reconnect_notified_at" timestamp with time zone;--> statement-breakpoint

-- 8. The probe's scan index (oldest-checked first, live rows only).
CREATE INDEX "cal_conn_credential_check_idx" ON "calendar_connections" USING btree ("credential_checked_at") WHERE "calendar_connections"."deleted_at" IS NULL;--> statement-breakpoint

-- 9. §5's event-write record. See schema/meeting-calendar-events.ts for why this is neither
--    a `meetings` column (invariants/meetings-no-context-column.test.ts bans `_id` columns,
--    non-PK uuids and FKs) nor a `consultations` column (single-writer projection).
CREATE TABLE "meeting_calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"calendar_id" text NOT NULL,
	"vendor_event_id" text NOT NULL,
	"balo_booking_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "meeting_calendar_events" ADD CONSTRAINT "meeting_calendar_events_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_calendar_events" ADD CONSTRAINT "meeting_calendar_events_connection_id_calendar_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."calendar_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_calendar_event_meeting_uq" ON "meeting_calendar_events" USING btree ("meeting_id") WHERE "meeting_calendar_events"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "meeting_calendar_event_connection_idx" ON "meeting_calendar_events" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "meeting_calendar_event_tag_idx" ON "meeting_calendar_events" USING btree ("balo_booking_id");
