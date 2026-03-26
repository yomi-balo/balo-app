CREATE TABLE "user_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"event" varchar(100) NOT NULL,
	"title" varchar(255) NOT NULL,
	"body" text,
	"action_url" varchar(500),
	"metadata" jsonb,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "user_notifications" ADD CONSTRAINT "user_notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_notifications_user_id_read_at_idx" ON "user_notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE INDEX "user_notifications_user_created_idx" ON "user_notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "user_notifications_created_at_idx" ON "user_notifications" USING btree ("created_at");