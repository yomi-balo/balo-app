ALTER TABLE "expert_profiles" ADD COLUMN "booking_buffer_before_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "expert_profiles" ADD COLUMN "booking_buffer_after_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "expert_profiles" ADD COLUMN "booking_minimum_notice_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "expert_profiles" ADD COLUMN "booking_window_days" integer DEFAULT 60 NOT NULL;