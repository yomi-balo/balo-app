ALTER TABLE "availability_rules" DROP CONSTRAINT "avail_rules_start_before_end_check";--> statement-breakpoint
ALTER TABLE "expert_profiles" ADD COLUMN "booking_buffer_before_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "expert_profiles" ADD COLUMN "booking_buffer_after_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "expert_profiles" ADD COLUMN "booking_minimum_notice_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "expert_profiles" ADD CONSTRAINT "expert_profiles_booking_buffer_before_check" CHECK ("expert_profiles"."booking_buffer_before_minutes" BETWEEN 0 AND 120);--> statement-breakpoint
ALTER TABLE "expert_profiles" ADD CONSTRAINT "expert_profiles_booking_buffer_after_check" CHECK ("expert_profiles"."booking_buffer_after_minutes" BETWEEN 0 AND 120);--> statement-breakpoint
ALTER TABLE "expert_profiles" ADD CONSTRAINT "expert_profiles_booking_minimum_notice_check" CHECK ("expert_profiles"."booking_minimum_notice_minutes" BETWEEN 0 AND 20160);--> statement-breakpoint
ALTER TABLE "availability_rules" ADD CONSTRAINT "avail_rules_start_ne_end_check" CHECK ("availability_rules"."start_time" <> "availability_rules"."end_time");