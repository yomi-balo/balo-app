/**
 * Audience-keyed request-file serializer (BAL-431 / ADR-1048 §3). There is NO expert-side file
 * serializer today — only the shared, audience-less `mapConversationFileRowToView`
 * (`apps/web/src/lib/conversations/conversation-view.ts:67-81`). This is net-new, modelled on
 * `proposal-audience-view.ts`'s structural discipline: FIELD-BY-FIELD PROJECTION, NEVER A
 * SPREAD, with the audience block attached ONLY on the arms entitled to it.
 *
 * ── THE EXPERT VIEW'S THREE CONCEALMENT RULES ─────────────────────────────────────────────
 * 1. NO AUDIENCE METADATA, AT ANY NESTING LEVEL — no type, no count, no grant list, no
 *    `relationshipId`. Audience shape reveals how many competitors a candidate faces
 *    (ADR-1048 §3); this is fee concealment's sibling.
 * 2. NO AUDIT DATA (Ruling 4's last bullet) — audit rows are audience-shaped by construction.
 * 3. `sharedBeforeYouJoined` IS PERMITTED, and ONLY that, because it derives from DATES ONLY —
 *    `file.createdAt < viewer.invitedAt` — never from audience. Computed HERE; the boolean,
 *    never the dates, crosses the boundary.
 *
 * Also: `source: 'client' | 'you'` says WHO, never HOW MANY; `r2Key` has no field on any of the
 * three views (the `mapConversationFileRowToView` rule).
 */

import type { RequestTrackFileAccess, RequestFileAudienceVia } from '@balo/shared/authz';
import { trackCanReadAllAudienceShare } from '@balo/shared/authz';

export type RequestFileAudienceLens = 'client' | 'expert' | 'admin';

/** Every audience-bearing field, as DATA, so the concealment test is a real proof. */
export const REQUEST_FILE_CONCEALED_KEYS = [
  'audience',
  'audienceType',
  'audienceLabel',
  'grants',
  'grantedTo',
  'liveTrackCount',
  'trackCount',
  'visibleTo',
  'sharedWith',
  'expertRelationshipId',
  'relationshipId',
  'r2Key',
  'auditEvents',
  'accessHistory',
  'deletedByUserId',
  'uploadedByUserId',
] as const;

/** The EXACT key set of the expert view. */
export const REQUEST_FILE_EXPERT_VIEW_KEYS = [
  'id',
  'fileName',
  'contentType',
  'sizeBytes',
  'source', // 'client' | 'you' — WHO, not HOW MANY.
  'uploadedByName',
  'createdAtIso',
  'sharedBeforeYouJoined',
  'canDelete',
] as const;

export const REQUEST_FILE_CLIENT_VIEW_KEYS = [
  'id',
  'fileName',
  'contentType',
  'sizeBytes',
  'source',
  'uploadedByName',
  'createdAtIso',
  'audience',
  'canDelete',
] as const;

export const REQUEST_FILE_ADMIN_VIEW_KEYS = [
  'id',
  'fileName',
  'contentType',
  'sizeBytes',
  'side',
  'audience',
  'uploadedByName',
  'createdAtIso',
  'visibleTo',
  'deleted',
  'deletedAtIso',
  'deletedByName',
] as const;

// ── Raw input shapes — structural, so a test can feed an over-wide row without a DB. ──────

/** The audience-relevant facts of ONE file, as the serializer needs them. */
export interface RequestFileSerializerFile {
  readonly id: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly side: 'client' | 'expert';
  readonly audience: 'all_live_tracks' | 'grants' | 'own_track';
  readonly expertRelationshipId: string | null;
  readonly createdAt: Date;
  readonly deletedAt: Date | null;
  readonly deletedByUserId: string | null;
}

/** One track's display facts + resolved standing, as the serializer needs them. */
export interface RequestFileSerializerTrack {
  readonly relationshipId: string;
  readonly expertProfileId: string;
  readonly trackName: string;
  readonly access: RequestTrackFileAccess;
  /**
   * WHY the track is closed, for the client annotation copy — `null` when live. Derived by the
   * caller from `relationshipDeniesHosting` / `notSelectedAt`, never re-derived here (this
   * module has no `'declined'` / `'not_selected'` literal comparison of its own — see the
   * `request-file-no-lens-gate` / `request-file-single-live-definition` invariant tests).
   */
  readonly closedReason: 'declined' | 'not_selected' | null;
}

// ── Client view ─────────────────────────────────────────────────────────────────────────

export interface ClientRequestFileAudienceAnnotation {
  relationshipId: string;
  trackName: string;
  reason: 'declined' | 'not_selected';
  /** true = this track kept access (the file was shared before it closed). */
  keptAccess: boolean;
}

export type ClientRequestFileAudience =
  | {
      type: 'all_live_tracks';
      liveTrackCount: number;
      annotations: ClientRequestFileAudienceAnnotation[];
    }
  | { type: 'grants'; grants: Array<{ relationshipId: string; trackName: string }> }
  | { type: 'expert_own_track' };

export interface ClientRequestFileView {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  source: 'client' | 'expert';
  uploadedByName: string;
  createdAtIso: string;
  audience: ClientRequestFileAudience;
  canDelete: boolean;
}

/** The `grants`-mode audience block: which tracks currently hold a live grant. */
function grantsAudience(
  grantedRelationshipIds: ReadonlySet<string>,
  tracks: readonly RequestFileSerializerTrack[]
): Extract<ClientRequestFileAudience, { type: 'grants' }> {
  return {
    type: 'grants',
    grants: tracks
      .filter((t) => grantedRelationshipIds.has(t.relationshipId))
      .map((t) => ({ relationshipId: t.relationshipId, trackName: t.trackName })),
  };
}

/** The `all_live_tracks`-mode audience block: the live count plus per-closed-track annotations. */
function allLiveTracksAudience(
  file: RequestFileSerializerFile,
  tracks: readonly RequestFileSerializerTrack[]
): Extract<ClientRequestFileAudience, { type: 'all_live_tracks' }> {
  return {
    type: 'all_live_tracks',
    liveTrackCount: tracks.filter((t) => t.access.kind === 'live').length,
    annotations: tracks
      .filter((t) => t.access.kind === 'closed' && t.closedReason !== null)
      .map((t) => ({
        relationshipId: t.relationshipId,
        trackName: t.trackName,
        // Narrowed by the filter above.
        reason: t.closedReason as 'declined' | 'not_selected',
        keptAccess: trackCanReadAllAudienceShare(t.access, file.createdAt),
      })),
  };
}

/**
 * `uploadedByName` for a client-uploaded row is "{Person} @ {Client}" (§12
 * `row.attribution.client`); for an expert-uploaded row it is the track's display name — the
 * client is always entitled to know WHICH expert uploaded (their own request).
 */
export function toClientRequestFileView(
  file: RequestFileSerializerFile,
  grantedRelationshipIds: ReadonlySet<string>,
  tracks: readonly RequestFileSerializerTrack[],
  uploadedByName: string
): ClientRequestFileView {
  // ⚠ ONE flat if/else-if, deliberately NOT a nested ternary (SonarCloud S3358) — three
  // mutually exclusive audience shapes, one per branch.
  let audience: ClientRequestFileAudience;
  if (file.side === 'expert') {
    audience = { type: 'expert_own_track' };
  } else if (file.audience === 'grants') {
    audience = grantsAudience(grantedRelationshipIds, tracks);
  } else {
    audience = allLiveTracksAudience(file, tracks);
  }

  return {
    id: file.id,
    fileName: file.fileName,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    source: file.side,
    uploadedByName,
    createdAtIso: file.createdAt.toISOString(),
    audience,
    // Ruling 3 — delete right ≡ upload right on that side. The client gate already proved
    // PARTICIPATE for the whole request, so every CLIENT-side file is deletable; an
    // expert-side file never is, from the client lens.
    canDelete: file.side === 'client',
  };
}

// ── Expert view — THE CONCEALMENT BOUNDARY ─────────────────────────────────────────────────

export interface ExpertRequestFileView {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  source: 'client' | 'you';
  uploadedByName: string;
  createdAtIso: string;
  sharedBeforeYouJoined: boolean;
  canDelete: boolean;
}

/**
 * ⚠⚠ THE SECURITY BOUNDARY. Every field here is enumerated ABOVE by
 * {@link REQUEST_FILE_EXPERT_VIEW_KEYS} and the negative-assertion test proves the runtime
 * projection matches — no audience field, no audit field, ever.
 *
 * `viewer` is the GATE-resolved own track (never a request-body value); a client file is, by
 * construction of `requestFileVisibleToTrack`, already filtered to ones this viewer may see
 * before this function is ever called — this function does not re-check visibility.
 */
export function toExpertRequestFileView(
  file: RequestFileSerializerFile,
  clientCompanyName: string,
  viewer: { relationshipId: string; invitedAt: Date; access: RequestTrackFileAccess }
): ExpertRequestFileView {
  const own = file.side === 'expert';
  return {
    id: file.id,
    fileName: file.fileName,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    source: own ? 'you' : 'client',
    uploadedByName: own ? 'You' : clientCompanyName,
    createdAtIso: file.createdAt.toISOString(),
    sharedBeforeYouJoined: file.createdAt.getTime() < viewer.invitedAt.getTime(),
    // Ruling 3 — delete right ≡ upload right on that side. A client file is never deletable by
    // an expert; an own-track file is deletable only while the track is LIVE (a closed track
    // can neither upload nor delete — it falls out of the same rule, no separate check).
    canDelete: own && viewer.access.kind === 'live',
  };
}

// ── Admin view — the read-only, all-files, tombstones-included lens ───────────────────────

export interface AdminRequestFileVisibleTrack {
  relationshipId: string;
  trackName: string;
  via: RequestFileAudienceVia;
}

export interface AdminRequestFileView {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  side: 'client' | 'expert';
  audience: 'all_live_tracks' | 'grants' | 'own_track';
  uploadedByName: string;
  createdAtIso: string;
  visibleTo: AdminRequestFileVisibleTrack[];
  deleted: boolean;
  deletedAtIso: string | null;
  deletedByName: string | null;
}

export function toAdminRequestFileView(
  file: RequestFileSerializerFile,
  uploadedByName: string,
  visibleTo: ReadonlyArray<{
    relationshipId: string;
    trackName: string;
    via: RequestFileAudienceVia;
  }>,
  deletedByName: string | null
): AdminRequestFileView {
  return {
    id: file.id,
    fileName: file.fileName,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    side: file.side,
    audience: file.audience,
    uploadedByName,
    createdAtIso: file.createdAt.toISOString(),
    visibleTo: visibleTo.map((v) => ({ ...v })),
    deleted: file.deletedAt !== null,
    deletedAtIso: file.deletedAt === null ? null : file.deletedAt.toISOString(),
    deletedByName: file.deletedAt === null ? null : deletedByName,
  };
}
