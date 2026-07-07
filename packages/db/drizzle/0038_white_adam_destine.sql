CREATE TYPE "public"."domain_join_mode" AS ENUM('auto', 'request', 'off');--> statement-breakpoint
CREATE TYPE "public"."join_method" AS ENUM('personal_workspace', 'invite', 'domain_match', 'owner');--> statement-breakpoint
CREATE TYPE "public"."membership_authority" AS ENUM('balo', 'directory');--> statement-breakpoint
CREATE TYPE "public"."party_join_request_status" AS ENUM('pending', 'approved', 'declined', 'withdrawn');--> statement-breakpoint
CREATE TABLE "party_join_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"party_type" "party_type" NOT NULL,
	"party_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "party_join_request_status" DEFAULT 'pending' NOT NULL,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "party_join_optouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"party_type" "party_type" NOT NULL,
	"party_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "company_members" DROP CONSTRAINT "company_members_user_id_unique";--> statement-breakpoint
DROP INDEX "company_user_idx";--> statement-breakpoint
DROP INDEX "agency_user_idx";--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "domain_join_mode" "domain_join_mode" DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "membership_authority" "membership_authority" DEFAULT 'balo' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_members" ADD COLUMN "join_method" "join_method" DEFAULT 'personal_workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_members" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "company_members" ADD COLUMN "deleted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "agencies" ADD COLUMN "domain_join_mode" "domain_join_mode" DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "agencies" ADD COLUMN "membership_authority" "membership_authority" DEFAULT 'balo' NOT NULL;--> statement-breakpoint
ALTER TABLE "agency_members" ADD COLUMN "join_method" "join_method" DEFAULT 'personal_workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "agency_members" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agency_members" ADD COLUMN "deleted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "party_join_requests" ADD CONSTRAINT "party_join_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_join_requests" ADD CONSTRAINT "party_join_requests_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_join_optouts" ADD CONSTRAINT "party_join_optouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "party_join_requests_pending_unique_idx" ON "party_join_requests" USING btree ("party_type","party_id","user_id") WHERE "party_join_requests"."status" = 'pending' AND "party_join_requests"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "party_join_requests_party_idx" ON "party_join_requests" USING btree ("party_type","party_id");--> statement-breakpoint
CREATE INDEX "party_join_requests_user_idx" ON "party_join_requests" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "party_join_optouts_unique_idx" ON "party_join_optouts" USING btree ("party_type","party_id","user_id") WHERE "party_join_optouts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "party_join_optouts_user_idx" ON "party_join_optouts" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_members" ADD CONSTRAINT "agency_members_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_user_idx" ON "company_members" USING btree ("company_id","user_id") WHERE "company_members"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agency_user_idx" ON "agency_members" USING btree ("agency_id","user_id") WHERE "agency_members"."deleted_at" IS NULL;