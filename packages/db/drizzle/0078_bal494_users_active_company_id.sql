ALTER TABLE "users" ADD COLUMN "active_company_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_active_company_id_companies_id_fk" FOREIGN KEY ("active_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_active_company_id_idx" ON "users" USING btree ("active_company_id");