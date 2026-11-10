-- `engagements.delivering_agency_id`: two one-off data fixes to the pin. No schema change.
--
-- THIS FILE IS HAND-WRITTEN (`drizzle-kit generate --custom`). It is idempotent: a second run
-- leaves every row as the first run left it. `updated_at` IS DELIBERATELY NOT BUMPED: neither
-- statement records a business change to the engagement. The integration harness migrates an
-- EMPTY database, so this touches 0 rows there.
--
-- 1. RE-BACKFILL, BOUNDED. Between 0123's backfill and the moment the stamping build went live
--    (2026-11-02T01:19:30Z), an engagement could be created with a NULL pin. This copies the
--    profile's `agency_id` onto such a row, but ONLY when both hold:
--     - the row was created before that moment. A NULL pin created later is deliberate (the
--       profile had no agency link then);
--     - the expert belonged to that agency when the engagement was created: an `agency_members`
--       row for (expert, agency) joined (`joined_at`, stamped at insert) no later than the
--       engagement and not soft-deleted by then. Every path that links a profile to an agency
--       writes that membership row in the same transaction (a joining expert's `domain_match`
--       row, a founder's or agency-of-one's `owner` row), so a link made after the engagement
--       fails this test.
--    Filling a pin from a link made since would hand that agency rights over earlier work.
--
-- 2. CORRECTION. Before leaving an agency repointed the expert profile, a profile kept pointing at
--    the agency its expert had left, so an engagement created afterwards was pinned to it. This
--    clears the pin (NULL = no agency) on a row where all hold:
--     - the pin is set;
--     - the expert has no live `agency_members` row in the pinned agency;
--     - the engagement was created after the expert's latest soft-deleted membership in it ended
--       (no soft-deleted row ⇒ the max is NULL ⇒ the row does not match). The latest leave is
--       enough: the leave flow records an opt-out, so the expert cannot rejoin by domain.
--    No row statement 1 fills can match here: its expert's membership in the pinned agency was
--    live when the engagement was created, so it is either still live or ended after it.
UPDATE "engagements" AS e
SET "delivering_agency_id" = ep."agency_id"
FROM "expert_profiles" AS ep
WHERE ep."id" = e."expert_profile_id"
  AND e."delivering_agency_id" IS NULL
  AND ep."agency_id" IS NOT NULL
  AND e."created_at" < '2026-11-02T01:19:30Z'
  AND EXISTS (
    SELECT 1
    FROM "agency_members" AS member
    WHERE member."agency_id" = ep."agency_id"
      AND member."user_id" = ep."user_id"
      AND member."joined_at" <= e."created_at"
      AND (member."deleted_at" IS NULL OR member."deleted_at" > e."created_at")
  );--> statement-breakpoint
UPDATE "engagements" AS e
SET "delivering_agency_id" = NULL
FROM "expert_profiles" AS ep
WHERE ep."id" = e."expert_profile_id"
  AND e."delivering_agency_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "agency_members" AS live
    WHERE live."agency_id" = e."delivering_agency_id"
      AND live."user_id" = ep."user_id"
      AND live."deleted_at" IS NULL
  )
  AND e."created_at" > (
    SELECT max(gone."deleted_at")
    FROM "agency_members" AS gone
    WHERE gone."agency_id" = e."delivering_agency_id"
      AND gone."user_id" = ep."user_id"
      AND gone."deleted_at" IS NOT NULL
  );
