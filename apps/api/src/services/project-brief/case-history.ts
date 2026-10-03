import {
  conversationsRepository,
  meetingContextsRepository,
  partyMembershipsRepository,
  transcriptArtifactsRepository,
  transcriptsRepository,
} from '@balo/db';
import { htmlToPlainText } from '@balo/shared/notifications';
import { CASE_HISTORY_MAX_TRANSCRIPTS } from './config.js';

/**
 * case-history (BAL-589) — THE FEE-CONCEALMENT BOUNDARY for the case→project brief path.
 *
 * ⚠⚠ THIS MODULE IS THE INPUT BUILDER THE INVARIANT `case-brief-input-carries-no-money.test.ts`
 * PINS. It reads ONLY conversation message bodies and meeting transcript text — never a credit
 * session, a rate, a fee, a currency, or a duration. `buildCaseHistoryInput`'s projection is
 * total: every row this module reads is narrowed to exactly the fields in
 * {@link CaseHistoryMessage} / {@link CaseHistoryTranscript} before it ever reaches the prompt,
 * so a vendor row carrying extra money-ish columns cannot leak through by accident.
 *
 * It never calls `consultationTimestampsForEngagements`, and never touches `credit*`,
 * `expert_profiles`, a rate, a fee, or a currency. `partyMembershipsRepository.getMemberRole`
 * is the one exception worth calling out explicitly: it resolves a sender's company
 * MEMBERSHIP (for the `author` label), never a money surface.
 */

/** One case conversation message, narrowed to what the brief prompt may read. */
export interface CaseHistoryMessage {
  readonly author: 'client' | 'expert' | 'participant';
  readonly sentAt: Date;
  readonly text: string;
}

/** One case meeting's transcript material, narrowed the same way. */
export interface CaseHistoryTranscript {
  readonly heldAt: Date;
  readonly source: 'summary' | 'transcript';
  readonly text: string;
}

/** The complete, narrowed case-history input `renderCaseHistory` renders from. */
export interface CaseHistoryInput {
  readonly messages: CaseHistoryMessage[];
  readonly transcripts: CaseHistoryTranscript[];
}

/**
 * A sender's `author` label for one case conversation message: `expertUserIds` decides
 * `'expert'`; a sender who is a LIVE member of the case's company is `'client'`; every other
 * sender — the expert's agency colleagues, a departed client member or delegate, a Balo staff
 * account dropping a note, or anyone else with no live membership on either side — is
 * `'participant'`. Deliberately NOT `'balo'`: that bucket also catches non-staff senders, and
 * labelling their text "Balo:" would read as staff authority to the model.
 */
function resolveAuthor(
  senderUserId: string,
  expertUserIds: ReadonlySet<string>,
  clientUserIds: ReadonlySet<string>
): CaseHistoryMessage['author'] {
  if (expertUserIds.has(senderUserId)) return 'expert';
  if (clientUserIds.has(senderUserId)) return 'client';
  return 'participant';
}

/**
 * The non-expert senders among `senderUserIds` who are LIVE members of `companyId`, resolved
 * through the existing `partyMembershipsRepository.getMemberRole` seam (no new repository
 * method) — a defined role means a live membership, `undefined` means none.
 */
async function resolveClientUserIds(
  companyId: string,
  senderUserIds: ReadonlySet<string>
): Promise<ReadonlySet<string>> {
  const resolved = await Promise.all(
    [...senderUserIds].map(async (userId) => {
      const role = await partyMembershipsRepository.getMemberRole('company', companyId, userId);
      return { userId, isLiveMember: role !== undefined };
    })
  );
  return new Set(resolved.filter((entry) => entry.isLiveMember).map((entry) => entry.userId));
}

/**
 * The case's live conversation messages, narrowed to `author` / `sentAt` / `text`. Each body is
 * sanitised HTML (`schema/conversations.ts`), so it is decoded to plain text with
 * `htmlToPlainText` before it is narrowed into the output — otherwise every tag would reach the
 * prompt as literal markup noise once `escapeCaseAngleBrackets` (`prompts.ts`) escapes its
 * angle brackets.
 *
 * The context type is `'engagement'`, never `'case'` (the case surface's own
 * `resolve-case-access.ts` reads the same anchor).
 */
async function buildMessages(
  engagementId: string,
  companyId: string,
  expertUserIds: ReadonlySet<string>
): Promise<CaseHistoryMessage[]> {
  const conversation = await conversationsRepository.findByContext({
    contextType: 'engagement',
    contextId: engagementId,
  });
  if (conversation === undefined) {
    return [];
  }

  const rows = await conversationsRepository.listMessages(conversation.id, { kind: 'full' });
  const nonExpertSenderIds = new Set(
    rows.map((row) => row.senderUserId).filter((senderUserId) => !expertUserIds.has(senderUserId))
  );
  const clientUserIds = await resolveClientUserIds(companyId, nonExpertSenderIds);

  return rows.map((row) => ({
    author: resolveAuthor(row.senderUserId, expertUserIds, clientUserIds),
    sentAt: row.createdAt,
    text: htmlToPlainText(row.body),
  }));
}

/**
 * One meeting's narrowed transcript line, or `undefined` if it has neither a non-empty summary
 * nor a non-empty canonical transcript. Split out of {@link buildTranscripts} so
 * the newest ≤ {@link CASE_HISTORY_MAX_TRANSCRIPTS} meetings resolve concurrently via
 * `Promise.all` instead of one `await` per loop iteration.
 */
async function buildTranscriptLine(
  meeting: { id: string; scheduledStart: Date },
  ref: { id: string } | undefined
): Promise<CaseHistoryTranscript | undefined> {
  if (ref === undefined) return undefined;

  const summary = await transcriptArtifactsRepository.findByTranscriptAndKind(ref.id, 'summary');
  if (summary !== undefined) {
    if (summary.content.trim().length === 0) return undefined;
    return { heldAt: meeting.scheduledStart, source: 'summary', text: summary.content };
  }

  const transcript = await transcriptsRepository.findById(ref.id);
  if (transcript === undefined) return undefined;
  const text = transcript.canonical.segments.map((segment) => segment.text).join(' ');
  if (text.trim().length === 0) return undefined;
  return { heldAt: meeting.scheduledStart, source: 'transcript', text };
}

/**
 * The case's newest {@link CASE_HISTORY_MAX_TRANSCRIPTS} meetings' transcript text, narrowed to
 * `heldAt` / `source` / `text`. `scheduledStart` is read for ORDERING ONLY — it is never part
 * of the narrowed shape. For each meeting's transcript, the `summary` artifact is preferred;
 * absent one, the canonical segment text is joined instead. `durationMs`, `startMs` and
 * `endMs` are never read.
 *
 * ⚠ `findByMeetingIds` is called for EVERY meeting on the case, not just the newest
 * {@link CASE_HISTORY_MAX_TRANSCRIPTS} — it is a cheap ids-and-status lookup, and slicing to the
 * newest N BEFORE knowing which meetings actually have a transcript ref would let newer,
 * transcript-less meetings crowd an older one with real content out of the window entirely. The
 * newest-N cut happens AFTER filtering to meetings that have a ref.
 *
 * ⚠ The per-meeting reads run via `Promise.all`, not an `await` inside the loop.
 * `Promise.all` preserves input order in its resolved array regardless of resolution order, so
 * the newest-first ordering `renderCaseHistory` relies on survives unchanged.
 */
async function buildTranscripts(engagementId: string): Promise<CaseHistoryTranscript[]> {
  const meetings = await meetingContextsRepository.listMeetingsForContext('case', engagementId);
  if (meetings.length === 0) {
    return [];
  }

  const refsByMeetingId = await transcriptsRepository.findByMeetingIds(
    meetings.map((meeting) => meeting.id)
  );

  const newest = meetings
    .filter((meeting) => refsByMeetingId.has(meeting.id))
    .sort((a, b) => b.scheduledStart.getTime() - a.scheduledStart.getTime())
    .slice(0, CASE_HISTORY_MAX_TRANSCRIPTS);

  const lines = await Promise.all(
    newest.map((meeting) => buildTranscriptLine(meeting, refsByMeetingId.get(meeting.id)))
  );
  return lines.filter((line): line is CaseHistoryTranscript => line !== undefined);
}

/**
 * Build the narrowed case-history input for one case's project brief. PURE from the caller's
 * perspective — every field is read-only data, narrowed before it leaves this function.
 *
 * `companyId` is the case's own company — it never resolves anything money-shaped, only which
 * non-expert senders are live members of that company (so they are labelled `'client'` rather
 * than `'participant'`).
 */
export async function buildCaseHistoryInput(input: {
  engagementId: string;
  companyId: string;
  expertUserIds: readonly string[];
}): Promise<CaseHistoryInput> {
  const expertUserIds = new Set(input.expertUserIds);
  const [messages, transcripts] = await Promise.all([
    buildMessages(input.engagementId, input.companyId, expertUserIds),
    buildTranscripts(input.engagementId),
  ]);
  return { messages, transcripts };
}

/** One renderable line, carrying its own clock for the newest-first fill. */
interface HistoryLine {
  readonly at: Date;
  readonly text: string;
}

function formatDay(at: Date): string {
  const iso = at.toISOString();
  return iso.slice(0, 10);
}

/** The rendered label for a message's `author`. */
function authorLabel(author: CaseHistoryMessage['author']): string {
  if (author === 'expert') return 'Expert';
  if (author === 'client') return 'Client';
  return 'Participant';
}

function messageLine(message: CaseHistoryMessage): HistoryLine {
  const who = authorLabel(message.author);
  return { at: message.sentAt, text: `[${formatDay(message.sentAt)}] ${who}: ${message.text}` };
}

/** The rendered label for a transcript's `source` — a raw transcript is never a "summary". */
function transcriptLabel(source: CaseHistoryTranscript['source']): string {
  return source === 'summary' ? 'Call summary' : 'Call transcript';
}

function transcriptLine(transcript: CaseHistoryTranscript): HistoryLine {
  return {
    at: transcript.heldAt,
    text: `[${formatDay(transcript.heldAt)}] ${transcriptLabel(transcript.source)}: ${transcript.text}`,
  };
}

const TRUNCATION_MARKER = '[Earlier case history omitted]';

/**
 * Render {@link CaseHistoryInput} into the prompt's `<case-history>` text, newest-first up to
 * `maxChars`, then flipped back to chronological order for the model. An oversize NEWEST line
 * is trimmed to fit rather than dropped outright, so the most recent material always survives
 * in some form.
 */
export function renderCaseHistory(
  input: CaseHistoryInput,
  maxChars: number
): { text: string; truncated: boolean } {
  const lines = [...input.messages.map(messageLine), ...input.transcripts.map(transcriptLine)].sort(
    (a, b) => b.at.getTime() - a.at.getTime()
  );

  const [newest, ...rest] = lines;
  if (newest === undefined) {
    return { text: '', truncated: false };
  }

  const kept: string[] = [];
  let truncated = false;

  if (newest.text.length > maxChars) {
    kept.push(newest.text.slice(0, maxChars));
    truncated = rest.length > 0;
  } else {
    kept.push(newest.text);
    let used = newest.text.length;
    for (const line of rest) {
      const next = used + 1 + line.text.length;
      if (next > maxChars) {
        truncated = true;
        break;
      }
      kept.push(line.text);
      used = next;
    }
  }

  const chronological = [...kept].reverse();
  const body = chronological.join('\n');
  return { text: truncated ? `${TRUNCATION_MARKER}\n${body}` : body, truncated };
}
