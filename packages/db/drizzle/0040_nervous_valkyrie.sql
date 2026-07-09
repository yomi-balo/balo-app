ALTER TABLE "project_requests" ADD COLUMN "balo_fee_bps" integer DEFAULT 2500 NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "balo_fee_bps" integer DEFAULT 2500 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_balo_fee_bps_range" CHECK ("project_requests"."balo_fee_bps" >= 0 AND "project_requests"."balo_fee_bps" <= 10000);--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposal_balo_fee_bps_range" CHECK ("proposals"."balo_fee_bps" >= 0 AND "proposals"."balo_fee_bps" <= 10000);