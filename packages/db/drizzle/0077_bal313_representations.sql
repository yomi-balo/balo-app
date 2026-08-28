-- BAL-313 / ADR-1028 Phase 1 — `representations`: ONE act-on-behalf grant ("user A may act
-- for company B, carrying capability set C, until D"), at either ORG grain or the grain of
-- ONE project request.
--
-- ⚠ SHIPS INERT. Nothing reads or writes this table in this PR — no UI, no Server Action, no
--    API route, no notification, no analytics. `hasCapability` is untouched. BAL-314 is the
--    first consumer and owns the grant surface, the "who may grant" gate and the
--    role ∪ representation wiring.
--
-- ⚠ DEVIATES FROM ADR-1029, DELIBERATELY, AND NEEDS AN AMENDMENT. ADR-1029 specifies
--    `representative_user_id` / `represented_company_id`, a `representation_role_enum`
--    (`ae` | `account_manager`) resolving to a BUNDLE, and a `representation_requests` pivot.
--    This ships BAL-313's naming, EXPLICIT capabilities (a role→bundle would hand an AE
--    `consume_credits`, which sits in MEMBER_BUNDLE, and let them draw down the customer's
--    wallet) and NO pivot (a pivot makes uniqueness span two tables and cannot express the
--    "no duplicate active grants" AC). Plus the `'expired'` status label.
--
-- ⚠ THE `status = 'active'` LITERALS IN THE TWO PARTIAL-UNIQUE PREDICATES ARE SAFE HERE.
--    `check_safe_enum_use` only blocks a value added to a PRE-EXISTING type; this migration
--    CREATES `representation_status` and uses its literals in the same transaction, exactly as
--    0076 does. A FUTURE `ALTER TYPE … ADD VALUE` must NOT use the new value in the same
--    migration.
--
-- ⚠ `'expired'` IS LOAD-BEARING, NOT COSMETIC. `now()` is not IMMUTABLE and may not appear in
--    an index predicate, so the partial uniques cannot know about expiry and a LAPSED grant
--    still occupies its slot with `status = 'active'`. `representationsRepository.grant()`
--    runs `expireLapsedForSubject` as the first statement of its transaction to free it;
--    without that label, re-granting after an expiry would fail 23505 forever.
--
-- ⚠ `project_request_id_company_uq` ON `project_requests` IS NOT REDUNDANT, AND ITS POSITION
--    IN THIS FILE IS LOAD-BEARING. `representations` FKs the PAIR
--    `(project_request_id, on_behalf_of_company_id)` → `project_requests(id, company_id)`, so a
--    request-grain grant is STRUCTURALLY unable to name a request owned by a DIFFERENT company
--    (a single-column FK proves the request EXISTS, not WHOSE it is — and
--    `representation_project_request_idx`, BAL-314's "who may act on this request?" read, would
--    otherwise hand back a representative from another tenant). Postgres requires a matching
--    UNIQUE CONSTRAINT on the referenced columns before it will accept a composite FK, so the
--    constraint is added BEFORE the table — drizzle-kit emits it LAST, and in that order the FK
--    fails 42830 ("there is no unique constraint matching given keys"). It is safe on a
--    non-empty table: `id` is already the primary key, so `(id, company_id)` can never hold a
--    duplicate and the index build cannot fail. `ON UPDATE no action` is deliberate — a
--    `project_requests.company_id` change under a live grant must be BLOCKED, not silently
--    followed into another tenant.
--    ⚠ MATCH SIMPLE (the Postgres default) is what lets ONE composite FK serve BOTH grains: if
--    ANY referencing column is NULL the constraint is NOT enforced at all, so org-grain rows
--    (`project_request_id IS NULL`) skip it entirely while request-grain rows are fully checked.
--
-- ⚠ NO RLS. Not one schema file in this repo CALLS `.enableRLS()` or `pgPolicy()`. WorkOS +
--    iron-session makes `auth.uid()` meaningless, every reader is the admin `db` client, and
--    the boundary is the application layer (ADR-1029 / ADR-1040 Decision 4).
--
-- Brand-new table ⇒ no non-empty-table hazard (no `ADD COLUMN … NOT NULL`, no backfill), so
-- nothing here depends on the integration harness's empty-container migration.

CREATE TYPE "public"."representation_scope" AS ENUM('request', 'org');--> statement-breakpoint
CREATE TYPE "public"."representation_status" AS ENUM('active', 'revoked', 'expired');--> statement-breakpoint
ALTER TABLE "project_requests" ADD CONSTRAINT "project_request_id_company_uq" UNIQUE("id","company_id");--> statement-breakpoint
CREATE TABLE "representations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"on_behalf_of_company_id" uuid NOT NULL,
	"scope" "representation_scope" NOT NULL,
	"project_request_id" uuid,
	"capabilities" jsonb NOT NULL,
	"granted_by_user_id" uuid NOT NULL,
	"status" "representation_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "representation_scope_request_paired" CHECK (("representations"."scope" = 'request') = ("representations"."project_request_id" IS NOT NULL)),
	CONSTRAINT "representation_revocation_paired" CHECK (("representations"."status" = 'revoked') = ("representations"."revoked_at" IS NOT NULL)),
	CONSTRAINT "representation_revoker_implies_revoked" CHECK ("representations"."revoked_by_user_id" IS NULL OR "representations"."status" = 'revoked'),
	CONSTRAINT "representation_expired_requires_expiry" CHECK ("representations"."status" <> 'expired' OR "representations"."expires_at" IS NOT NULL),
	CONSTRAINT "representation_capabilities_nonempty" CHECK (jsonb_typeof("representations"."capabilities") = 'array' AND "representations"."capabilities" <> '[]'::jsonb)
);
--> statement-breakpoint
ALTER TABLE "representations" ADD CONSTRAINT "representations_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "representations" ADD CONSTRAINT "representations_on_behalf_of_company_id_companies_id_fk" FOREIGN KEY ("on_behalf_of_company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "representations" ADD CONSTRAINT "representations_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "representations" ADD CONSTRAINT "representations_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "representations" ADD CONSTRAINT "representation_request_company_fk" FOREIGN KEY ("project_request_id","on_behalf_of_company_id") REFERENCES "public"."project_requests"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "representation_active_org_idx" ON "representations" USING btree ("actor_user_id","on_behalf_of_company_id") WHERE "representations"."status" = 'active' AND "representations"."deleted_at" IS NULL AND "representations"."project_request_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "representation_active_request_idx" ON "representations" USING btree ("actor_user_id","on_behalf_of_company_id","project_request_id") WHERE "representations"."status" = 'active' AND "representations"."deleted_at" IS NULL AND "representations"."project_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "representation_actor_idx" ON "representations" USING btree ("actor_user_id") WHERE "representations"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "representation_company_idx" ON "representations" USING btree ("on_behalf_of_company_id") WHERE "representations"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "representation_project_request_idx" ON "representations" USING btree ("project_request_id") WHERE "representations"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "representation_granted_by_idx" ON "representations" USING btree ("granted_by_user_id");--> statement-breakpoint
CREATE INDEX "representation_revoked_by_idx" ON "representations" USING btree ("revoked_by_user_id");
