CREATE TYPE "public"."consultation_status" AS ENUM('confirmed', 'cancelled');--> statement-breakpoint
CREATE TABLE "availability_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expert_profile_id" uuid NOT NULL,
	"day_of_week" integer NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "avail_rules_day_check" CHECK ("availability_rules"."day_of_week" BETWEEN 0 AND 6),
	CONSTRAINT "avail_rules_start_before_end_check" CHECK ("availability_rules"."start_time" < "availability_rules"."end_time")
);
--> statement-breakpoint
CREATE TABLE "consultations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expert_profile_id" uuid NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"status" "consultation_status" DEFAULT 'confirmed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "consultations_start_before_end_check" CHECK ("consultations"."start_at" < "consultations"."end_at"),
	CONSTRAINT "consultations_status_check" CHECK ("consultations"."status" IN ('confirmed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_expert_profile_id_expert_profiles_id_fk" FOREIGN KEY ("expert_profile_id") REFERENCES "public"."expert_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_expert_profile_id_expert_profiles_id_fk" FOREIGN KEY ("expert_profile_id") REFERENCES "public"."expert_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "avail_rules_expert_profile_idx" ON "availability_rules" USING btree ("expert_profile_id");--> statement-breakpoint
CREATE INDEX "avail_rules_expert_day_idx" ON "availability_rules" USING btree ("expert_profile_id","day_of_week");--> statement-breakpoint
CREATE INDEX "consultations_expert_profile_idx" ON "consultations" USING btree ("expert_profile_id");--> statement-breakpoint
CREATE INDEX "consultations_expert_status_range_idx" ON "consultations" USING btree ("expert_profile_id","status","start_at");