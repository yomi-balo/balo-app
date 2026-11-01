-- `engagements.delivering_agency_id`: the agency delivering the engagement, pinned when the row
-- is created. NULL means an independent expert.
--
-- THIS FILE WAS HAND-EDITED after `drizzle-kit generate`: exactly ONE statement was added — the
-- backfill UPDATE between the column and the FK. Nothing was reordered or removed.
--
-- THE BACKFILL copies each engagement's expert profile `agency_id` onto the new column.
--  - It writes only rows whose pin is still NULL and whose profile has an agency, so it never
--    overwrites a pin and a second run changes nothing.
--  - Soft-deleted engagements are included: their delivery history is kept too.
--
-- `updated_at` IS DELIBERATELY NOT BUMPED: this records no business change to the engagement.
-- The integration harness migrates an EMPTY database, so this touches 0 rows there.
ALTER TABLE "engagements" ADD COLUMN "delivering_agency_id" uuid;--> statement-breakpoint
UPDATE "engagements" AS e
SET "delivering_agency_id" = ep."agency_id"
FROM "expert_profiles" AS ep
WHERE ep."id" = e."expert_profile_id"
  AND e."delivering_agency_id" IS NULL
  AND ep."agency_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_delivering_agency_id_agencies_id_fk" FOREIGN KEY ("delivering_agency_id") REFERENCES "public"."agencies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "engagement_delivering_agency_idx" ON "engagements" USING btree ("delivering_agency_id");
