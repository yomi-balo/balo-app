-- 0023 — composite-FK backstop (BAL-267): the denormalised project_request_id /
-- expert_profile_id on proposals & expressions_of_interest are pinned to their
-- relationship row's ids at the DB level.
-- Hand-reordered: drizzle-kit emitted the FKs before the UNIQUE constraints they
-- reference. Within the migration transaction statements run in order, so the
-- UNIQUE targets on request_expert_relationships(id, …) MUST be created first,
-- else the FK creation fails ("no unique constraint matching given keys").
ALTER TABLE "request_expert_relationships" ADD CONSTRAINT "request_expert_relationship_id_request_uq" UNIQUE("id","project_request_id");--> statement-breakpoint
ALTER TABLE "request_expert_relationships" ADD CONSTRAINT "request_expert_relationship_id_expert_uq" UNIQUE("id","expert_profile_id");--> statement-breakpoint
ALTER TABLE "expressions_of_interest" ADD CONSTRAINT "eoi_rel_request_match_fk" FOREIGN KEY ("relationship_id","project_request_id") REFERENCES "public"."request_expert_relationships"("id","project_request_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expressions_of_interest" ADD CONSTRAINT "eoi_rel_expert_match_fk" FOREIGN KEY ("relationship_id","expert_profile_id") REFERENCES "public"."request_expert_relationships"("id","expert_profile_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_rel_request_match_fk" FOREIGN KEY ("relationship_id","project_request_id") REFERENCES "public"."request_expert_relationships"("id","project_request_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_rel_expert_match_fk" FOREIGN KEY ("relationship_id","expert_profile_id") REFERENCES "public"."request_expert_relationships"("id","expert_profile_id") ON DELETE cascade ON UPDATE no action;
