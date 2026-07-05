CREATE TABLE "company_billing_details" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"legal_name" text NOT NULL,
	"country_code" char(2) NOT NULL,
	"tax_id" text,
	"address" text,
	"billing_email" text NOT NULL,
	"submitted_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_billing_details_company_id_unique" UNIQUE("company_id")
);
--> statement-breakpoint
ALTER TABLE "company_billing_details" ADD CONSTRAINT "company_billing_details_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_billing_details" ADD CONSTRAINT "company_billing_details_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;