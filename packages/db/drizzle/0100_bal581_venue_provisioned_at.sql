-- BAL-581 — `meetings.venue_provisioned_at`: WHEN the call room became usable.
--
-- THIS FILE WAS HAND-EDITED after `drizzle-kit generate`: exactly ONE statement was added — the
-- backfill UPDATE below. Nothing was reordered or removed.
--
-- WHY `created_at` IS THE RIGHT BACKFILL: before this migration the ONLY production writer of a
-- venue was `provisionVenue`, which runs inside the `POST /meetings` request that created the row
-- (and its lost-201 replay, seconds later). There was no repair path, so no row was ever stamped
-- materially later than it was created. The lifecycle anchor is `max(scheduled_start,
-- venue_ready_at)`, so for every normal booking the backfilled value is inert.
--
-- `updated_at` IS DELIBERATELY NOT BUMPED: this records no business change to the meeting.
-- The backfill names no `meeting_outcome` label (0101 adds one in this same migrate batch).
-- The integration harness migrates an EMPTY database, so this touches 0 rows there.
ALTER TABLE "meetings" ADD COLUMN "venue_provisioned_at" timestamp with time zone;--> statement-breakpoint
UPDATE "meetings"
SET "venue_provisioned_at" = "created_at"
WHERE "daily_room_name" IS NOT NULL
  AND "join_url" IS NOT NULL
  AND "venue_provisioned_at" IS NULL;
