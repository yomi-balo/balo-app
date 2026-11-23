-- BAL-667 DATA RE-RUN
-- Hand-placed ahead of the generated DROP: 0128's data conversion steps (a) and (c), verbatim,
-- run again in the same transaction as the DROP, so any `proposals.exclusions` text written
-- after 0128 ran becomes clauses before the column goes. Their NOT EXISTS guards skip every
-- proposal and engagement 0128 already converted. 0128's (b) reads nothing this migration
-- drops, so it is not repeated.
--
-- (a) Legacy "Not included" HTML becomes ordered `exclusion` clauses (rules documented in 0128).
INSERT INTO "proposal_clauses" ("proposal_id", "kind", "sort_order", "body")
SELECT numbered."proposal_id", 'exclusion'::"proposal_clause_kind", numbered."sort_order", numbered."body"
FROM (
  SELECT cleaned."proposal_id",
    (row_number() OVER (PARTITION BY cleaned."proposal_id" ORDER BY cleaned."ordinality") - 1)::integer AS "sort_order",
    btrim(left(cleaned."line", 500)) AS "body"
  FROM (
    SELECT p."id" AS "proposal_id",
      lines."ordinality",
      btrim(regexp_replace(regexp_replace(lines."line", '^\s*([-•*–—]|\d+[.)])\s+', ''), '\s+', ' ', 'g')) AS "line"
    FROM "proposals" p
    CROSS JOIN LATERAL regexp_split_to_table(
      replace(replace(replace(replace(replace(replace(replace(replace(
        regexp_replace(
          regexp_replace(p."exclusions", '<br\s*/?>|</(p|li|div)\s*>', E'\n', 'gi'),
          '<[^<>]*>', '', 'g'
        ),
        '&nbsp;', ' '), chr(160), ' '), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&#x27;', ''''),
        '&amp;', '&'),
      E'\r?\n'
    ) WITH ORDINALITY AS lines("line", "ordinality")
    WHERE p."deleted_at" IS NULL
      AND btrim(coalesce(p."exclusions", '')) <> ''
      AND NOT EXISTS (
        SELECT 1 FROM "proposal_clauses" pc
        WHERE pc."proposal_id" = p."id" AND pc."kind" = 'exclusion'::"proposal_clause_kind"
      )
  ) cleaned
  WHERE cleaned."line" <> ''
) numbered
WHERE numbered."sort_order" < 20;--> statement-breakpoint
-- (c) Engagements kicked off without clauses get those of the proposal they came from, with
-- no actor and no audit row (rules documented in 0128).
INSERT INTO "engagement_clauses" ("engagement_id", "source_proposal_clause_id", "kind", "sort_order", "body", "created_by_user_id")
SELECT pe."engagement_id", pc."id", pc."kind", pc."sort_order", pc."body", NULL
FROM "project_engagements" pe
JOIN "proposal_clauses" pc ON pc."proposal_id" = pe."source_proposal_id" AND pc."deleted_at" IS NULL
WHERE pe."source_proposal_id" IS NOT NULL
  AND pe."deleted_at" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "engagement_clauses" ec
    WHERE ec."engagement_id" = pe."engagement_id" AND ec."deleted_at" IS NULL
  );--> statement-breakpoint
ALTER TABLE "proposals" DROP COLUMN "exclusions";