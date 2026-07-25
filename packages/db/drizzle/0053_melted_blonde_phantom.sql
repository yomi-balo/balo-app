CREATE TABLE "platform_config" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"min_consultation_minutes" integer DEFAULT 15 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "platform_config_singleton" CHECK ("platform_config"."id" = 1),
	CONSTRAINT "platform_config_min_ge_floor" CHECK ("platform_config"."min_consultation_minutes" >= 15),
	CONSTRAINT "platform_config_min_le_cap" CHECK ("platform_config"."min_consultation_minutes" <= 240)
);
--> statement-breakpoint
ALTER TABLE "platform_config" ADD CONSTRAINT "platform_config_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
INSERT INTO "platform_config" ("id", "min_consultation_minutes") VALUES (1, 15);