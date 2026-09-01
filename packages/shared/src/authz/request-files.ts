/**
 * BAL-431 / ADR-1048 — THE PURE AUDIENCE CORE for request-stage shared files.
 *
 * PURE and dependency-free, exactly like `./platform` and `./engagement`: NO `@balo/db`, NO
 * `postgres`, NO logging, NO I/O. That is what lets `@balo/db`'s repository, the web Server
 * Actions and the client-safe seam all reach ONE rule rather than three.
 *
 * ⚠ SITED HERE, BESIDE `relationshipDeniesHosting`, ON PURPOSE (Ruling 2's location
 * correction). The "declined" arm of every predicate below IS `relationshipDeniesHosting`
 * and nothing else — there must never be a second definition of "declined"
 * (`./engagement.ts:140-142`, CLAUDE.md).
 */

import { relationshipDeniesHosting, type RelationshipHostingStatus } from './engagement';

/**
 * The four `request_expert_relationships` columns the FILE plane reads. STRUCTURAL on
 * purpose — typing it against `@balo/db`'s row would drag a DB dependency into a module
 * whose whole contract is that it has none. The real Drizzle row satisfies it.
 *
 * ⚠ IT EXTENDS `RelationshipHostingStatus`, WHICH IS THE POINT: the `declined` arm is
 * `relationshipDeniesHosting` and nothing else.
 */
export interface RequestTrackFileStanding extends RelationshipHostingStatus {
  /** Withdrawal is a SOFT DELETE, not a status (`./engagement.ts:167-172`). */
  readonly deletedAt: Date | null;
  /** BAL-431 — closed by award (Ruling 2). Stamped by `markNotSelectedByAward`. */
  readonly notSelectedAt: Date | null;
}

/**
 * ⚠ THE SINGLE DEFINITION of "this track is CLOSED, and when" for the FILE plane
 * (BAL-431 / ADR-1048 §2 + §5 as amended by Ruling 2). Everything else in this module is a
 * one-line derivation of it; there must never be a second.
 *
 *   { kind: 'live' }                    ⇒ receives new shares.
 *   { kind: 'closed'; closedAt: Date }  ⇒ historical-read from `closedAt` backwards.
 *   { kind: 'closed'; closedAt: null }  ⇒ FAIL CLOSED. The row says closed but names no
 *                                         instant (a partial write: `status = 'declined'`
 *                                         with `declined_at` NULL). NO historical read is
 *                                         granted, because nothing can be ordered against
 *                                         an unknown.
 *
 * ⚠ THIS IS NOT `isThreadOpenStatus`, AND MUST NEVER BE CONFLATED WITH IT.
 * `isThreadOpenStatus` (`apps/web/src/lib/project-request/conversation-view-types.ts:54`)
 * deliberately EXCLUDES `invited` and is pinned by a test. "Live for files" INCLUDES
 * `invited` — ADR-1048's headline scenario is that a late invitee inherits every prior
 * share-to-all the moment their track exists. Two genuinely different notions of "live".
 * DO NOT touch `isThreadOpenStatus`, and DO NOT adopt this predicate into messages or
 * meetings in this PR (Ruling 2 / standing constraint 3).
 */
export type RequestTrackFileAccess =
  | { readonly kind: 'live' }
  | { readonly kind: 'closed'; readonly closedAt: Date | null };

/**
 * Resolve one track's file-plane standing.
 *
 * Closure is the EARLIEST of the three instants: a track that declined and was later swept
 * by an award closed when it DECLINED, not when the award landed. Historical-read is an
 * inequality against that instant, so picking the later one would silently widen access.
 */
export function resolveRequestTrackFileAccess(
  track: RequestTrackFileStanding
): RequestTrackFileAccess {
  const declined = relationshipDeniesHosting(track);
  if (!declined && track.deletedAt === null && track.notSelectedAt === null) {
    return { kind: 'live' };
  }

  const instants = [
    // ⚠ Only when `relationshipDeniesHosting` says so — never by re-reading `status`.
    declined ? track.declinedAt : null,
    track.deletedAt,
    track.notSelectedAt,
  ].filter((d): d is Date => d !== null);

  const [first, ...rest] = instants;
  if (first === undefined) {
    // Closed by label with no instant anywhere. FAIL CLOSED.
    return { kind: 'closed', closedAt: null };
  }
  const earliest = rest.reduce((a, b) => (b.getTime() < a.getTime() ? b : a), first);
  return { kind: 'closed', closedAt: earliest };
}

/** THE live-track predicate. A one-line derivation — never a second rule. */
export function requestTrackIsLiveForFiles(track: RequestTrackFileStanding): boolean {
  return resolveRequestTrackFileAccess(track).kind === 'live';
}

/**
 * HISTORICAL-READ, in one inequality (ADR-1048 §2): "decline ends the future, not the past".
 * A closed track keeps every `all_live_tracks` share made STRICTLY BEFORE it closed — a
 * share landing at exactly `closedAt` is NOT readable.
 */
export function trackCanReadAllAudienceShare(
  access: RequestTrackFileAccess,
  sharedAt: Date
): boolean {
  if (access.kind === 'live') return true;
  if (access.closedAt === null) return false; // fail closed
  return sharedAt.getTime() < access.closedAt.getTime();
}

/**
 * The audience-relevant facts of ONE file. Structural; the Drizzle `request_shared_files`
 * row satisfies it.
 */
export interface RequestFileAudienceFacts {
  readonly side: 'client' | 'expert';
  readonly audience: 'all_live_tracks' | 'grants' | 'own_track';
  readonly expertRelationshipId: string | null;
  readonly createdAt: Date;
  readonly deletedAt: Date | null;
}

/** One resolved track, as the audience functions see it. */
export interface RequestTrackRef {
  readonly relationshipId: string;
  readonly expertProfileId: string;
  readonly access: RequestTrackFileAccess;
}

/**
 * ⚠⚠ THE ONE PER-FILE VISIBILITY RULE FOR THE EXPERT SIDE. Every read path, the download
 * gate, the admin "visible now to" chips and the DELETE AUDIT SNAPSHOT all resolve through
 * this function — so "who can see this file" has exactly one answer, computed one way.
 *
 * ⚠ THE CROSS-TRACK INVARIANT (ADR-1048 §7) IS THE `side === 'expert'` LINE. A sibling
 * candidate's upload is never visible, because the comparison is against the viewer's OWN
 * relationship id, taken from the gate — never from a request body.
 *
 * ⚠ A TOMBSTONE IS INVISIBLE HERE. The admin lens renders tombstones through a DIFFERENT,
 * explicitly-named path (`includeDeleted`), never by relaxing this predicate.
 */
export function requestFileVisibleToTrack(
  file: RequestFileAudienceFacts,
  viewer: RequestTrackRef,
  grantedRelationshipIds: ReadonlySet<string>
): boolean {
  if (file.deletedAt !== null) return false;

  if (file.side === 'expert') {
    return (
      file.expertRelationshipId !== null && file.expertRelationshipId === viewer.relationshipId
    );
  }

  switch (file.audience) {
    case 'grants':
      // Grants survive closure UNCONDITIONALLY — a NEW grant to a closed track is impossible
      // (the repository rejects it in-transaction), so every grant is pre-closure by
      // construction. See the `request_file_grants` docblock.
      return grantedRelationshipIds.has(viewer.relationshipId);
    case 'all_live_tracks':
      return trackCanReadAllAudienceShare(viewer.access, file.createdAt);
    case 'own_track':
      // Unrepresentable for a client file (`request_shared_file_side_shape`) — fail closed.
      return false;
  }
}

/** How a track came to see a file — for the admin lens and the delete-time audit snapshot. */
export type RequestFileAudienceVia = 'own_track' | 'grant' | 'all_live_tracks';

export interface ResolvedRequestFileAudienceEntry {
  readonly relationshipId: string;
  readonly expertProfileId: string;
  readonly via: RequestFileAudienceVia;
}

/**
 * The INVERSE read: which tracks can see this file, right now. Defined as a FILTER over
 * {@link requestFileVisibleToTrack} so it can never drift from the read rule — which matters
 * most for the DELETE audit snapshot, where being wrong is unrecoverable (`audit_events` is
 * append-only; Ruling 4).
 */
export function resolveRequestFileAudience(
  file: RequestFileAudienceFacts,
  tracks: readonly RequestTrackRef[],
  grantedRelationshipIds: ReadonlySet<string>
): ResolvedRequestFileAudienceEntry[] {
  return tracks
    .filter((t) => requestFileVisibleToTrack(file, t, grantedRelationshipIds))
    .map((t) => ({
      relationshipId: t.relationshipId,
      expertProfileId: t.expertProfileId,
      via: viaFor(file),
    }));
}

/** The `via` label for one file, derived from the same two columns the rule reads. */
function viaFor(file: RequestFileAudienceFacts): RequestFileAudienceVia {
  if (file.side === 'expert') return 'own_track';
  return file.audience === 'grants' ? 'grant' : 'all_live_tracks';
}
