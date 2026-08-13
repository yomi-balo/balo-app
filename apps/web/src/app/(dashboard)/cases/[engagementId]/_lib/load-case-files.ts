import 'server-only';

import {
  conversationsRepository,
  isTwoSidedParty,
  meetingFilesRepository,
  usersRepository,
  MEETING_FILE_LIST_LIMIT,
  type ConversationFile,
  type MeetingFile,
} from '@balo/db';
import { personDisplayName } from '@balo/shared/parties';
import { log } from '@/lib/logging';
import type { CaseFileRowView } from '@/lib/cases/case-view-types';

/**
 * BAL-421 §D4 — THE FILE MERGE. `meeting_files` ∪ `conversation_files`, ON READ.
 *
 * ⚠⚠ THIS IS AN INSTRUCTION FROM THE SCHEMA, NOT AN INVENTION.
 * `packages/db/src/schema/meeting-files.ts` states it plainly: "BAL-421 MERGES THE TWO ON READ
 * in the case surface; neither table is a view of the other and neither is going away." They
 * differ STRUCTURALLY — a meeting file carries a two-sided `party` and a `source`
 * (`chat`/`files_tab`) and hangs off ONE meeting; a conversation file carries an uploader and
 * hangs off the thread. So the merge is a DISCRIMINATED UNION on `origin`, never a widening:
 * the download action branches on it to pick each side's OWN authorization helper (a meeting
 * file goes through BAL-423's `authorizeMeetingFileAccess`, a conversation file through the
 * case gate + a conversation-scoped lookup). Flattening `origin` away would force ONE gate
 * onto two different tables, which is how a file surface grows an IDOR.
 *
 * ⚠⚠ `r2Key` IS STRUCTURALLY ABSENT FROM EVERY ROW THIS RETURNS. It is the exact object
 * locator the presigner signs, and `CaseFileRowView` has no field for it. Every row is built
 * FIELD BY FIELD below, never spread — TypeScript's excess-property checking does NOT apply to
 * spreads, which is exactly how this class of leak ships unnoticed (memory
 * `reference_drizzle_with_hydration_leaks_secrets`).
 *
 * ⚠ NO EMAIL ADDRESS IS EVER RESOLVED (ADR-1044). Uploader labels come from
 * `usersRepository.findNamesByIds`, which projects `id / firstName / lastName` ONLY — never
 * `email` or `workosId` — in ONE batched query over the distinct uploader set across BOTH
 * sources. Concealment is enforced by NOT LOADING the column, never by remembering to omit it.
 *
 * ⚠ A `meeting_files` ROW WHOSE `party` IS NOT TWO-SIDED IS DROPPED, NEVER COERCED — the same
 * fail-closed posture as `map-recap-files.ts` and `list-meeting-files.ts`. Guessing an
 * attribution is worse than omitting the file, and a read path that disagreed with the recap's
 * about whether a file exists is the divergence that turns fail-closed into a bypass.
 */

/**
 * How many of the case's most recent meetings the merge fans out over.
 *
 * ⚠ A BOUND ON QUERY COUNT, AND IT MUST NEVER BE SILENT. `listByMeeting` is one query per
 * meeting, so a case with forty consultations would otherwise be forty round trips on a page
 * render. When the bound bites, `truncated` comes back `true` and the card SAYS SO — the
 * "no silent caps" rule. A case with more than twenty consultations is far outside anything
 * the product has produced, so in practice this never fires.
 */
export const CASE_FILE_MEETING_FAN_OUT = 20;

/** One consultation the merge may pull files from, narrowed to what the label needs. */
export interface CaseFileMeetingRef {
  meetingId: string;
  /** From `deriveConsultationOrdinal`. `null` ⇒ cancelled, so the label carries no number. */
  ordinal: number | null;
  /** `COALESCE(started_at, scheduled_start)` — how "most recent" is decided. */
  occurredAt: Date;
}

export interface CaseFilesResult {
  files: CaseFileRowView[];
  /**
   * TRUE when the merge was BOUNDED — either the meeting fan-out was capped, or some meeting
   * returned exactly `MEETING_FILE_LIST_LIMIT` rows.
   *
   * ⚠ THE SECOND CONDITION MATTERS MORE THAN THE FIRST, AND IT IS THE COUNTER-INTUITIVE ONE:
   * `listByMeeting` is capped at 200 **OLDEST-FIRST**, so hitting the cap drops the NEWEST
   * files — precisely the ones a viewer is looking for. Reporting the bound is what stops the
   * card reading as a complete list when it is not.
   */
  truncated: boolean;
}

/** "Consultation 3" / "Consultation" (cancelled, so unnumbered) / "Conversation". */
function meetingSourceLabel(ordinal: number | null): string {
  return ordinal === null ? 'Consultation' : 'Consultation ' + ordinal;
}

/**
 * Resolve display labels for every uploader across BOTH sources, in ONE query.
 *
 * The viewer is excluded from the lookup entirely — their own uploads render as "You", which
 * needs no name — so a case whose files are all the viewer's own costs zero extra queries.
 */
async function resolveUploaderLabels(
  uploaderIds: readonly string[],
  viewerUserId: string
): Promise<ReadonlyMap<string, string>> {
  const distinct = [...new Set(uploaderIds)].filter((id) => id !== viewerUserId);
  const byId = new Map<string, string>();
  if (distinct.length === 0) return byId;

  const people = await usersRepository.findNamesByIds(distinct);
  for (const person of people) {
    // FIRST NAME ONLY — the counterparty's surname adds nothing to a file row and every
    // extra identifier is one more thing crossing the party boundary.
    byId.set(person.id, personDisplayName(person.firstName, null, 'Someone'));
  }
  return byId;
}

/**
 * Merge one case's meeting files and conversation files into a single NEWEST-FIRST list.
 *
 * ⚠ THE CALLER MUST HAVE PASSED THE TENANCY GATE FIRST. Both `meetingId` and `conversationId`
 * arrive already resolved from `resolveCaseAccess` + `listMeetingsForContext`; this function
 * authorizes nothing and must never be handed an id taken from a URL.
 */
export async function loadCaseFiles(input: {
  meetings: readonly CaseFileMeetingRef[];
  conversationId: string;
  viewerUserId: string;
}): Promise<CaseFilesResult> {
  const { meetings, conversationId, viewerUserId } = input;

  // Most recent first, then capped — so when the bound bites it drops the OLDEST
  // consultations, whose files are the least likely to be wanted.
  const ordered = [...meetings].sort((a, b) => {
    const delta = b.occurredAt.getTime() - a.occurredAt.getTime();
    return delta !== 0 ? delta : a.meetingId.localeCompare(b.meetingId);
  });
  const fanOut = ordered.slice(0, CASE_FILE_MEETING_FAN_OUT);
  let truncated = fanOut.length < ordered.length;

  const [meetingFileGroups, conversationFiles] = await Promise.all([
    Promise.all(
      fanOut.map(async (ref) => ({
        ref,
        rows: await meetingFilesRepository.listByMeeting(ref.meetingId),
      }))
    ),
    conversationsRepository.listFiles(conversationId, { kind: 'full' }),
  ]);

  const rows: Array<{ row: CaseFileRowView; sortAt: number; uploaderId: string }> = [];

  for (const group of meetingFileGroups) {
    if (group.rows.length >= MEETING_FILE_LIST_LIMIT) {
      // ⚠ OLDEST-FIRST CAP ⇒ THE NEWEST FILES ARE THE ONES MISSING. Never silent.
      truncated = true;
      log.warn('Case file merge hit the per-meeting file cap', {
        meetingId: group.ref.meetingId,
        limit: MEETING_FILE_LIST_LIMIT,
      });
    }
    for (const file of group.rows) {
      if (!isTwoSidedParty(file.party)) {
        // DROPPED, NEVER COERCED — see the module docblock.
        log.warn('Dropping case file with a non-two-sided party', {
          meetingId: file.meetingId,
          fileId: file.id,
          party: file.party,
        });
        continue;
      }
      rows.push(buildMeetingFileRow(file, group.ref));
    }
  }

  for (const file of conversationFiles) {
    rows.push(buildConversationFileRow(file));
  }

  const uploaderLabels = await resolveUploaderLabels(
    rows.map((entry) => entry.uploaderId),
    viewerUserId
  );

  // NEWEST FIRST — the design reference's Files card reads most-recent-at-top, the opposite
  // of the consultation list's "newest last" story order. Both repositories return
  // oldest-first, so this ordering is applied once, here, over the merged set.
  rows.sort((a, b) =>
    a.sortAt !== b.sortAt ? b.sortAt - a.sortAt : a.row.id.localeCompare(b.row.id)
  );

  const files = rows.map((entry) => ({
    ...entry.row,
    uploaderLabel:
      entry.uploaderId === viewerUserId
        ? 'You'
        : (uploaderLabels.get(entry.uploaderId) ?? 'Someone'),
  }));

  return { files, truncated };
}

/** ⚠ FIELD BY FIELD, NEVER SPREAD — `r2Key` has no field to land in. */
function buildMeetingFileRow(
  file: MeetingFile,
  ref: CaseFileMeetingRef
): { row: CaseFileRowView; sortAt: number; uploaderId: string } {
  return {
    uploaderId: file.uploadedByUserId,
    sortAt: file.createdAt.getTime(),
    row: {
      origin: 'meeting',
      id: file.id,
      meetingId: file.meetingId,
      fileName: file.fileName,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      createdAtIso: file.createdAt.toISOString(),
      // Replaced by the batched label below; declared here so the shape is complete.
      uploaderLabel: '',
      sourceLabel: meetingSourceLabel(ref.ordinal),
    },
  };
}

/** ⚠ FIELD BY FIELD, NEVER SPREAD — see {@link buildMeetingFileRow}. */
function buildConversationFileRow(file: ConversationFile): {
  row: CaseFileRowView;
  sortAt: number;
  uploaderId: string;
} {
  return {
    uploaderId: file.uploadedByUserId,
    sortAt: file.createdAt.getTime(),
    row: {
      origin: 'conversation',
      id: file.id,
      // ⚠ `null` BY CONSTRUCTION — a conversation file hangs off the THREAD, not a meeting,
      // and the download action reads this to decide which gate applies.
      meetingId: null,
      fileName: file.fileName,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      createdAtIso: file.createdAt.toISOString(),
      uploaderLabel: '',
      sourceLabel: 'Conversation',
    },
  };
}
