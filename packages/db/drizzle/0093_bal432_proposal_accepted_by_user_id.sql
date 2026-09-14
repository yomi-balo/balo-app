ALTER TABLE "proposals" ADD COLUMN "accepted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposal_accepted_by_idx" ON "proposals" USING btree ("accepted_by_user_id");