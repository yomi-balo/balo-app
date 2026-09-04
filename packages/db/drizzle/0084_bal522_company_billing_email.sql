CREATE TYPE "public"."billing_email_source" AS ENUM('seeded', 'set');--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "billing_email" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "billing_email_source" "billing_email_source";--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "billing_email_set_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "billing_email_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_billing_email_set_by_user_id_users_id_fk" FOREIGN KEY ("billing_email_set_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "companies_billing_email_set_by_user_id_idx" ON "companies" USING btree ("billing_email_set_by_user_id");--> statement-breakpoint
ALTER TABLE "companies" DROP COLUMN "credit_balance";--> statement-breakpoint
ALTER TABLE "companies" DROP COLUMN "stripe_customer_id";