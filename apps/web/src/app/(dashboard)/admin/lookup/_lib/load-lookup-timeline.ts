import 'server-only';

import { auditEventsRepository } from '@balo/db';
import {
  LOOKUP_AUDIT_ENTITY_TYPE,
  LOOKUP_TIMELINE_PAGE_SIZE,
  auditActorLabel,
  describeAuditEvent,
  type LookupEntityType,
  type LookupTimelineCursorDTO,
  type LookupTimelineResult,
} from '@balo/shared/lookup';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import type { SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';

/**
 * BAL-555 — the authorization seam between the Timeline Server Action and
 * `auditEventsRepository.listTrailForEntity`, modelled line-for-line on `_lib/load-lookup.ts`.
 * This is the ONE module in the codebase permitted to pass `authorizedPlatformStaff: true` to
 * that member — it resolves `VIEW_PLATFORM_ADMIN` itself, immediately before the call, and
 * returns a typed `forbidden` DTO with ZERO repository calls when the check fails
 * (`audit-trail-reader-single-caller.test.ts` pins that no other module calls it).
 *
 * ⚠ `@balo/db` never reads a platform role (ADR-1029 / ADR-1035): the flag is the caller's
 * PROOF, not a request the repository re-derives.
 *
 * `LOOKUP_AUDIT_ENTITY_TYPE` (`@balo/shared/lookup`) is the SECURITY ALLOW-LIST that turns a
 * `LookupEntityType` into the `audit_events.entity_type` string — never forward a free string
 * from the wire straight into the query (C7).
 *
 * The projection into `LookupTimelineEntry` happens HERE — the one place `metadata` and
 * `actorUserId` are read; nothing downstream sees them (the DTO allow-list, §3.5).
 */
export async function loadLookupTimeline(
  user: SessionUser,
  input: { type: LookupEntityType; id: string; before?: LookupTimelineCursorDTO }
): Promise<LookupTimelineResult> {
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)) {
    log.warn('Admin lookup timeline load reached without VIEW_PLATFORM_ADMIN', { userId: user.id });
    return { ok: false, reason: 'forbidden' };
  }

  const entityType = LOOKUP_AUDIT_ENTITY_TYPE[input.type];

  const page = await auditEventsRepository.listTrailForEntity({
    entityType,
    entityId: input.id,
    limit: LOOKUP_TIMELINE_PAGE_SIZE,
    // ⚠ BAL-555 fix round — `input.before.createdAtPrecise` is carried straight through as an
    // OPAQUE, already-precise Postgres-parseable string. NEVER wrap it in `new Date(...)`: a
    // JS `Date` is millisecond-precision only, while the value here is genuinely
    // microsecond-precision, and truncating it silently drops rows at a page boundary
    // (`AuditTrailCursor.createdAtPrecise`'s docblock).
    before:
      input.before === undefined
        ? undefined
        : { createdAtPrecise: input.before.createdAtPrecise, seq: input.before.seq },
    authorizedPlatformStaff: true,
  });

  const entries = page.rows.map((row) => {
    const actorLabel = auditActorLabel(
      row.actorUserId === null
        ? null
        : {
            firstName: row.actorFirstName,
            lastName: row.actorLastName,
            platformRole: row.actorPlatformRole,
            companyName: row.actorCompanyName,
            agencyName: row.actorAgencyName,
          }
    );
    return {
      id: row.id,
      action: row.action,
      summary: describeAuditEvent({ action: row.action, metadata: row.metadata, actorLabel }),
      occurredAtIso: row.createdAt.toISOString(),
      // ⚠ BAL-555 fix round F1 — the OPAQUE grouping key, carried verbatim from the repository's
      // full-microsecond `createdAtPrecise`. NEVER derive this from `occurredAtIso` above (that
      // field is millisecond-truncated) — see `LookupTimelineEntry.instantKey`'s docblock.
      instantKey: row.createdAtPrecise,
    };
  });

  return {
    ok: true,
    entries,
    hasEarlier: page.hasEarlier,
    // ⚠ `page.earlierCursor.createdAtPrecise` crosses to the wire VERBATIM — never
    // `.toISOString()`'d through a `Date` (same precision-loss hazard as above, in reverse).
    earlier:
      page.earlierCursor === null
        ? null
        : { createdAtPrecise: page.earlierCursor.createdAtPrecise, seq: page.earlierCursor.seq },
  };
}
