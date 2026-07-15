CREATE TABLE "proposal_share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"relationship_id" uuid NOT NULL,
	"recipient_email" text NOT NULL,
	"token_hash" text NOT NULL,
	"note" text,
	"created_by_user_id" uuid NOT NULL,
	"revoked_by_user_id" uuid,
	"expires_at" timestamp with time zone DEFAULT now() + interval '30 days' NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_accessed_at" timestamp with time zone,
	"access_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "proposal_share_link_access_count_nonneg" CHECK ("proposal_share_links"."access_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "proposal_share_links" ADD CONSTRAINT "proposal_share_links_relationship_id_request_expert_relationships_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."request_expert_relationships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_share_links" ADD CONSTRAINT "proposal_share_links_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_share_links" ADD CONSTRAINT "proposal_share_links_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_share_link_relationship_recipient_live_idx" ON "proposal_share_links" USING btree ("relationship_id","recipient_email") WHERE "proposal_share_links"."deleted_at" IS NULL AND "proposal_share_links"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_share_link_token_hash_idx" ON "proposal_share_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "proposal_share_link_relationship_idx" ON "proposal_share_links" USING btree ("relationship_id");--> statement-breakpoint
CREATE INDEX "proposal_share_link_created_by_idx" ON "proposal_share_links" USING btree ("created_by_user_id");