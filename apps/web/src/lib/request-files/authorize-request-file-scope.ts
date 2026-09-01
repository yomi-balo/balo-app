import 'server-only';

import {
  projectRequestsRepository,
  requestExpertRelationshipsRepository,
  type ProjectRequestWithRelations,
} from '@balo/db';
import { resolveRequestTrackFileAccess, type RequestTrackRef } from '@balo/shared/authz';
import type { SessionUser } from '@/lib/auth/session';
import { hasCapability, CAPABILITIES } from '@/lib/authz';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { resolveRequestLens } from '@/lib/project-request/resolve-request-lens';
import { log } from '@/lib/logging';

/**
 * THE REQUEST-FILE SCOPE GATE (BAL-431 / ADR-1048 §4, layer 2) — the replacement for
 * `resolveConversationAccess` on the file plane. It CANNOT be reused: that gate DENIES admin
 * observers (`resolve-conversation-access.ts:120`, `archetype !== 'participant'`) and gates on
 * `isThreadOpenStatus`, which excludes `invited` — both fatal here, since the admin lens is a
 * real reader and an `invited` expert must see share-to-all files the moment their track
 * exists. It also WRITES (`ensureForContext`); this gate performs no writes on any path, which
 * is what lets the download action sit on `READ_ONLY_ALLOWLIST` behind a bare `requireUser()`.
 *
 * ⚠ AUTHORIZATION COMPLETES BEFORE ANY FILE ROW IS READ. Every one of upload / confirm / list /
 * download / revoke / delete calls this FIRST, then layer 3 (containment + the per-file
 * audience check in `requestFileVisibleToTrack`).
 */
/**
 * The RAW standing columns of one track, carried through untouched so a caller can derive a
 * DISPLAY LABEL for WHY a track closed (`closedReasonOf`, `load-request-files.ts`).
 *
 * ⚠ THIS IS NOT A LIVENESS INPUT. Whether a track is live is answered exclusively by
 * `access`, resolved here through the ONE shared predicate. These columns exist on the scope
 * only so the reason can be labelled without a SECOND relationship read.
 */
export interface RequestTrackStanding {
  readonly status: string;
  readonly declinedAt: Date | null;
  readonly notSelectedAt: Date | null;
}

/** A resolved track ref plus its raw standing columns. Assignable to `RequestTrackRef`. */
export interface RequestFileTrack extends RequestTrackRef {
  readonly standing: RequestTrackStanding;
}

export type RequestFileScope =
  | {
      ok: true;
      side: 'client';
      request: ProjectRequestWithRelations;
      companyId: string;
      /**
       * Every NON-WITHDRAWN track on the request — LIVE AND CLOSED — with resolved standing.
       * ⚠ FILTER ON `access.kind === 'live'` BEFORE OFFERING ANY TRACK AS A SHARE TARGET; a
       * closed track handed to a picker or a grant list is a direct ADR-1048 §7 invariant-4
       * violation. (`listByRequest` filters `deleted_at IS NULL`, so a withdrawn track is
       * absent entirely rather than present-and-closed.)
       */
      tracks: RequestFileTrack[];
    }
  | {
      ok: true;
      side: 'expert';
      request: ProjectRequestWithRelations;
      /** ⚠ THE VIEWER'S OWN TRACK, RESOLVED SERVER-SIDE. Never a request-body value. */
      viewer: RequestFileTrack;
    }
  | {
      ok: true;
      side: 'admin';
      request: ProjectRequestWithRelations;
      /** Same shape and same caveat as the client arm's `tracks`. */
      tracks: RequestFileTrack[];
    }
  /** ONE literal. There is deliberately no `forbidden` — existence never leaks. */
  | { ok: false; code: 'request_files_not_found' };

/** The single denial copy every caller surfaces verbatim (§12). */
export const REQUEST_FILES_UNAVAILABLE_COPY = 'These files are no longer available.';

function denied(user: SessionUser, requestId: string, reason: string): RequestFileScope {
  log.warn('Request file scope denied', { requestId, userId: user.id, reason });
  return { ok: false, code: 'request_files_not_found' };
}

/**
 * ⚠ THE SECOND RELATIONSHIP READ, AND IT IS LOAD-BEARING. `findByIdWithRelations`'s
 * `relationships` sub-select is a narrow render-graph allow-list carrying `status` but NOT
 * `declinedAt` / `deletedAt` / `notSelectedAt` (`project-requests.ts:207-229`) — BAL-283
 * refused to widen it precisely because a half-fed `relationshipDeniesHosting` would stop
 * failing closed. This re-reads the FULL rows via `listByRequest` (already `deleted_at IS
 * NULL`-filtered) and resolves every track's file-plane standing through the ONE shared
 * predicate.
 */
async function loadTracks(projectRequestId: string): Promise<RequestFileTrack[]> {
  const relationships = await requestExpertRelationshipsRepository.listByRequest(projectRequestId);
  return relationships.map((relationship) => ({
    relationshipId: relationship.id,
    expertProfileId: relationship.expertProfileId,
    access: resolveRequestTrackFileAccess(relationship),
    standing: {
      status: relationship.status,
      declinedAt: relationship.declinedAt,
      notSelectedAt: relationship.notSelectedAt,
    },
  }));
}

export async function authorizeRequestFileScope(
  user: SessionUser,
  requestId: string
): Promise<RequestFileScope> {
  const request = await projectRequestsRepository.findByIdWithRelations(requestId);
  if (request === undefined) {
    return denied(user, requestId, 'request_not_found');
  }

  const ctx = resolveRequestLens(user, request);
  if (ctx === null) {
    return denied(user, requestId, 'no_lens');
  }

  // ── Admin arm ──────────────────────────────────────────────────────────────────────
  // Both checks are required and neither substitutes for the other: the LENS decides
  // whether the admin surface renders, the PLATFORM CAPABILITY authorizes a cross-tenant
  // read of party data (ADR-1035 / ADR-1048 §6). Read-only — the admin arm never reaches
  // an upload/grant/delete path (asserted by the invariant tests).
  if (ctx.archetype === 'observer') {
    if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.VIEW_ANY_REQUEST_FILE)) {
      return denied(user, requestId, 'admin_capability_denied');
    }
    const tracks = await loadTracks(requestId);
    return { ok: true, side: 'admin', request, tracks };
  }

  // ── Client arm ─────────────────────────────────────────────────────────────────────
  // ⚠ THE CAPABILITY, NOT THE LENS. `resolveRequestLens` matches `user.companyId ===
  // request.companyId` — a VIEW rule. Mutation authorization is the membership axis
  // (Ruling 3's "the SAME participation predicate that grants upload" — one predicate,
  // used for upload AND delete).
  if (ctx.lens === 'client') {
    const allowed = await hasCapability(user, CAPABILITIES.PARTICIPATE, {
      companyId: request.companyId,
    });
    if (!allowed) {
      return denied(user, requestId, 'client_capability_denied');
    }
    const tracks = await loadTracks(requestId);
    return { ok: true, side: 'client', request, companyId: request.companyId, tracks };
  }

  // ── Expert arm ─────────────────────────────────────────────────────────────────────
  // `ctx.relationshipId` is the viewer's OWN track, resolved by the lens from
  // `expertProfileId` — never a request-body value. The expert arm never receives the
  // other tracks.
  if (ctx.relationshipId === null) {
    return denied(user, requestId, 'expert_no_relationship');
  }
  const tracks = await loadTracks(requestId);
  const viewer = tracks.find((track) => track.relationshipId === ctx.relationshipId);
  if (viewer === undefined) {
    // The viewer's relationship vanished between the lens read and the full re-read
    // (e.g. a hard delete race) — fail closed, same copy as every other denial.
    return denied(user, requestId, 'expert_track_missing');
  }
  return { ok: true, side: 'expert', request, viewer };
}
