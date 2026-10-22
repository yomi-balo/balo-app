-- `calendar_connections.last_synced_at` has no writer and is NULL on every row, so dropping it
-- loses nothing. Older builds still select the column: apply this only after the web and API
-- builds that no longer read it are live.
ALTER TABLE "calendar_connections" DROP COLUMN "last_synced_at";