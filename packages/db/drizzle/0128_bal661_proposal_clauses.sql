CREATE TYPE "public"."proposal_clause_kind" AS ENUM('assumption', 'exclusion', 'additional_term');--> statement-breakpoint
ALTER TYPE "public"."proposal_change_section" ADD VALUE 'assumptions_exclusions';--> statement-breakpoint
ALTER TYPE "public"."proposal_change_section" ADD VALUE 'terms';--> statement-breakpoint
CREATE TABLE "proposal_clauses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"kind" "proposal_clause_kind" NOT NULL,
	"sort_order" integer NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "proposal_clause_sort_nonneg" CHECK ("proposal_clauses"."sort_order" >= 0),
	CONSTRAINT "proposal_clause_body_not_blank" CHECK (btrim("proposal_clauses"."body") <> '')
);
--> statement-breakpoint
CREATE TABLE "engagement_clauses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"source_proposal_clause_id" uuid,
	"kind" "proposal_clause_kind" NOT NULL,
	"sort_order" integer NOT NULL,
	"body" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "engagement_clause_sort_nonneg" CHECK ("engagement_clauses"."sort_order" >= 0),
	CONSTRAINT "engagement_clause_body_not_blank" CHECK (btrim("engagement_clauses"."body") <> '')
);
--> statement-breakpoint
ALTER TABLE "proposal_clauses" ADD CONSTRAINT "proposal_clauses_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_clauses" ADD CONSTRAINT "engagement_clauses_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_clauses" ADD CONSTRAINT "engagement_clauses_source_proposal_clause_id_proposal_clauses_id_fk" FOREIGN KEY ("source_proposal_clause_id") REFERENCES "public"."proposal_clauses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_clauses" ADD CONSTRAINT "engagement_clauses_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposal_clause_proposal_idx" ON "proposal_clauses" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "proposal_clause_order_idx" ON "proposal_clauses" USING btree ("proposal_id","kind","sort_order") WHERE "proposal_clauses"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "engagement_clause_engagement_idx" ON "engagement_clauses" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "engagement_clause_order_idx" ON "engagement_clauses" USING btree ("engagement_id","kind","sort_order") WHERE "engagement_clauses"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "engagement_clause_source_idx" ON "engagement_clauses" USING btree ("source_proposal_clause_id");--> statement-breakpoint
CREATE INDEX "engagement_clause_created_by_idx" ON "engagement_clauses" USING btree ("created_by_user_id");--> statement-breakpoint
-- BAL-661 DATA CONVERSION
-- Hand-appended after the generated DDL: the data moves from `proposals.exclusions` and the
-- `terms` document kind to the new tables. No statement here uses a value added by the
-- `ADD VALUE`s above (55P04); `exclusion` comes from the `CREATE TYPE`, which is usable at once.
-- Every statement is safe while the previous build is still live: (a) and (c) write only to
-- tables it never reads, and (b) leaves rows it still renders (as reference documents). Each is
-- guarded so it can run twice and insert nothing new.
--
-- (a) Legacy "Not included" HTML becomes ordered `exclusion` clauses: block ends become line
-- breaks, tags are stripped, entities decoded (`&amp;` last), then each line loses its list
-- marker, has its whitespace collapsed and is trimmed. Blank lines are dropped, and the result
-- is capped at the composer's limits (20 items, 500 characters each). A proposal that has ever
-- had an exclusion clause, live or removed, is skipped, so a second run cannot bring back
-- clauses the expert has since deleted.
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
-- (b) The separate terms upload is gone; an uploaded terms file is an attachment like any other.
UPDATE "proposal_documents" SET "kind" = 'ref', "updated_at" = now() WHERE "kind" = 'terms';--> statement-breakpoint
-- (c) Engagements kicked off before `engagement_clauses` existed get the clauses of the proposal
-- they came from, which (a) has just written. A system migration has no actor, so
-- `created_by_user_id` is NULL and no audit row is written: the ADR-1030 kickoff audit,
-- `engagement.clauses_snapshotted`, is recorded only by a real kickoff. An engagement that
-- already has a live clause is skipped.
INSERT INTO "engagement_clauses" ("engagement_id", "source_proposal_clause_id", "kind", "sort_order", "body", "created_by_user_id")
SELECT pe."engagement_id", pc."id", pc."kind", pc."sort_order", pc."body", NULL
FROM "project_engagements" pe
JOIN "proposal_clauses" pc ON pc."proposal_id" = pe."source_proposal_id" AND pc."deleted_at" IS NULL
WHERE pe."source_proposal_id" IS NOT NULL
  AND pe."deleted_at" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "engagement_clauses" ec
    WHERE ec."engagement_id" = pe."engagement_id" AND ec."deleted_at" IS NULL
  );