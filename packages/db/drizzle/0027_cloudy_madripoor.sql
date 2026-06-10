CREATE TABLE "conversation_read_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"relationship_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "conversation_read_states" ADD CONSTRAINT "conversation_read_states_relationship_id_request_expert_relationships_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."request_expert_relationships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_read_states" ADD CONSTRAINT "conversation_read_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_read_state_unique_idx" ON "conversation_read_states" USING btree ("relationship_id","user_id") WHERE "conversation_read_states"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "conversation_read_state_user_idx" ON "conversation_read_states" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "conversation_read_state_relationship_idx" ON "conversation_read_states" USING btree ("relationship_id");