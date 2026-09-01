import 'server-only';

import {
  requestSharedFilesRepository,
  requestExpertRelationshipsRepository,
  usersRepository,
  REQUEST_SHARED_FILE_LIST_LIMIT,
  type RequestSharedFile,
} from '@balo/db';
import {
  relationshipDeniesHosting,
  requestFileVisibleToTrack,
  resolveRequestFileAudience,
  resolveRequestTrackFileAccess,
  type RequestTrackFileAccess,
} from '@balo/shared/authz';
import type { SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { authorizeRequestFileScope, type RequestFileScope } from './authorize-request-file-scope';
import {
  toClientRequestFileView,
  toExpertRequestFileView,
  toAdminRequestFileView,
  type ClientRequestFileView,
  type ExpertRequestFileView,
  type AdminRequestFileView,
  type RequestFileSerializerFile,
  type RequestFileSerializerTrack,
} from './request-file-audience-view';

/**
 * The server loader (BAL-431 §7.1) — resolves the scope gate, reads the request's shared
 * files, and serializes through the audience-keyed view for whichever lens the viewer holds.
 *
 * Returns `null` when the viewer has no file lens at all, so the panel is simply ABSENT, not an
 * error (§4.2 — deliberately ONE denial literal, so a stranger and a declined/removed expert
 * render identically: nothing).
 */
/** WHY a track is closed — a DISPLAY LABEL, never a liveness input. */
export type RequestTrackClosedReason = 'declined' | 'not_selected';

export type RequestFilesView =
  | {
      lens: 'client';
      files: ClientRequestFileView[];
      /** Live tracks only — the share picker's offerable target list. */
      liveTracks: { relationshipId: string; trackName: string }[];
    }
  | {
      lens: 'expert';
      files: ExpertRequestFileView[];
      /**
       * The CLIENT PARTY's display name, for the "Visible to {Client} only" reassurance on the
       * expert's own uploads (ADR-1048 §1 — an expert upload is hard-fixed to its own track;
       * the UI is what tells the expert so). A LENS-level fact, not a per-file one: it says
       * nothing about audience, and it is already on screen everywhere else on this page.
       */
      clientPartyName: string;
      /**
       * ⚠ THE REASON, NOT A BOOLEAN. `RequestTrackFileAccess.kind === 'closed'` deliberately
       * collapses declined ∨ withdrawn ∨ not-selected into one instant — but the banner has to
       * name the right one, and per OSD-3 a genuinely DECLINED expert cannot load this page at
       * all (`resolveRequestLens` walls them off), so the only expert who reaches the banner is
       * a NOT-SELECTED one. A boolean here told them they had declined. `null` = live.
       */
      closedReason: RequestTrackClosedReason | null;
    }
  | { lens: 'admin'; files: AdminRequestFileView[] };

export function fullName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  fallback: string
): string {
  const name = [firstName, lastName].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : fallback;
}

/**
 * THE ONE ATTRIBUTION FORM for a client-side upload, shared by the loader and the confirm
 * action so the same file reads identically before and after a reload (CLAUDE.md: retrospective
 * copy names the PERSON with "@ org"). Previously the confirm action emitted
 * "Sarah Chen @ Acme Corp" and the loader emitted a bare "Sarah Chen" for the same row.
 */
export function clientUploaderLabel(personName: string, clientCompanyName: string): string {
  return `${personName} @ ${clientCompanyName}`;
}

export function toSerializerFile(row: RequestSharedFile): RequestFileSerializerFile {
  return {
    id: row.id,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    side: row.side,
    audience: row.audience,
    expertRelationshipId: row.expertRelationshipId,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
    deletedByUserId: row.deletedByUserId,
  };
}

/**
 * Distinguishes WHY a closed track is closed, for the client annotation copy (Ruling 2) — a
 * distinction the file-plane predicate (`resolveRequestTrackFileAccess`) deliberately collapses
 * into one `closedAt` instant. Reuses `relationshipDeniesHosting` — never a second "declined"
 * check — and reads `notSelectedAt` directly, the one column that names the other reason.
 */
export function closedReasonOf(row: {
  status: string;
  declinedAt: Date | null;
  notSelectedAt: Date | null;
}): RequestTrackClosedReason | null {
  if (relationshipDeniesHosting(row)) return 'declined';
  if (row.notSelectedAt !== null) return 'not_selected';
  return null;
}

/**
 * Every track's DISPLAY facts (BAL-431 §7.1's "pairs each track with its display name"),
 * joined from TWO reads: the gate's already-resolved `RequestTrackFileAccess` (never
 * re-derived here — reused verbatim) and a full relationship-row re-read for the display name
 * and the closed-reason distinction the file-plane predicate collapses away.
 */
export async function loadTrackDisplays(
  scope: Extract<RequestFileScope, { ok: true; side: 'client' | 'admin' }>
): Promise<RequestFileSerializerTrack[]> {
  const relationships = await requestExpertRelationshipsRepository.listByRequest(scope.request.id);
  const nameByRelationship = new Map(
    scope.request.relationships.map((r) => [
      r.id,
      fullName(r.expertProfile.user.firstName, r.expertProfile.user.lastName, 'Expert'),
    ])
  );
  const accessByRelationship = new Map<string, RequestTrackFileAccess>(
    scope.tracks.map((t) => [t.relationshipId, t.access])
  );

  return relationships.map((r) => ({
    relationshipId: r.id,
    expertProfileId: r.expertProfileId,
    trackName: nameByRelationship.get(r.id) ?? 'Expert',
    // ⚠ Reused from the gate when present; falls back to a fresh resolve for a relationship
    // the gate's own read might have missed (there is none in practice — both reads filter
    // `deleted_at IS NULL` over the same request — but never leave this branch unreachable-only).
    access: accessByRelationship.get(r.id) ?? resolveRequestTrackFileAccess(r),
    closedReason: closedReasonOf(r),
  }));
}

export async function loadRequestFiles(
  user: SessionUser,
  requestId: string
): Promise<RequestFilesView | null> {
  const scope = await authorizeRequestFileScope(user, requestId);
  if (!scope.ok) return null;

  const rows = await requestSharedFilesRepository.listForRequest(scope.request.id, {
    includeDeleted: scope.side === 'admin',
  });
  if (rows.length === REQUEST_SHARED_FILE_LIST_LIMIT) {
    // A cap, not pagination (`REQUEST_SHARED_FILE_LIST_LIMIT`'s docblock) — silent truncation
    // on the ADMIN oversight lens especially would be a defect.
    log.warn('Request shared file list truncated at cap', {
      requestId: scope.request.id,
      side: scope.side,
      limit: REQUEST_SHARED_FILE_LIST_LIMIT,
    });
  }

  const uploaderIds = new Set<string>();
  const deleterIds = new Set<string>();
  for (const { file } of rows) {
    uploaderIds.add(file.uploadedByUserId);
    if (file.deletedByUserId !== null) deleterIds.add(file.deletedByUserId);
  }
  const namedUsers = await usersRepository.findNamesByIds([...uploaderIds, ...deleterIds]);
  const nameOf = new Map(
    namedUsers.map((u) => [u.id, fullName(u.firstName, u.lastName, 'Someone')])
  );

  const clientCompanyName = scope.request.company?.name ?? 'the client';

  if (scope.side === 'expert') {
    const invitedAt =
      scope.request.relationships.find((r) => r.id === scope.viewer.relationshipId)?.invitedAt ??
      new Date(0);
    const files = rows
      .filter(({ file, grants }) =>
        requestFileVisibleToTrack(
          toSerializerFile(file),
          scope.viewer,
          new Set(grants.map((g) => g.relationshipId))
        )
      )
      .map(({ file }) =>
        toExpertRequestFileView(toSerializerFile(file), clientCompanyName, {
          relationshipId: scope.viewer.relationshipId,
          invitedAt,
          access: scope.viewer.access,
        })
      );
    // ⚠ THE REASON, NOT `access.kind === 'closed'`. Derived from the gate's already-carried
    // standing columns — no second relationship read, and no second liveness definition.
    return {
      lens: 'expert',
      files,
      clientPartyName: clientCompanyName,
      closedReason: closedReasonOf(scope.viewer.standing),
    };
  }

  const tracks = await loadTrackDisplays(scope);

  if (scope.side === 'client') {
    const files = rows.map(({ file, grants }) =>
      toClientRequestFileView(
        toSerializerFile(file),
        new Set(grants.map((g) => g.relationshipId)),
        tracks,
        file.side === 'client'
          ? clientUploaderLabel(nameOf.get(file.uploadedByUserId) ?? 'Someone', clientCompanyName)
          : (tracks.find((t) => t.relationshipId === file.expertRelationshipId)?.trackName ??
              'Expert')
      )
    );
    const liveTracks = tracks
      .filter((t) => t.access.kind === 'live')
      .map((t) => ({ relationshipId: t.relationshipId, trackName: t.trackName }));
    return { lens: 'client', files, liveTracks };
  }

  // scope.side === 'admin' — the read-only, all-files, tombstones-included lens.
  const files = rows.map(({ file, grants }) => {
    const serialized = toSerializerFile(file);
    const grantedIds = new Set(grants.map((g) => g.relationshipId));
    const visibleTo = resolveRequestFileAudience(serialized, tracks, grantedIds).map((entry) => ({
      relationshipId: entry.relationshipId,
      trackName:
        tracks.find((t) => t.relationshipId === entry.relationshipId)?.trackName ?? 'Expert',
      via: entry.via,
    }));
    const uploaderName =
      file.side === 'client'
        ? clientUploaderLabel(nameOf.get(file.uploadedByUserId) ?? 'Someone', clientCompanyName)
        : (tracks.find((t) => t.relationshipId === file.expertRelationshipId)?.trackName ??
          'Expert');
    const deletedByName =
      file.deletedByUserId === null ? null : (nameOf.get(file.deletedByUserId) ?? 'Someone');
    return toAdminRequestFileView(serialized, uploaderName, visibleTo, deletedByName);
  });
  return { lens: 'admin', files };
}
