CREATE TABLE "availability_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expert_profile_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "avail_overrides_start_before_end_check" CHECK ("availability_overrides"."start_date" <= "availability_overrides"."end_date")
);
--> statement-breakpoint
ALTER TABLE "availability_overrides" ADD CONSTRAINT "availability_overrides_expert_profile_id_expert_profiles_id_fk" FOREIGN KEY ("expert_profile_id") REFERENCES "public"."expert_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "avail_overrides_expert_profile_idx" ON "availability_overrides" USING btree ("expert_profile_id");--> statement-breakpoint
CREATE INDEX "avail_overrides_expert_end_idx" ON "availability_overrides" USING btree ("expert_profile_id","end_date");--> statement-breakpoint
CREATE INDEX "avail_overrides_expert_start_idx" ON "availability_overrides" USING btree ("expert_profile_id","start_date");