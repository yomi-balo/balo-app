/**
 * BAL-548 / ADR-1055 — tuned constants, typed consts until D2 (`platform_settings` does not
 * exist — verified, not assumed; house precedent: `packages/shared/src/reviews/index.ts`'s
 * `RATING_MIN`/`RATING_MAX` header).
 */

/**
 * ADR-1055's storm threshold. A finder returning MORE than this many NEW entities in one tick
 * raises one `<kind>.storm` row instead of per-entity rows. Becomes a `platform_settings` key
 * at D2.
 */
export const ADMIN_ALERT_STORM_THRESHOLD = 25;

/** Sample entity ids carried in a storm row's `detail`. */
export const ADMIN_ALERT_STORM_SAMPLE_LIMIT = 10;

/** Home's keyset page size (ADR-1055: "keyset load-more in 50s"). */
export const ADMIN_ALERT_PAGE_SIZE = 50;

/** Age at or above which a row's age is EMPHASISED (ADR-1055: ">= 3 days"). Severity is NOT modelled in v1. */
export const ADMIN_ALERT_AGE_EMPHASIS_DAYS = 3;

/** Resolution-note bounds. `min` is the ticket's AC; `max` keeps a paste out of the column. */
export const ADMIN_ALERT_NOTE_MIN = 8;
export const ADMIN_ALERT_NOTE_MAX = 2000;

/** Per-finder batch bound. The caller MUST warn when a finder fills it — "no silent caps". */
export const ADMIN_ALERT_FINDER_BATCH_LIMIT = 200;

/**
 * BAL-550 — hoisted from `apps/api/src/jobs/admin-alert-finders.ts`'s
 * `TRANSCRIPT_CAPTURE_WITHHELD_SOURCE_CUTOFF_MS` (zero behaviour change: same 24h value). ONE
 * definition now serves BOTH the `transcript_capture.withheld_source` finder's cutoff AND the
 * capture-health lens's `withheld` chip threshold (`meeting_recordings.transcript_job_submitted_at
 * <= now - this`) — the same "has the batch job been quiet too long" question, asked from two
 * surfaces. The finder keeps its own exported name and every call site untouched; only its
 * right-hand side becomes this import.
 */
export const TRANSCRIPT_SOURCE_WITHHELD_AFTER_MS = 24 * 60 * 60 * 1000;
