CREATE TYPE "public"."project_request_send_to" AS ENUM('direct', 'match');--> statement-breakpoint
CREATE TYPE "public"."project_request_source" AS ENUM('manual', 'ai', 'quickstart');--> statement-breakpoint
CREATE TYPE "public"."project_request_status" AS ENUM('draft', 'submitted');--> statement-breakpoint
CREATE TABLE "project_tag_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vertical_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vertical_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_request_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_request_id" uuid NOT NULL,
	"r2_key" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_request_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_request_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_request_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_request_id" uuid NOT NULL,
	"project_tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"expert_profile_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"send_to" "project_request_send_to" DEFAULT 'direct' NOT NULL,
	"status" "project_request_status" DEFAULT 'submitted' NOT NULL,
	"source" "project_request_source" DEFAULT 'manual' NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"package_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "project_requests_direct_requires_expert" CHECK (("project_requests"."send_to" = 'direct' AND "project_requests"."expert_profile_id" IS NOT NULL)
          OR ("project_requests"."send_to" = 'match' AND "project_requests"."expert_profile_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "project_tag_groups" ADD CONSTRAINT "project_tag_groups_vertical_id_verticals_id_fk" FOREIGN KEY ("vertical_id") REFERENCES "public"."verticals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tags" ADD CONSTRAINT "project_tags_vertical_id_verticals_id_fk" FOREIGN KEY ("vertical_id") REFERENCES "public"."verticals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tags" ADD CONSTRAINT "project_tags_group_id_project_tag_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."project_tag_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_request_documents" ADD CONSTRAINT "project_request_documents_project_request_id_project_requests_id_fk" FOREIGN KEY ("project_request_id") REFERENCES "public"."project_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_request_products" ADD CONSTRAINT "project_request_products_project_request_id_project_requests_id_fk" FOREIGN KEY ("project_request_id") REFERENCES "public"."project_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_request_products" ADD CONSTRAINT "project_request_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_request_tags" ADD CONSTRAINT "project_request_tags_project_request_id_project_requests_id_fk" FOREIGN KEY ("project_request_id") REFERENCES "public"."project_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_request_tags" ADD CONSTRAINT "project_request_tags_project_tag_id_project_tags_id_fk" FOREIGN KEY ("project_tag_id") REFERENCES "public"."project_tags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_expert_profile_id_expert_profiles_id_fk" FOREIGN KEY ("expert_profile_id") REFERENCES "public"."expert_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_tag_group_vertical_slug_idx" ON "project_tag_groups" USING btree ("vertical_id","slug");--> statement-breakpoint
CREATE INDEX "project_tag_group_vertical_id_idx" ON "project_tag_groups" USING btree ("vertical_id");--> statement-breakpoint
CREATE INDEX "project_tag_group_sort_idx" ON "project_tag_groups" USING btree ("vertical_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "project_tag_vertical_slug_idx" ON "project_tags" USING btree ("vertical_id","slug");--> statement-breakpoint
CREATE INDEX "project_tag_group_id_idx" ON "project_tags" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "project_tag_vertical_id_idx" ON "project_tags" USING btree ("vertical_id");--> statement-breakpoint
CREATE INDEX "project_tag_sort_idx" ON "project_tags" USING btree ("group_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "project_request_document_key_idx" ON "project_request_documents" USING btree ("r2_key");--> statement-breakpoint
CREATE INDEX "project_request_document_request_idx" ON "project_request_documents" USING btree ("project_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_request_product_unique_idx" ON "project_request_products" USING btree ("project_request_id","product_id");--> statement-breakpoint
CREATE INDEX "project_request_product_request_idx" ON "project_request_products" USING btree ("project_request_id");--> statement-breakpoint
CREATE INDEX "project_request_product_product_idx" ON "project_request_products" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_request_tag_unique_idx" ON "project_request_tags" USING btree ("project_request_id","project_tag_id");--> statement-breakpoint
CREATE INDEX "project_request_tag_request_idx" ON "project_request_tags" USING btree ("project_request_id");--> statement-breakpoint
CREATE INDEX "project_request_tag_tag_idx" ON "project_request_tags" USING btree ("project_tag_id");--> statement-breakpoint
CREATE INDEX "project_requests_company_idx" ON "project_requests" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "project_requests_expert_profile_idx" ON "project_requests" USING btree ("expert_profile_id");--> statement-breakpoint
CREATE INDEX "project_requests_created_by_idx" ON "project_requests" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "project_requests_expert_status_idx" ON "project_requests" USING btree ("expert_profile_id","status") WHERE "project_requests"."deleted_at" IS NULL;