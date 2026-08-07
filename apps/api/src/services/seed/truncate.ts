/**
 * Scoped HARD deletes for the BAL-239 seeder.
 *
 * Never uses `TRUNCATE … CASCADE` — that would wipe real dev users too. Seed
 * rows are identified strictly by their email domain / workos id prefix, so
 * non-seed dev users are never touched.
 *
 * Runs INSIDE the orchestrator's transaction (receives the tx handle). The
 * admin `db` client bypasses RLS, so no `app.current_user_id` setup is needed.
 */
import {
  users,
  expertProfiles,
  expertCompetency,
  expertCertifications,
  expertLanguages,
  expertIndustries,
  workHistory,
  availabilityRules,
  availabilityCache,
  auditEvents,
  companies,
  consultations,
  calendarConnections,
  calendarSubCalendars,
  engagements,
  meetings,
  meetingContexts,
  and,
  eq,
  inArray,
  like,
} from '@balo/db';
import type { Database } from '@balo/db';
import { SEED_COMPANY_SLUG, SEED_EMAIL_DOMAIN, SEED_WORKOS_PREFIX } from './constants.js';

/** Drizzle transaction handle (same surface as the db client for our needs). */
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export type TruncateScope = 'experts' | 'availability';

export interface TruncateResult {
  seedUserCount: number;
  seedProfileCount: number;
}

/** Resolve the seed user + profile ids in scope. */
async function resolveSeedIds(tx: Tx): Promise<{ userIds: string[]; profileIds: string[] }> {
  // Require BOTH seed markers (logical AND), not either-or. The seeder ALWAYS
  // sets both `email LIKE '%@seed.balo.dev'` AND `workos_id LIKE 'seed_%'`, so a
  // genuine seed row always matches both. Demanding both means a real dev user
  // who happens to match ONE marker (e.g. a personal address at seed.balo.dev,
  // or a workos id that starts with `seed_`) can never be swept into a
  // destructive delete here. Even if a partial match somehow slipped through,
  // the delete fails closed: a real signup user has a `company_members` row
  // whose FK to `users` is ON DELETE NO ACTION/RESTRICT, so deleting that user
  // would raise a FK violation and roll the whole transaction back rather than
  // corrupt data.
  const seedUsers = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        like(users.email, `%@${SEED_EMAIL_DOMAIN}`),
        like(users.workosId, `${SEED_WORKOS_PREFIX}%`)
      )
    );
  const userIds = seedUsers.map((u) => u.id);
  if (userIds.length === 0) return { userIds: [], profileIds: [] };

  const seedProfiles = await tx
    .select({ id: expertProfiles.id })
    .from(expertProfiles)
    .where(inArray(expertProfiles.userId, userIds));

  return { userIds, profileIds: seedProfiles.map((p) => p.id) };
}

/** The seed company's id, or `null` when it has not been created yet. */
async function findSeedCompanyId(tx: Tx): Promise<string | null> {
  const [row] = await tx
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.slug, SEED_COMPANY_SLUG))
    .limit(1);
  return row?.id ?? null;
}

/**
 * BAL-428 — DELETE THE SEED BOOKING GRAPH: the `meetings` the seeder booked, the
 * `case_engagements` those meetings hang off, and the `audit_events` those creations wrote.
 *
 * ⚠ WHY MEETINGS MUST BE DELETED EXPLICITLY, AND CANNOT BE LEFT TO A CASCADE.
 * `meeting_contexts.context_id` is POLYMORPHIC and therefore has NO FOREIGN KEY (see
 * `schema/meeting-contexts.ts`). Deleting an engagement consequently cascades NOTHING to
 * the meetings that reference it — they survive as live rows pointing at an id that no
 * longer resolves, and `findProjectionDrift` would report every one of them forever. The
 * FK direction that DOES help runs the other way: `meeting_contexts.meeting_id` and
 * `consultations.meeting_id` are both `ON DELETE cascade`, so deleting the MEETING takes
 * its context rows and its availability projection with it in one statement.
 *
 * ⚠ ENGAGEMENTS ARE SCOPED BY TWO PREDICATES, UNIONED, because either one alone leaks:
 *   · the SEED COMPANY catches engagements whose expert profile has already been deleted
 *     (a `regenerate` that ran without a `refresh` afterwards), and
 *   · the SEED PROFILE ids catch engagements a developer attached to a seed expert under
 *     some other company — which `expert_profiles`' `ON DELETE cascade` would otherwise
 *     silently remove, orphaning their meetings.
 *
 * ⚠ AND MEETINGS ARE THEN FOUND ALONG TWO INDEPENDENT AXES — through the engagement, AND
 * through the availability projection. The engagement walk alone is NOT exhaustive: a
 * `project_discovery` context points at a `project_requests.id`, which matches no engagement
 * id. See the axis comments in the body; do not collapse them back into one.
 * ⚠ THE SECOND PREDICATE IS NOT MARKER-ANCHORED ON THE ENGAGEMENT, AND THAT IS DELIBERATE —
 * read it before assuming this is seed-only. Only the EXPERT PROFILE is identified by
 * marker; the engagement is not. So an engagement a REAL dev company booked with a SEED
 * expert IS in scope and WILL be deleted, along with its meetings, transcripts and guests.
 * That is intended (it is the "attached to a seed expert under some other company" case
 * named above — those meetings would otherwise be orphaned by the profile cascade), but it
 * means the blast radius is "anything touching a seed expert", NOT "only rows the seeder
 * created". Do not restate this as seed-only; on a database with real rows it is not.
 *
 * FULL BLAST RADIUS of the `meetings` delete, including cascades:
 *   · `meeting_contexts`, `consultations` (the availability projection) — cascade
 *   · `transcripts` (schema/transcripts.ts) — cascade. These are CALL TRANSCRIPTS.
 *   · `meeting_presence`, `meeting_guests` (schema/guests.ts) — cascade
 *   · `action_items.meeting_id` — `ON DELETE set null`, so the items SURVIVE with a null
 *     link. Not cleaned up here; they accumulate across runs.
 *   · `credit_sessions.meeting_id` — `ON DELETE restrict`. The seeder creates none, so this
 *     cannot trip today; a developer who ran one credit session against a seed-expert
 *     meeting will wedge `pnpm db:seed` with an opaque `23503`.
 *
 * AND OF THE `engagements` DELETE THAT FOLLOWS IT — a SEPARATE blast radius, not covered by
 * the list above:
 *   · `case_engagements.engagement_id` — cascade (the composite FK noted in the body).
 *   · `credit_sessions.engagement_id` — `ON DELETE restrict`, the SECOND restrict edge on
 *     that table and the one this delete can actually reach. `credit_sessions` is
 *     denormalised (ADR-1045 §3), so a session carries BOTH `meeting_id` and
 *     `engagement_id`; deleting the meeting above does not release this one. Same shape as
 *     the `meeting_id` note: unreachable from the seeder itself, but a developer who ran a
 *     credit session against a seed engagement wedges `pnpm db:seed` with an opaque `23503`
 *     — and the failing statement is the ENGAGEMENTS delete, not the meetings one, so the
 *     error points at a different line than the note above would suggest.
 *
 * AND OF THE `companies` DELETE at the end of the `'experts'` scope (`truncateSeedData`),
 * which is neither of the above and has BOTH failure modes:
 *   · `company_members.company_id` declares NO `onDelete`, so it is `NO ACTION` and RAISES
 *     `23503` if any membership row survives. That is the same fail-closed property
 *     `resolveSeedIds` relies on for users, and it is why the seed company is deleted LAST.
 *   · `credit_receivables`, `credit_sessions.company_id`, `payouts`, `promo_codes` —
 *     `ON DELETE restrict`, so each also raises `23503` rather than deleting.
 *   · `project_requests.company_id`, `engagements.company_id`, `credit_wallets`,
 *     `company_billing` — `ON DELETE cascade`. These do NOT raise; they are silently
 *     REMOVED, which is the larger hazard of the two. A `project_requests` row is the
 *     `project_discovery` half of the context seam, so this is a second path (besides the
 *     engagement walk) by which a discovery meeting's context can stop resolving.
 *
 * `audit_events` is APPEND-ONLY BY DESIGN (see its schema docblock) and this is the one
 * exception: these rows are `engagement.created` entries for fixtures being removed
 * wholesale, scoped to exactly the ids being deleted. Leaving them would accumulate
 * thousands of dangling audit rows across repeated `pnpm db:seed` runs. It is not an FK
 * requirement — `audit_events.entity_id` has no FK — it is hygiene.
 */
async function deleteSeedBookings(tx: Tx, profileIds: string[]): Promise<void> {
  const seedCompanyId = await findSeedCompanyId(tx);

  const engagementIds = new Set<string>();
  if (seedCompanyId !== null) {
    const rows = await tx
      .select({ id: engagements.id })
      .from(engagements)
      .where(eq(engagements.companyId, seedCompanyId));
    for (const row of rows) engagementIds.add(row.id);
  }
  if (profileIds.length > 0) {
    const rows = await tx
      .select({ id: engagements.id })
      .from(engagements)
      .where(inArray(engagements.expertProfileId, profileIds));
    for (const row of rows) engagementIds.add(row.id);
  }
  const scopedIds = [...engagementIds];
  const meetingIds = new Set<string>();

  // AXIS 1 — meetings reachable THROUGH an in-scope engagement. Catches every `case`,
  // `project_kickoff`, `package_session` and `retainer_checkin` context.
  if (scopedIds.length > 0) {
    const contextRows = await tx
      .select({ meetingId: meetingContexts.meetingId })
      .from(meetingContexts)
      .where(inArray(meetingContexts.contextId, scopedIds));
    for (const row of contextRows) meetingIds.add(row.meetingId);
  }

  // AXIS 2 — meetings reachable through the AVAILABILITY PROJECTION, which is keyed on the
  // expert directly rather than on a context.
  //
  // ⚠ AXIS 1 ALONE IS NOT EXHAUSTIVE, AND THE GAP IS NOT HYPOTHETICAL. A `project_discovery`
  // meeting's `context_id` is a `project_requests.id`, NOT an `engagements.id` — the other
  // half of the seam `consultation-projection.ts` resolves — so it matches no engagement id
  // and axis 1 never finds it. Its `meetings` row would then survive every re-seed while
  // `deleteProfileChildren` deletes its `consultations` row by `expert_profile_id` anyway,
  // leaving PERMANENT `missing_projection` drift that no later seed run can clear.
  //
  // Keying on the projection closes that by construction: if a meeting blocks a seed
  // expert's calendar at all, it HAS a live projection row naming that expert (that is the
  // BAL-428 invariant), whatever its context type is — including context types that do not
  // exist yet. Unreachable from today's seeder (it emits only `case` contexts); it goes live
  // the first time a developer exercises a BAL-129/BAL-400 discovery booking on the dev DB.
  if (profileIds.length > 0) {
    const projectionRows = await tx
      .select({ meetingId: consultations.meetingId })
      .from(consultations)
      .where(inArray(consultations.expertProfileId, profileIds));
    for (const row of projectionRows) meetingIds.add(row.meetingId);
  }

  if (meetingIds.size > 0) {
    await tx.delete(meetings).where(inArray(meetings.id, [...meetingIds]));
  }

  if (scopedIds.length === 0) return;

  await tx
    .delete(auditEvents)
    .where(and(eq(auditEvents.entityType, 'engagement'), inArray(auditEvents.entityId, scopedIds)));
  // `case_engagements.engagement_id` IS `ON DELETE cascade` (a composite FK against
  // `engagement_id_type_uq`), so the child goes with the supertype row.
  await tx.delete(engagements).where(inArray(engagements.id, scopedIds));
}

/** Delete every child row that references the given expert profile ids. */
async function deleteProfileChildren(tx: Tx, profileIds: string[]): Promise<void> {
  if (profileIds.length === 0) return;

  // Calendar sub-calendars hang off connections, not profiles — delete them
  // first (defensive; no calendars are seeded today).
  const conns = await tx
    .select({ id: calendarConnections.id })
    .from(calendarConnections)
    .where(inArray(calendarConnections.expertProfileId, profileIds));
  const connIds = conns.map((c) => c.id);
  if (connIds.length > 0) {
    await tx
      .delete(calendarSubCalendars)
      .where(inArray(calendarSubCalendars.connectionId, connIds));
  }

  await tx.delete(availabilityCache).where(inArray(availabilityCache.expertProfileId, profileIds));
  await tx.delete(consultations).where(inArray(consultations.expertProfileId, profileIds));
  await tx.delete(availabilityRules).where(inArray(availabilityRules.expertProfileId, profileIds));
  await tx
    .delete(calendarConnections)
    .where(inArray(calendarConnections.expertProfileId, profileIds));
  await tx.delete(expertCompetency).where(inArray(expertCompetency.expertProfileId, profileIds));
  await tx.delete(expertLanguages).where(inArray(expertLanguages.expertProfileId, profileIds));
  await tx.delete(expertIndustries).where(inArray(expertIndustries.expertProfileId, profileIds));
  await tx
    .delete(expertCertifications)
    .where(inArray(expertCertifications.expertProfileId, profileIds));
  await tx.delete(workHistory).where(inArray(workHistory.expertProfileId, profileIds));
}

/**
 * Scoped hard-delete of seed data.
 *
 * - `'experts'`: full destructive regenerate — deletes the booking graph, all profile
 *   children, the profiles, the seed users, and the seed company (FK-safe order).
 * - `'availability'`: refresh-only — deletes the booking graph plus availability_cache,
 *   consultations and availability_rules for seed profiles; leaves experts/users/company
 *   intact so `refreshAvailability` can re-book against the same parties.
 *
 * ⚠ BAL-428 — `deleteSeedBookings` MUST RUN FIRST IN BOTH SCOPES. A `consultations` row
 * now carries a NOT NULL `meeting_id`, so the ONLY way to remove it and its meeting
 * together is to delete the meeting (which cascades both the projection and the context
 * rows). Deleting consultations directly first would leave the meetings behind; deleting
 * the profiles first would cascade the engagements away and leave the meetings
 * unreachable — see `deleteSeedBookings`.
 *
 * ⚠ RUNS ONLY UNDER AN EXPLICIT `NODE_ENV` OF `development` OR `test` — AN ALLOWLIST, NOT A
 * `!== 'production'` DENYLIST, AND THE DIFFERENCE IS THE WHOLE POINT.
 *
 * `app.ts` gates the seed ROUTES on `if (NODE_ENV !== 'production')`, which **fails OPEN on
 * an unset variable**. `apps/api` starts with a bare `node dist/index.js` and sets nothing
 * itself (unlike `apps/web`, where `next start` sets it), so unset is a reachable state.
 * `railway.toml`'s `startCommand` pins it — but a startCommand overridden in the Railway
 * dashboard would silently un-pin it with no review.
 *
 * A denylist here (`=== 'production'` → throw) would have shared that EXACT failure mode: in
 * the un-pinned scenario `NODE_ENV` is unset, `unset === 'production'` is false, and both
 * guards open together. Two guards, one failure mode, no defence in depth — which is what an
 * earlier draft of this function shipped, and what this docblock then wrongly claimed to
 * cover. An allowlist inverts it: an environment this code does not RECOGNISE is refused, so
 * the un-pinned production box is denied by the same rule that denies anything unfamiliar.
 *
 * COST, ACCEPTED: a developer whose `.env.local` omits `NODE_ENV` now gets a loud, actionable
 * throw instead of a silent seed. `apps/api/.env.example:57` already documents
 * `NODE_ENV=development`, and vitest sets `NODE_ENV=test` itself, so the documented setups
 * both pass. That one-time friction is the correct trade for a function whose blast radius
 * BAL-428 grew to include `meetings`, `engagements`, `transcripts`, `meeting_guests`,
 * `companies` and `audit_events`.
 *
 * Deliberately NOT keyed on `RAILWAY_*`: no such marker is referenced anywhere in this
 * codebase today, and keying a safety guard to one vendor's injected env would make it
 * silently useless the day the API is deployed anywhere else.
 */
const SEED_ALLOWED_NODE_ENVS: readonly string[] = ['development', 'test'];

export async function truncateSeedData(tx: Tx, scope: TruncateScope): Promise<TruncateResult> {
  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv === undefined || !SEED_ALLOWED_NODE_ENVS.includes(nodeEnv)) {
    // Both interpolated values are built FIRST rather than nested inside the template —
    // a nested template literal is a SonarCloud maintainability finding, and the flat form
    // reads better anyway.
    const allowed = SEED_ALLOWED_NODE_ENVS.join(' or ');
    const actual = nodeEnv === undefined ? 'unset' : `'${nodeEnv}'`;
    throw new Error(
      `truncateSeedData refused: destructive seed truncation runs only under ` +
        `NODE_ENV=${allowed} (got ${actual}). ` +
        `If this is local development, set NODE_ENV=development in apps/api/.env.local.`
    );
  }

  const { userIds, profileIds } = await resolveSeedIds(tx);

  await deleteSeedBookings(tx, profileIds);

  if (scope === 'availability') {
    if (profileIds.length > 0) {
      await tx
        .delete(availabilityCache)
        .where(inArray(availabilityCache.expertProfileId, profileIds));
      // Belt AND braces: `deleteSeedBookings` already cascaded every projection whose
      // meeting it removed. This catches a projection whose meeting became unreachable
      // (its context row hand-deleted, say) and would otherwise keep blocking the slot.
      await tx.delete(consultations).where(inArray(consultations.expertProfileId, profileIds));
      await tx
        .delete(availabilityRules)
        .where(inArray(availabilityRules.expertProfileId, profileIds));
    }
    return { seedUserCount: userIds.length, seedProfileCount: profileIds.length };
  }

  // scope === 'experts'
  await deleteProfileChildren(tx, profileIds);
  if (profileIds.length > 0) {
    await tx.delete(expertProfiles).where(inArray(expertProfiles.id, profileIds));
  }
  if (userIds.length > 0) {
    await tx.delete(users).where(inArray(users.id, userIds));
  }
  // LAST, and it MUST stay last: `company_members.company_id` is `NO ACTION`, so this
  // raises `23503` unless every membership row is already gone. Its own blast radius is
  // NOT the engagements one — see the `companies` section of `deleteSeedBookings`'s
  // docblock for the four cascade edges (notably `project_requests`) that fire silently.
  // `companies` has no `deleted_at` column, so a hard delete is the only option here.
  await tx.delete(companies).where(eq(companies.slug, SEED_COMPANY_SLUG));

  return { seedUserCount: userIds.length, seedProfileCount: profileIds.length };
}
