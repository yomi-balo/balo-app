import 'server-only';

import {
  requestSharedFilesRepository,
  usersRepository,
  type ConversationMessage,
  type RequestFileWithGrants,
} from '@balo/db';
import {
  requestFileVisibleToClient,
  requestFileVisibleToTrack,
  resolveRequestFileAudience,
} from '@balo/shared/authz';
import type { SessionUser } from '@/lib/auth/session';
import { mapMessageRowToView } from '@/lib/conversations/conversation-view';
import type { ConversationMessageView } from '@/lib/conversations/conversation-view-types';
import { authorizeRequestFileScope, type RequestFileScope } from './authorize-request-file-scope';
import {
  fullName,
  loadTrackDisplays,
  toSerializerFile,
  uploaderLabelOf,
} from './load-request-files';
import {
  toAdminRequestFileView,
  toClientRequestFileView,
  toExpertRequestFileView,
  type AdminRequestFileVisibleTrack,
  type RequestFileSerializerFile,
  type RequestFileSerializerTrack,
  type RequestThreadFileCard,
} from './request-file-audience-view';

/** A repository message row joined with its sender's names — the input to `mapMessageRowToView`. */
export type ThreadMessageRow = ConversationMessage & {
  senderFirstName: string | null;
  senderLastName: string | null;
};

type ResolvedScope = Extract<RequestFileScope, { ok: true }>;

/**
 * Resolves the REQUEST-SHARE card messages of one thread page against the VIEWER (BAL-617).
 *
 * A share message row carries only `requestSharedFileId`; the card is built here, per viewer, on
 * every read, and is never stored or published. That is what keeps the audience rules honest:
 * the card's shape is the viewer's own lens (the expert never receives an audience-bearing
 * view), and a file the viewer can no longer see takes its message with it.
 *
 * Per row:
 *  - **Expert** — a card only while the file is live, the expert's track is live, and
 *    `requestFileVisibleToTrack` passes. A revoked grant, a deleted file or a closed track DROPS
 *    the message (AC5 / ADR-1048).
 *  - **Client** — a live file the client can see gets a `client` card; a file deleted after it
 *    was shared becomes a `client_removed` tombstone (name only).
 *  - **Admin** — an `admin` card, tombstones included.
 *  - Scope denied, or the file missing from this request, DROPS the message.
 *
 * Rows that are not share messages pass through unchanged. Returns without any query when no
 * row carries a file id. Authorization is ONE `authorizeRequestFileScope` call for the page,
 * never `lens`.
 *
 * ⚠ DROPPED ROWS AND "LOAD EARLIER". A hidden row is removed from the page after the keyset
 * window is cut, so a page whose every row is hidden would report `hasEarlier` with nothing to
 * show. That needs a whole 30-row page of hidden shares; it is accepted rather than paid for
 * with a second query per page.
 */
export async function attachRequestFileCards(
  user: SessionUser,
  requestId: string,
  rows: readonly ThreadMessageRow[]
): Promise<ConversationMessageView[]> {
  const fileIds = [...new Set(rows.flatMap((row) => shareFileIdOf(row) ?? []))];
  if (fileIds.length === 0) return rows.map(mapMessageRowToView);

  const scope = await authorizeRequestFileScope(user, requestId);
  const filesById = scope.ok
    ? new Map(
        (
          await requestSharedFilesRepository.listByIdsInRequest(scope.request.id, fileIds, {
            includeDeleted: true,
          })
        ).map((entry) => [entry.file.id, entry])
      )
    : new Map<string, RequestFileWithGrants>();
  const cardOf = scope.ok ? await cardResolver(scope, [...filesById.values()]) : null;

  const views: ConversationMessageView[] = [];
  for (const row of rows) {
    const view = mapMessageRowToView(row);
    const fileId = shareFileIdOf(row);
    if (fileId === null) {
      views.push(view);
      continue;
    }
    const entry = filesById.get(fileId);
    const card = entry === undefined || cardOf === null ? null : cardOf(entry);
    if (card !== null) views.push({ ...view, requestSharedFile: card });
  }
  return views;
}

/** The share's file id, or null for an ordinary message. */
function shareFileIdOf(row: ThreadMessageRow): string | null {
  return typeof row.requestSharedFileId === 'string' ? row.requestSharedFileId : null;
}

type CardResolver = (entry: RequestFileWithGrants) => RequestThreadFileCard | null;

async function nameMapFor(entries: readonly RequestFileWithGrants[]): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const { file } of entries) {
    ids.add(file.uploadedByUserId);
    if (file.deletedByUserId !== null) ids.add(file.deletedByUserId);
  }
  const named = await usersRepository.findNamesByIds([...ids]);
  return new Map(named.map((u) => [u.id, fullName(u.firstName, u.lastName, 'Someone')]));
}

/** Builds the per-lens card function once for the page (one track read, one name read). */
async function cardResolver(
  scope: ResolvedScope,
  entries: readonly RequestFileWithGrants[]
): Promise<CardResolver> {
  const clientCompanyName = scope.request.company?.name ?? 'the client';

  if (scope.side === 'expert') {
    const { viewer } = scope;
    const joinedAt = viewer.standing.openedAt ?? new Date(0);
    return ({ file, grants }) => {
      if (file.deletedAt !== null || viewer.access.kind !== 'live') return null;
      const serialized = toSerializerFile(file);
      const grantedIds = new Set(grants.map((g) => g.relationshipId));
      if (!requestFileVisibleToTrack(serialized, viewer, grantedIds)) return null;
      return {
        kind: 'expert',
        file: toExpertRequestFileView(serialized, clientCompanyName, {
          relationshipId: viewer.relationshipId,
          joinedAt,
          access: viewer.access,
        }),
      };
    };
  }

  const [tracks, nameOf] = await Promise.all([loadTrackDisplays(scope), nameMapFor(entries)]);

  if (scope.side === 'client') {
    return ({ file, grants }) => {
      // Visibility is judged as if the file were live, so a tombstone appears only for a file
      // this client could have seen — never for one on an expert track they cannot see.
      if (!requestFileVisibleToClient({ ...file, deletedAt: null }, scope.tracks)) return null;
      if (file.deletedAt !== null) return { kind: 'client_removed', fileName: file.fileName };
      return {
        kind: 'client',
        file: toClientRequestFileView(
          toSerializerFile(file),
          new Set(grants.map((g) => g.relationshipId)),
          tracks,
          uploaderLabelOf(file, tracks, nameOf, clientCompanyName)
        ),
      };
    };
  }

  return ({ file, grants }) => {
    const serialized = toSerializerFile(file);
    return {
      kind: 'admin',
      file: toAdminRequestFileView(
        serialized,
        uploaderLabelOf(file, tracks, nameOf, clientCompanyName),
        visibleTracksOf(serialized, grants, tracks),
        file.deletedByUserId === null ? null : (nameOf.get(file.deletedByUserId) ?? 'Someone')
      ),
    };
  };
}

function visibleTracksOf(
  file: RequestFileSerializerFile,
  grants: ReadonlyArray<{ relationshipId: string }>,
  tracks: readonly RequestFileSerializerTrack[]
): AdminRequestFileVisibleTrack[] {
  return resolveRequestFileAudience(file, tracks, new Set(grants.map((g) => g.relationshipId))).map(
    (entry) => ({
      relationshipId: entry.relationshipId,
      trackName:
        tracks.find((t) => t.relationshipId === entry.relationshipId)?.trackName ?? 'Expert',
      via: entry.via,
    })
  );
}
