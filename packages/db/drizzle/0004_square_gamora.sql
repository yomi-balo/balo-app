CREATE TABLE "expert_payout_details" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expert_profile_id" uuid NOT NULL,
	"country_code" char(2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"transfer_method" varchar(10) DEFAULT 'LOCAL' NOT NULL,
	"entity_type" varchar(10) DEFAULT 'PERSONAL' NOT NULL,
	"form_values" jsonb NOT NULL,
	"encrypted_account_number" text,
	"encrypted_iban" text,
	"encrypted_routing_number" text,
	"verified_at" timestamp with time zone,
	"verified_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "expert_payout_details_expert_profile_id_unique" UNIQUE("expert_profile_id")
);
--> statement-breakpoint
ALTER TABLE "expert_profiles" ALTER COLUMN "searchable" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "expert_payout_details" ADD CONSTRAINT "expert_payout_details_expert_profile_id_expert_profiles_id_fk" FOREIGN KEY ("expert_profile_id") REFERENCES "public"."expert_profiles"("id") ON DELETE cascade ON UPDATE no action;