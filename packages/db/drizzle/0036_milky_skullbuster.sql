CREATE TYPE "public"."party_domain_source" AS ENUM('auto_captured', 'admin_added');--> statement-breakpoint
CREATE TYPE "public"."party_type" AS ENUM('company', 'agency');--> statement-breakpoint
CREATE TABLE "party_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"party_type" "party_type" NOT NULL,
	"party_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"source" "party_domain_source" NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"deleted_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "party_domains" ADD CONSTRAINT "party_domains_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_domains" ADD CONSTRAINT "party_domains_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "party_domains_domain_unique_idx" ON "party_domains" USING btree ("domain") WHERE "party_domains"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "party_domains_party_idx" ON "party_domains" USING btree ("party_type","party_id");--> statement-breakpoint
CREATE INDEX "party_domains_created_by_idx" ON "party_domains" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_events_action_idx" ON "audit_events" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_events_created_at_idx" ON "audit_events" USING btree ("created_at");