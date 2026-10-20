-- `request_expert_relationships.opened_at`: WHEN a track first moved off `invited` onto an engaged
-- status. A client sees an expert only once their track has opened.
--
-- THIS FILE WAS HAND-EDITED after `drizzle-kit generate`: exactly ONE statement was added — the
-- backfill UPDATE between the column and the CHECK. Nothing was reordered or removed.
--
-- THE BACKFILL. A track has opened if it ever held an EOI (live OR withdrawn — a withdrawal
-- soft-deletes the EOI row and keeps it) or Balo requested a proposal from it (the BAL-315 bypass
-- moves `invited → proposal_requested` with no EOI). The earliest of those is the opening instant.
--  - An engaged status (`eoi_submitted` … `accepted`) has always opened; `invited_at` is the floor
--    only so the CHECK holds should neither instant exist.
--  - A `declined` track opened only if one of those instants exists; a track declined straight
--    from `invited` stays NULL — it never opened.
--  - `invited` stays NULL.
--
-- `updated_at` IS DELIBERATELY NOT BUMPED: this records no business change to the track.
-- The integration harness migrates an EMPTY database, so this touches 0 rows there.
ALTER TABLE "request_expert_relationships" ADD COLUMN "opened_at" timestamp with time zone;--> statement-breakpoint
UPDATE "request_expert_relationships" AS r
SET "opened_at" = CASE
  WHEN r."status" = 'declined' THEN COALESCE(eoi."first_submitted_at", r."proposal_requested_at")
  ELSE COALESCE(eoi."first_submitted_at", r."proposal_requested_at", r."invited_at")
END
FROM (
  SELECT src."id", MIN(e."submitted_at") AS "first_submitted_at"
  FROM "request_expert_relationships" AS src
  LEFT JOIN "expressions_of_interest" AS e ON e."relationship_id" = src."id"
  GROUP BY src."id"
) AS eoi
WHERE eoi."id" = r."id"
  AND r."status" <> 'invited';--> statement-breakpoint
ALTER TABLE "request_expert_relationships" ADD CONSTRAINT "request_expert_relationship_opened_shape" CHECK (("request_expert_relationships"."status" = 'invited' AND "request_expert_relationships"."opened_at" IS NULL) OR "request_expert_relationships"."status" = 'declined' OR ("request_expert_relationships"."status" NOT IN ('invited', 'declined') AND "request_expert_relationships"."opened_at" IS NOT NULL));
