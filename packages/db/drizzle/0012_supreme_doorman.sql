CREATE TABLE "notification_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event" varchar(100) NOT NULL,
	"correlation_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"channel" varchar(20) NOT NULL,
	"template" varchar(100) NOT NULL,
	"status" varchar(20) NOT NULL,
	"error" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_log_correlation_id_idx" ON "notification_log" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "notification_log_recipient_id_idx" ON "notification_log" USING btree ("recipient_id");--> statement-breakpoint
CREATE INDEX "notification_log_created_at_idx" ON "notification_log" USING btree ("created_at");