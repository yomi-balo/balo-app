ALTER TABLE "expert_payout_details" ADD COLUMN "airwallex_beneficiary_id" text;--> statement-breakpoint
ALTER TABLE "expert_payout_details" ADD COLUMN "beneficiary_registered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expert_payout_details" ADD COLUMN "beneficiary_status" text;