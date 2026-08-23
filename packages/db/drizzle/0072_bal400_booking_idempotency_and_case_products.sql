CREATE TABLE "case_engagement_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "case_engagements" ADD COLUMN "booking_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "booking_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "case_engagement_products" ADD CONSTRAINT "case_engagement_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_engagement_products" ADD CONSTRAINT "case_engagement_product_case_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."case_engagements"("engagement_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "case_engagement_product_unique_idx" ON "case_engagement_products" USING btree ("engagement_id","product_id") WHERE "case_engagement_products"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "case_engagement_product_engagement_idx" ON "case_engagement_products" USING btree ("engagement_id");--> statement-breakpoint
CREATE INDEX "case_engagement_product_product_idx" ON "case_engagement_products" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "case_engagement_booking_idempotency_key_idx" ON "case_engagements" USING btree ("booking_idempotency_key") WHERE "case_engagements"."booking_idempotency_key" IS NOT NULL AND "case_engagements"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_booking_idempotency_key_idx" ON "meetings" USING btree ("booking_idempotency_key") WHERE "meetings"."booking_idempotency_key" IS NOT NULL AND "meetings"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "case_engagements" ADD CONSTRAINT "case_engagement_booking_idempotency_key_format" CHECK ("case_engagements"."booking_idempotency_key" IS NULL OR "case_engagements"."booking_idempotency_key" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meeting_booking_idempotency_key_format" CHECK ("meetings"."booking_idempotency_key" IS NULL OR "meetings"."booking_idempotency_key" ~ '^[0-9a-f]{64}$');