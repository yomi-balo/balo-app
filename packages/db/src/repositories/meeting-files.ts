import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { meetingFiles } from '../schema';
import type { MeetingFile, MeetingFileSource, MeetingParticipantParty } from '../schema';

/**
 * The two sides a meeting file can be attributed to — narrower than the reused three-label
 * `meeting_participant_party` enum, and exactly what the CHECK
 * `meeting_file_party_two_sided` permits. Mirrors `MeetingGuestParty`.
 */
export type MeetingFileParty = Extract<MeetingParticipantParty, 'client' | 'expert'>;

/**
 * ⚠ THE TWO-SIDED NARROWING, AS A REUSABLE PREDICATE — AND IT LIVES **HERE**, BESIDE
 * {@link MeetingFileParty}, FOR A HARD PACKAGING REASON.
 *
 * `meeting_files.party` reuses the THREE-label `meeting_participant_party` enum narrowed by
 * the CHECK `meeting_file_party_two_sided`, so `$inferSelect` types it WIDER (`observer`
 * included) than the database can ever hold. This predicate is what lets a view model say
 * "two-sided" in the TYPE without inventing a default for a label that cannot exist.
 *
 * ⚠ IT MUST NOT LIVE IN A `'use server'` MODULE. It was originally a private helper inside
 * `list-meeting-files.ts`, which carries `'use server'` — and a `'use server'` module may
 * export ONLY async functions. Exporting a synchronous type guard from there fails
 * `next build` (and ONLY `next build`: tsc, eslint and vitest all stay green — memory
 * `reference_use_server_no_value_exports`). BAL-132, BAL-388 and BAL-421 all need this
 * predicate, so it lives in a module they can all import.
 *
 * ⚠ A ROW THAT FAILS THIS IS **CORRUPT**, AND EVERY READ PATH MUST DROP IT RATHER THAN COERCE
 * IT. Guessing an attribution is worse than omitting the file — the same fail-closed posture
 * `selectPrimaryMeetingContext` takes when it drops a malformed context row.
 */
export function isTwoSidedParty(party: MeetingParticipantParty): party is MeetingFileParty {
  return party === 'client' || party === 'expert';
}

export interface AddMeetingFileInput {
  meetingId: string;
  /** ATTRIBUTION — who shared it. Survives their departure (`restrict`, ADR-1030). */
  uploadedByUserId: string;
  /**
   * ⚠ THE GATE'S RESOLVED SIDE, NEVER A REQUEST FIELD. `authorizeMeetingFileAccess`
   * returns it; the confirm action passes `access.side` straight through and its Zod input
   * schema has NO `party` key. See the table docblock — this is the load-bearing
   * anti-cross-party control.
   */
  party: MeetingFileParty;
  /** Which in-call entry point produced it (D0). A legitimate caller fact, unlike `party`. */
  source: MeetingFileSource;
  r2Key: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

export interface SoftDeleteMeetingFileInput {
  /** ⚠ THE GATE-VALIDATED meeting. Scoping by it IS the containment control — see below. */
  meetingId: string;
  fileId: string;
}

/** Same containment shape as {@link SoftDeleteMeetingFileInput}, for the single-row READ. */
export interface FindMeetingFileInput {
  /** ⚠ THE GATE-VALIDATED meeting. It is a WHERE-clause term, never a post-filter. */
  meetingId: string;
  fileId: string;
}

/**
 * ⚠ THE BOUND ON {@link meetingFilesRepository.listByMeeting}. An in-call file list is a
 * handful of decks, not a corpus; without a bound, one meeting accumulating thousands of
 * rows would pull every row AND EVERY `r2_key` into a Server Action's memory on each render.
 *
 * ⚠ IT IS A CAP, NOT PAGINATION, AND TRUNCATION IS NEVER SILENT. The order is oldest-first,
 * so a truncated list drops the NEWEST files — the ones a live call most wants. The caller
 * (`list-meeting-files.ts`) `log.warn`s when the returned count equals this cap. When
 * BAL-132 needs more than this, it adds real pagination (a keyset on
 * `meeting_file_meeting_idx`), never a bigger number.
 */
export const MEETING_FILE_LIST_LIMIT = 200;

/**
 * meeting_files (BAL-423) — the in-call file scope. A DELIBERATELY MINIMAL SURFACE: every
 * exported method is covered by `meeting-files.integration.test.ts`.
 *
 * ⚠ THERE IS NO BARE `findById`, DELIBERATELY — AND `findInMeeting` IS NOT ONE. Every
 * by-id read on this table takes the MEETING alongside the file id, and the meeting is a
 * term in the WHERE clause rather than a post-filter. That is the containment
 * `get-conversation-file-download.ts` names as "the whole IDOR story for `fileId`": a file
 * belonging to another meeting resolves to `undefined`, identically to a stale uuid, so
 * probing teaches nothing. A bare `findById` would invite a caller to skip the containment
 * and hand back another meeting's file to anyone holding its uuid. `softDelete` and
 * `findInMeeting` take `{ meetingId, fileId }` for exactly the same reason.
 *
 * NO AUTHORIZATION LIVES HERE (ADR-1029): the participation gate runs in the caller and
 * hands this repository an already-proven `meetingId` and an already-resolved `party`.
 */
export const meetingFilesRepository = {
  /**
   * CONTRACT — BARE INSERT, NO ERROR ISOLATION (the `conversationsRepository.addFile`
   * contract, restated). Can throw a RAW `23505` on a duplicate `r2Key`
   * (`meeting_file_key_idx`) or `23503` on an unknown `meetingId` / `uploadedByUserId`, and
   * `23514` if a caller smuggles `party='observer'` past the type system.
   *
   * ⚠ CALLED INSIDE AN OPEN TRANSACTION IT ABORTS THAT TRANSACTION (`25P02`) — the caller
   * MUST isolate it (its own SAVEPOINT) or pre-empt the conflict. The shipped caller
   * (`confirm-meeting-file-upload.ts`) invokes it STANDALONE and maps `23505` to friendly
   * "already shared" copy at `log.warn`, which satisfies the contract.
   */
  async add(input: AddMeetingFileInput): Promise<MeetingFile> {
    const [row] = await db
      .insert(meetingFiles)
      .values({
        meetingId: input.meetingId,
        uploadedByUserId: input.uploadedByUserId,
        party: input.party,
        source: input.source,
        r2Key: input.r2Key,
        fileName: input.fileName,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
      })
      .returning();
    if (row === undefined) {
      throw new Error('Failed to create meeting file');
    }
    return row;
  },

  /**
   * Live files for ONE meeting, oldest first.
   *
   * ⚠ BOTH SOURCES, UNFILTERED — that is D0's acceptance criterion ("listing a meeting's
   * files returns the chat-paperclip and Files-tab uploads in one set"), not an omission.
   * A caller that wants one entry point filters in its view model.
   *
   * Served by `meeting_file_meeting_idx` (meeting_id, created_at) WHERE deleted_at IS NULL.
   *
   * ⚠ BOUNDED AT {@link MEETING_FILE_LIST_LIMIT}. See that constant: it is a cap, not
   * pagination, and the caller warns when it is reached rather than truncating silently.
   */
  async listByMeeting(meetingId: string): Promise<MeetingFile[]> {
    return db
      .select()
      .from(meetingFiles)
      .where(and(eq(meetingFiles.meetingId, meetingId), isNull(meetingFiles.deletedAt)))
      .orderBy(asc(meetingFiles.createdAt))
      .limit(MEETING_FILE_LIST_LIMIT);
  },

  /**
   * ONE live file, SCOPED TO ITS MEETING — the download path's read.
   *
   * ⚠ EQUALLY CONTAINED AS `listByMeeting(...).find(...)`, BUT O(1). The meeting is a term
   * in the WHERE clause, so a foreign `fileId` and a soft-deleted one are the SAME answer
   * (`undefined`) and probing learns nothing — exactly the property the list-then-find shape
   * had. What it does NOT do is pull every row and every `r2_key` of the meeting into memory
   * to return one of them, and it does not silently depend on the list's cap.
   *
   * Served by the primary key; the `meeting_id` and `deleted_at` predicates are filters on
   * the single matched row.
   */
  async findInMeeting(input: FindMeetingFileInput): Promise<MeetingFile | undefined> {
    const [row] = await db
      .select()
      .from(meetingFiles)
      .where(
        and(
          eq(meetingFiles.id, input.fileId),
          eq(meetingFiles.meetingId, input.meetingId),
          isNull(meetingFiles.deletedAt)
        )
      )
      .limit(1);
    return row;
  },

  /**
   * Soft-delete ONE file, SCOPED TO ITS MEETING. Returns the stamped row, or `undefined`
   * when the id names no LIVE file OF THAT MEETING — a foreign `fileId` and an
   * already-deleted one are the SAME answer, so probing learns nothing.
   *
   * ⚠ SOFT-DELETE ONLY (D3). The row's `r2_key` stays permanently reserved by the
   * NON-partial `meeting_file_key_idx`, which is what makes a best-effort R2 delete safe to
   * fail: a retry can never collide with the key of a file that may still exist in R2.
   *
   * ⚠⚠ THIS IS HALF OF A DELETION, AND IT SHIPS WITH **NO PRODUCTION CALLER** (BAL-423 is
   * inert — D4). D3 defines deleting a meeting file as TWO acts: this row marker, PLUS the
   * PREFIX-GUARDED object delete `deleteMeetingFileFromR2` in
   * `apps/web/src/lib/storage/meeting-file.ts`. Only the row half lives here, because a
   * repository must not reach R2.
   *
   * ⚠ PAIRING THE TWO IS **BAL-132's OBLIGATION** — the ticket that adds the first caller.
   * Call this ALONE and the object is orphaned in R2 forever: invisible to every read, never
   * reclaimed, and its key permanently reserved by the non-partial unique so nothing can even
   * account for it later. The order is row-first (this returns the row, and therefore the
   * `r2Key`), then the best-effort object delete, which NEVER throws and never fails the row
   * operation. Do not add the R2 call here.
   */
  async softDelete(input: SoftDeleteMeetingFileInput): Promise<MeetingFile | undefined> {
    const [row] = await db
      .update(meetingFiles)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(meetingFiles.id, input.fileId),
          eq(meetingFiles.meetingId, input.meetingId),
          isNull(meetingFiles.deletedAt)
        )
      )
      .returning();
    return row;
  },
};
