CREATE TABLE "availability_cache" (
	"expert_profile_id" uuid PRIMARY KEY NOT NULL,
	"earliest_available_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expert_profile_id" uuid NOT NULL,
	"cronofy_sub" text NOT NULL,
	"provider" text NOT NULL,
	"provider_email" text,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"token_expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"channel_id" text,
	"target_calendar_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "cal_conn_status_check" CHECK ("calendar_connections"."status" IN ('connected', 'sync_pending', 'auth_error'))
);
--> statement-breakpoint
CREATE TABLE "calendar_sub_calendars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"calendar_id" text NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"profile_name" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"conflict_check" boolean DEFAULT true NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "availability_cache" ADD CONSTRAINT "availability_cache_expert_profile_id_expert_profiles_id_fk" FOREIGN KEY ("expert_profile_id") REFERENCES "public"."expert_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_expert_profile_id_expert_profiles_id_fk" FOREIGN KEY ("expert_profile_id") REFERENCES "public"."expert_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_sub_calendars" ADD CONSTRAINT "calendar_sub_calendars_connection_id_calendar_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."calendar_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cal_conn_expert_profile_idx" ON "calendar_connections" USING btree ("expert_profile_id");--> statement-breakpoint
CREATE INDEX "cal_conn_cronofy_sub_idx" ON "calendar_connections" USING btree ("cronofy_sub");--> statement-breakpoint
CREATE INDEX "cal_conn_channel_id_idx" ON "calendar_connections" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cal_sub_conn_calendar_idx" ON "calendar_sub_calendars" USING btree ("connection_id","calendar_id");--> statement-breakpoint
CREATE INDEX "cal_sub_connection_idx" ON "calendar_sub_calendars" USING btree ("connection_id");