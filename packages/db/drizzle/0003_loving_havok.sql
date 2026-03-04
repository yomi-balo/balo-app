CREATE TYPE "public"."application_status" AS ENUM('draft', 'submitted', 'under_review', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."language_proficiency" AS ENUM('basic', 'conversational', 'professional', 'native');--> statement-breakpoint
CREATE TABLE "certification_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vertical_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"icon_url" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expert_industries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expert_profile_id" uuid NOT NULL,
	"industry_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expert_languages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expert_profile_id" uuid NOT NULL,
	"language_id" uuid NOT NULL,
	"proficiency" "language_proficiency" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expert_profile_id" uuid NOT NULL,
	"role" text NOT NULL,
	"company" text NOT NULL,
	"started_at" timestamp NOT NULL,
	"ended_at" timestamp,
	"is_current" boolean DEFAULT false NOT NULL,
	"responsibilities" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "languages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"flag_emoji" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "industries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "certifications" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "expert_profiles" ADD COLUMN "year_started_salesforce" integer;--> statement-breakpoint
ALTER TABLE "expert_profiles" ADD COLUMN "project_count" integer;--> statement-breakpoint
ALTER TABLE "expert_profiles" ADD COLUMN "project_lead_count" integer;--> statement-breakpoint
ALTER TABLE "expert_profiles" ADD COLUMN "is_salesforce_mvp" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "expert_profiles" ADD COLUMN "is_salesforce_cta" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "expert_profiles" ADD COLUMN "is_certified_trainer" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "expert_profiles" ADD COLUMN "application_status" "application_status" DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "expert_profiles" ADD COLUMN "submitted_at" timestamp;--> statement-breakpoint
ALTER TABLE "skill_categories" ADD CONSTRAINT "skill_categories_vertical_id_verticals_id_fk" FOREIGN KEY ("vertical_id") REFERENCES "public"."verticals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_industries" ADD CONSTRAINT "expert_industries_expert_profile_id_expert_profiles_id_fk" FOREIGN KEY ("expert_profile_id") REFERENCES "public"."expert_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_industries" ADD CONSTRAINT "expert_industries_industry_id_industries_id_fk" FOREIGN KEY ("industry_id") REFERENCES "public"."industries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_languages" ADD CONSTRAINT "expert_languages_expert_profile_id_expert_profiles_id_fk" FOREIGN KEY ("expert_profile_id") REFERENCES "public"."expert_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_languages" ADD CONSTRAINT "expert_languages_language_id_languages_id_fk" FOREIGN KEY ("language_id") REFERENCES "public"."languages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_history" ADD CONSTRAINT "work_history_expert_profile_id_expert_profiles_id_fk" FOREIGN KEY ("expert_profile_id") REFERENCES "public"."expert_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cert_cat_slug_idx" ON "certification_categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "cert_cat_sort_idx" ON "certification_categories" USING btree ("sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_cat_vertical_slug_idx" ON "skill_categories" USING btree ("vertical_id","slug");--> statement-breakpoint
CREATE INDEX "skill_cat_vertical_id_idx" ON "skill_categories" USING btree ("vertical_id");--> statement-breakpoint
CREATE INDEX "skill_cat_sort_idx" ON "skill_categories" USING btree ("vertical_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "expert_industry_unique_idx" ON "expert_industries" USING btree ("expert_profile_id","industry_id");--> statement-breakpoint
CREATE INDEX "expert_industry_profile_idx" ON "expert_industries" USING btree ("expert_profile_id");--> statement-breakpoint
CREATE INDEX "expert_industry_industry_idx" ON "expert_industries" USING btree ("industry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "expert_lang_unique_idx" ON "expert_languages" USING btree ("expert_profile_id","language_id");--> statement-breakpoint
CREATE INDEX "expert_lang_profile_idx" ON "expert_languages" USING btree ("expert_profile_id");--> statement-breakpoint
CREATE INDEX "expert_lang_language_idx" ON "expert_languages" USING btree ("language_id");--> statement-breakpoint
CREATE INDEX "work_history_profile_idx" ON "work_history" USING btree ("expert_profile_id");--> statement-breakpoint
CREATE INDEX "work_history_sort_idx" ON "work_history" USING btree ("expert_profile_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "languages_code_idx" ON "languages" USING btree ("code");--> statement-breakpoint
CREATE INDEX "languages_sort_idx" ON "languages" USING btree ("sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "industries_slug_idx" ON "industries" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "industries_sort_idx" ON "industries" USING btree ("sort_order");--> statement-breakpoint
ALTER TABLE "certifications" ADD CONSTRAINT "certifications_category_id_certification_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."certification_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_category_id_skill_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."skill_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cert_category_id_idx" ON "certifications" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "skill_category_id_idx" ON "skills" USING btree ("category_id");