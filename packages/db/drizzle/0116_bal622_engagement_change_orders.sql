CREATE TYPE "public"."engagement_change_order_line_op" AS ENUM('add', 'edit', 'remove');--> statement-breakpoint
CREATE TYPE "public"."engagement_change_order_status" AS ENUM('requested', 'draft', 'sent', 'approved', 'declined', 'withdrawn');--> statement-breakpoint
CREATE TABLE "engagement_change_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"change_order_id" uuid NOT NULL,
	"op" "engagement_change_order_line_op" NOT NULL,
	"engagement_milestone_id" uuid,
	"title" text NOT NULL,
	"description_html" text,
	"acceptance_criteria" text,
	"value_cents" integer,
	"estimated_minutes" integer,
	"before_title" text,
	"before_description_html" text,
	"before_estimated_minutes" integer,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "engagement_change_order_line_target" CHECK ("engagement_change_order_lines"."op" = 'add' OR "engagement_change_order_lines"."engagement_milestone_id" IS NOT NULL),
	CONSTRAINT "engagement_change_order_line_value_nonneg" CHECK ("engagement_change_order_lines"."value_cents" IS NULL OR "engagement_change_order_lines"."value_cents" >= 0),
	CONSTRAINT "engagement_change_order_line_estimate_nonneg" CHECK ("engagement_change_order_lines"."estimated_minutes" IS NULL OR "engagement_change_order_lines"."estimated_minutes" >= 0),
	CONSTRAINT "engagement_change_order_line_sort_nonneg" CHECK ("engagement_change_order_lines"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "engagement_change_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"status" "engagement_change_order_status" NOT NULL,
	"request_note" text,
	"note" text,
	"price_delta_cents" integer,
	"requested_by_user_id" uuid,
	"requested_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"sent_by_user_id" uuid,
	"sent_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"withdrawn_by_user_id" uuid,
	"withdrawn_at" timestamp with time zone,
	"decline_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "engagement_change_order_requested_pair" CHECK (("engagement_change_orders"."requested_at" IS NULL) = ("engagement_change_orders"."requested_by_user_id" IS NULL)),
	CONSTRAINT "engagement_change_order_sent_pair" CHECK (("engagement_change_orders"."sent_at" IS NULL) = ("engagement_change_orders"."sent_by_user_id" IS NULL)),
	CONSTRAINT "engagement_change_order_decided_pair" CHECK (("engagement_change_orders"."decided_at" IS NULL) = ("engagement_change_orders"."decided_by_user_id" IS NULL)),
	CONSTRAINT "engagement_change_order_withdrawn_pair" CHECK (("engagement_change_orders"."withdrawn_at" IS NULL) = ("engagement_change_orders"."withdrawn_by_user_id" IS NULL)),
	CONSTRAINT "engagement_change_order_decided_xor_withdrawn" CHECK (NOT ("engagement_change_orders"."decided_at" IS NOT NULL AND "engagement_change_orders"."withdrawn_at" IS NOT NULL)),
	CONSTRAINT "engagement_change_order_decided_stamped" CHECK (("engagement_change_orders"."status" <> 'approved' AND "engagement_change_orders"."status" <> 'declined') OR ("engagement_change_orders"."decided_at" IS NOT NULL AND "engagement_change_orders"."decided_by_user_id" IS NOT NULL)),
	CONSTRAINT "engagement_change_order_withdrawn_stamped" CHECK ("engagement_change_orders"."status" <> 'withdrawn' OR "engagement_change_orders"."withdrawn_at" IS NOT NULL),
	CONSTRAINT "engagement_change_order_sent_stamped" CHECK (("engagement_change_orders"."status" <> 'sent' AND "engagement_change_orders"."status" <> 'approved') OR "engagement_change_orders"."sent_at" IS NOT NULL),
	CONSTRAINT "engagement_change_order_open_unstamped" CHECK (("engagement_change_orders"."status" <> 'requested' AND "engagement_change_orders"."status" <> 'draft' AND "engagement_change_orders"."status" <> 'sent') OR ("engagement_change_orders"."decided_at" IS NULL AND "engagement_change_orders"."withdrawn_at" IS NULL)),
	CONSTRAINT "engagement_change_order_requested_stamped" CHECK ("engagement_change_orders"."status" <> 'requested' OR "engagement_change_orders"."requested_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "engagement_change_order_lines" ADD CONSTRAINT "engagement_change_order_lines_change_order_id_engagement_change_orders_id_fk" FOREIGN KEY ("change_order_id") REFERENCES "public"."engagement_change_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_change_order_lines" ADD CONSTRAINT "engagement_change_order_lines_engagement_milestone_id_engagement_milestones_id_fk" FOREIGN KEY ("engagement_milestone_id") REFERENCES "public"."engagement_milestones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_change_orders" ADD CONSTRAINT "engagement_change_orders_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_change_orders" ADD CONSTRAINT "engagement_change_orders_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_change_orders" ADD CONSTRAINT "engagement_change_orders_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_change_orders" ADD CONSTRAINT "engagement_change_orders_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_change_orders" ADD CONSTRAINT "engagement_change_orders_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_change_orders" ADD CONSTRAINT "engagement_change_orders_withdrawn_by_user_id_users_id_fk" FOREIGN KEY ("withdrawn_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "engagement_change_order_line_order_idx" ON "engagement_change_order_lines" USING btree ("change_order_id","sort_order") WHERE "engagement_change_order_lines"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "engagement_change_order_line_milestone_idx" ON "engagement_change_order_lines" USING btree ("engagement_milestone_id") WHERE "engagement_change_order_lines"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "engagement_change_order_one_open_idx" ON "engagement_change_orders" USING btree ("engagement_id") WHERE "engagement_change_orders"."decided_at" IS NULL AND "engagement_change_orders"."withdrawn_at" IS NULL AND "engagement_change_orders"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "engagement_change_order_engagement_idx" ON "engagement_change_orders" USING btree ("engagement_id","created_at") WHERE "engagement_change_orders"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "engagement_change_order_open_sent_idx" ON "engagement_change_orders" USING btree ("sent_at") WHERE "engagement_change_orders"."decided_at" IS NULL AND "engagement_change_orders"."withdrawn_at" IS NULL AND "engagement_change_orders"."deleted_at" IS NULL;