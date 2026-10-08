ALTER TABLE "expert_competency" ADD COLUMN "self_proficiency" integer;--> statement-breakpoint
UPDATE "expert_competency" SET "self_proficiency" = "proficiency";--> statement-breakpoint
UPDATE "expert_profiles" SET "skills_locked" = true WHERE "approved_at" IS NOT NULL;
