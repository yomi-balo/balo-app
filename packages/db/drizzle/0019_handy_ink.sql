-- 1. Trigram fuzzy matching extension (idempotent). Hand-added — drizzle-kit
--    cannot emit CREATE EXTENSION. Required by the repository's word_similarity()
--    function calls (used as a FUNCTION, not the <% / %> operators).
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint

-- 2. Generated STORED tsvector: headline weight A, bio weight B.
--    Postgres maintains this automatically on every expert_profiles write.
ALTER TABLE "expert_profiles" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(headline, '')), 'A') || setweight(to_tsvector('english', coalesce(bio, '')), 'B')) STORED;--> statement-breakpoint

-- 3. GIN index on the stored vector — accelerates the dominant FTS @@ match.
CREATE INDEX "expert_profiles_search_vector_idx" ON "expert_profiles" USING gin ("search_vector");--> statement-breakpoint

-- 4. Availability gate + 'soonest' sort both read earliest_available_at.
--    PARTIAL index on NOT NULL keeps it small (bookable experts only) and serves
--    ORDER BY ASC. The WHERE predicate is hand-added — drizzle-kit cannot express
--    a partial index, so the schema declaration omits it; this migration is the
--    source of truth for the partial clause.
CREATE INDEX "availability_cache_earliest_idx" ON "availability_cache" USING btree ("earliest_available_at") WHERE "earliest_available_at" IS NOT NULL;
