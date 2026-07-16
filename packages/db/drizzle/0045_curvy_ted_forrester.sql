CREATE TYPE "public"."promo_code_status" AS ENUM('active', 'deactivated');--> statement-breakpoint
CREATE TABLE "promo_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"grant_minor" integer NOT NULL,
	"per_code_redemption_cap" integer NOT NULL,
	"redeemed_count" integer DEFAULT 0 NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"status" "promo_code_status" DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "promo_codes_grant_positive" CHECK ("promo_codes"."grant_minor" > 0),
	CONSTRAINT "promo_codes_cap_positive" CHECK ("promo_codes"."per_code_redemption_cap" > 0),
	CONSTRAINT "promo_codes_redeemed_nonneg" CHECK ("promo_codes"."redeemed_count" >= 0),
	CONSTRAINT "promo_codes_redeemed_within_cap" CHECK ("promo_codes"."redeemed_count" <= "promo_codes"."per_code_redemption_cap"),
	CONSTRAINT "promo_codes_valid_window" CHECK ("promo_codes"."valid_until" > "promo_codes"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "promo_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"promo_code_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_minor" integer NOT NULL,
	"ledger_entry_id" uuid NOT NULL,
	"redeemed_by_user_id" uuid,
	CONSTRAINT "promo_redemptions_granted_positive" CHECK ("promo_redemptions"."granted_minor" > 0)
);
--> statement-breakpoint
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_promo_code_id_promo_codes_id_fk" FOREIGN KEY ("promo_code_id") REFERENCES "public"."promo_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_ledger_entry_id_credit_ledger_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."credit_ledger"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_redeemed_by_user_id_users_id_fk" FOREIGN KEY ("redeemed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "promo_codes_code_active_idx" ON "promo_codes" USING btree ("code") WHERE "promo_codes"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "promo_codes_created_by_idx" ON "promo_codes" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "promo_redemptions_promo_code_idx" ON "promo_redemptions" USING btree ("promo_code_id");--> statement-breakpoint
CREATE INDEX "promo_redemptions_company_idx" ON "promo_redemptions" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "promo_redemptions_redeemed_by_idx" ON "promo_redemptions" USING btree ("redeemed_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "promo_redemptions_ledger_entry_idx" ON "promo_redemptions" USING btree ("ledger_entry_id");