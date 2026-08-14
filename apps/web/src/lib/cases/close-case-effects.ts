import 'server-only';

import { randomBytes } from 'node:crypto';
import {
  agenciesRepository,
  companiesRepository,
  expertsRepository,
  meetingContextsRepository,
  reviewInviteTokensRepository,
  reviewsRepository,
  usersRepository,
} from '@balo/db';
import { expertPartyDisplayName } from '@balo/shared/parties';
import { formatLongUtc } from '@/lib/format/utc-date';
import { log } from '@/lib/logging';
import { sha256Hex } from '@/lib/magic-link';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import {
  deriveConsultationOrdinal,
  type MeetingOrdinalInput,
} from '@/lib/meetings/derive-consultation-ordinal';

/**
 * BAL-421 — THE POST-COMMIT HALF OF THE CASE-CLOSE CONTRACT, SHARED BY ITS TWO ENTRY POINTS:
 * BAL-388's recap (`meetings/[meetingId]/_actions/resolve-case.ts`) and this ticket's case
 * surface (`cases/[engagementId]/_actions/resolve-case.ts`).
 *
 * ⚠⚠ EXTRACTED, NOT INVENTED, AND THE EXTRACTION IS THE POINT. ~120 substantive lines would
 * otherwise have been COPIED into the second entry point — precisely the >3% new-code
 * duplication shape the SonarCloud gate exists to catch, and precisely the shape
 * `authorize-recap-case-mutation.ts` was itself extracted for. But duplication is the least
 * of it:
 *
 *   1. ONE DEFINITION OF A SECURITY RULE. `resolveReviewAsk` hashes through `sha256Hex` —
 *      THE SAME HELPER THE VERIFIER USES — and that `sha256Hex`-vs-re-inlined-`createHash`
 *      hole was closed once, on PR #191. A second copy of the mint is the exact mechanism by
 *      which it reopens: mint and verify must agree on the algorithm FOREVER, and a copy that
 *      drifted to sha512/base64 would keep every other test green while silently rendering a
 *      dead link for every emailed star row in production.
 *   2. THE HARDENED CATCH IS THE MOST COPY-FRAGILE CODE IN THE FILE. A reviewer copying it
 *      and "tidying" the catch back to `error.message` reintroduces token-hash logging into
 *      Axiom with NO visible defect anywhere.
 *
 * ⚠ `server-only`, NOT `'use server'` — it exports SYNC helpers and a type alongside its
 * async functions, and a `'use server'` module may export async functions only (memory
 * `reference_use_server_no_value_exports`; the failure surfaces in `next build`, not in tsc,
 * eslint or vitest). Same ruling as `authorize-recap-case-mutation.ts`.
 *
 * ⚠⚠ THE BEHAVIOUR-PRESERVATION PROOF. `resolve-case.test.ts` mocks `@balo/db` with a
 * FACTORY LITERAL naming exactly nine exports, and a vitest factory mock throws on any export
 * it omits. Everything imported above is already in that literal (or is mocked / side-effect
 * free), so **`resolve-case.test.ts` MUST PASS COMPLETELY UNCHANGED after this extraction. If
 * it needs a single edit, the extraction changed behaviour and must be redone.** That is the
 * proof, not a convenience — the same standard `packages/shared/src/meetings/context-owner.ts`
 * records for its own refactor.
 */

/**
 * `case_title` is an UNCAPPED `text` column, but the publish schema caps it at 200 and
 * `publishNotificationEvent` SWALLOWS a 400 — so a long title would silently mean no close
 * email at all. Truncating here is the difference between a slightly shortened subject line
 * and a missing email.
 */
export const CASE_TITLE_MAX = 200;

export function capCaseTitle(title: string): string {
  if (title.length <= CASE_TITLE_MAX) return title;
  return title.slice(0, CASE_TITLE_MAX - 1) + '…';
}

/**
 * A driver/Postgres error `code` (`23505`, `ECONNREFUSED`, …) when the thrown value carries one.
 * Enough to route a failure without quoting the statement — see `resolveReviewAsk`'s catch.
 */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

/**
 * BAL-390 (D-F) — what the close email should carry about rating: the RAW magic-link token
 * for the resolving member, or NOTHING at all.
 *
 * ⚠ NEVER THROWS, AND MUST NOT. The close has ALREADY COMMITTED by the time this runs. A
 * rating token is a nice-to-have riding along with a terminal state change, so every failure
 * degrades to a TOKENLESS publish and the close still succeeds.
 *
 * ⚠⚠ HASHING GOES THROUGH `sha256Hex` FROM `@/lib/magic-link` — the SAME helper the
 * VERIFIER uses — never a re-inlined `createHash`, and never the api-side
 * `mintReviewInviteToken` (a web Server Action must not reach for it). Mint and verify must
 * agree on the algorithm FOREVER: switching this line to sha512/base64 would keep every other
 * test green while silently rendering a dead link for every emailed star row in production.
 * The algorithm is pinned by a test, mirrored from `accept-project.test.ts`.
 *
 * ⚠⚠ THE RAW TOKEN IS RETURNED ONCE AND IS NEVER PERSISTED OR LOGGED, AND NEITHER IS THE
 * HASH — WHICH IS WHY THE CATCH BELOW LOGS `name` / `code` AND NOT `message` OR `stack`. The
 * failing statement's bound params INCLUDE the SHA-256 token hash, and drizzle-orm interpolates
 * bound params into `DrizzleQueryError.message` (from ~0.41) — which `stack` then repeats
 * verbatim. A routine dependency bump would otherwise start writing a live token hash into
 * Axiom with no code change here at all. The guard is deliberately scoped to THIS catch: every
 * other error path in the CALLING actions logs the full message and stack, because none of
 * them can carry a token as a bound param.
 */
export async function resolveReviewAsk(
  engagementId: string,
  expertProfileId: string,
  reviewerUserId: string
): Promise<string | undefined> {
  try {
    const existing = await reviewsRepository.findLive(
      engagementId,
      reviewerUserId,
      expertProfileId
    );
    if (existing !== undefined) {
      // Already rated ⇒ NO token ⇒ the template omits the review block ENTIRELY.
      return undefined;
    }
    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = sha256Hex(rawToken);
    await reviewInviteTokensRepository.create({ engagementId, reviewerUserId, tokenHash });
    return rawToken;
  } catch (error) {
    // Never the token itself, never the hash, and never anything that could quote them.
    log.error('Review invite token mint failed', {
      engagementId,
      userId: reviewerUserId,
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: errorCodeOf(error),
    });
    return undefined;
  }
}

/**
 * The case's consultation siblings, read ONCE, narrowed at the boundary.
 *
 * ⚠ NO MEETING ROW ESCAPES. `listMeetingsForContext` returns FULL `Meeting` rows including
 * `dailyRoomName` and `joinUrl`; they are narrowed to five fields here and never leave.
 *
 * ⚠ NEVER THROWS — it runs POST-COMMIT, so a failed read degrades the consultation count
 * rather than failing a close that has already happened.
 */
async function readSiblings(engagementId: string): Promise<readonly MeetingOrdinalInput[]> {
  const rows = await meetingContextsRepository
    .listMeetingsForContext('case', engagementId)
    .catch(() => []);
  return rows.map((row) => ({
    id: row.id,
    scheduledStart: row.scheduledStart,
    startedAt: row.startedAt,
    status: row.status,
    outcome: row.outcome,
  }));
}

/**
 * How many of this case's consultations were actually HELD — PURE, over an already-read
 * sibling set.
 *
 * `deriveConsultationOrdinal` needs a subject id for the ordinal; the count is
 * subject-independent, so an id that matches nothing is correct and honest here.
 */
function heldCountOf(siblings: readonly MeetingOrdinalInput[]): number {
  return deriveConsultationOrdinal(siblings, '').heldCount;
}

/**
 * The MOST RECENT HELD consultation, or `undefined` — PURE, over an already-read sibling set.
 *
 * ⚠ THE CTA ANCHOR FOR A CASE-SURFACE CLOSE, AND IT IS DELIBERATELY "MOST RECENT **HELD**"
 * RATHER THAN "MOST RECENT". `EngagementCaseClosedPayload.meetingId` is OPTIONAL and its
 * docblock states that when it is absent "the templates render NO link at all rather than a
 * dead one" — so `undefined` is a fully supported, documented outcome, and a case closed
 * before any consultation was held correctly emails no deep link. A cancelled or no-show
 * meeting would resolve to a recap that says the call never happened, which is a worse CTA
 * than none. NEVER fabricate an id.
 */
function mostRecentHeldIdOf(siblings: readonly MeetingOrdinalInput[]): string | undefined {
  const held = siblings
    .filter((meeting) => meeting.status === 'ended' && meeting.outcome === 'completed')
    .slice()
    .sort((a, b) => {
      const delta =
        (a.startedAt ?? a.scheduledStart).getTime() - (b.startedAt ?? b.scheduledStart).getTime();
      return delta !== 0 ? delta : a.id.localeCompare(b.id);
    });
  return held.at(-1)?.id;
}

/**
 * How many of this case's consultations were actually HELD, for
 * `engagement.case_closed.consultationCount`. ONE query for the whole sibling set — N+1 is
 * closed by construction. Degrades to 0 rather than throwing (see {@link readSiblings}).
 *
 * ⚠ THE RECAP ENTRY POINT'S READ, AND IT NEEDS ONLY THIS ONE FIGURE — it already HAS a meeting
 * in scope, so it never asks for a CTA anchor. The case surface, which needs both, uses
 * {@link readCloseAnchors} so the sibling set is still read exactly once.
 */
export async function readHeldConsultationCount(engagementId: string): Promise<number> {
  return heldCountOf(await readSiblings(engagementId));
}

/** Both figures a case-surface close needs, derived from ONE sibling read. */
export interface CaseCloseAnchors {
  heldCount: number;
  /** `undefined` ⇒ the templates render NO deep link. See {@link mostRecentHeldIdOf}. */
  anchorMeetingId: string | undefined;
}

/**
 * ⚠⚠ **ONE** `listMeetingsForContext` FOR THE WHOLE CLOSE, AND THAT IS WHY IT IS ONE FUNCTION
 * RATHER THAN TWO. The case surface needs the held COUNT and the CTA ANCHOR, both derived from
 * the same sibling set; two separate exported readers each called `readSiblings`, so a single
 * close issued the query TWICE while both docblocks claimed "ONE query for the whole sibling
 * set". The read happens here once and the two PURE derivations run over its result.
 */
export async function readCloseAnchors(engagementId: string): Promise<CaseCloseAnchors> {
  const siblings = await readSiblings(engagementId);
  return { heldCount: heldCountOf(siblings), anchorMeetingId: mostRecentHeldIdOf(siblings) };
}

export interface PublishCaseClosedInput {
  engagementId: string;
  /**
   * ⚠ OPTIONAL — the CTA subject on both channels, when there is one.
   *
   * The RECAP entry point always has one and keeps passing it, so shipped reviewed behaviour
   * is untouched. The CASE SURFACE has no meeting in scope and passes the most recent HELD
   * consultation, falling back to `undefined`.
   *
   * ⚠⚠ `EngagementCaseClosedPayload.meetingId` IS **ALREADY** OPTIONAL on the shared payload,
   * verified before this widening: its docblock states that when absent "the templates render
   * NO link at all rather than a dead one". So NO payload change, NO Zod change and NO template
   * change was needed or made. Do NOT widen the payload, and never pass a fabricated id.
   */
  meetingId: string | undefined;
  companyId: string;
  expertProfileId: string;
  caseTitle: string;
  closedAt: Date;
  recipientId: string;
  consultationCount: number;
  reviewToken: string | undefined;
}

/**
 * Publish `engagement.case_closed` — THE ONE PUBLISH. The event, its rule, its email and
 * in-app templates and its Zod publish arm ALL shipped in BAL-390 with NO publisher; this is
 * that publisher. Fire-and-forget by contract.
 *
 * ⚠ THE PAYLOAD SHAPE IS DECLARED ONCE, IN `@balo/shared/notifications`. Do NOT re-inline it
 * into the api or web lockstep catalogs — that is the SonarCloud duplication gate exact
 * shape (memory `reference_notification_event_dup_shared_home`).
 *
 * ⚠ THE READS ARE COLUMN-PROJECTED (`findNameById` / `findDisplayProfileById` /
 * `findDisplayById`) for the same reason the loaders use them: nothing here needs `rate_cents`,
 * `email` or `workosId`, and a payload is a place a stray column travels far.
 *
 * ⚠ `closeReason: resolved` IS THE HONEST REASON. Passing `auto_inactive` would make
 * BAL-390's +7d nudge assert that things went quiet about an action the client just took.
 */
export async function publishCaseClosed(input: PublishCaseClosedInput): Promise<void> {
  const [company, profile] = await Promise.all([
    companiesRepository.findNameById(input.companyId),
    expertsRepository.findDisplayProfileById(input.expertProfileId),
  ]);
  const [expertUser, agency] = await Promise.all([
    profile === undefined
      ? Promise.resolve(undefined)
      : usersRepository.findDisplayById(profile.userId),
    profile?.agencyId == null
      ? Promise.resolve(undefined)
      : agenciesRepository.getSummaryById(profile.agencyId),
  ]);

  publishNotificationEvent('engagement.case_closed', {
    correlationId: input.engagementId + ':case_closed',
    engagementId: input.engagementId,
    meetingId: input.meetingId,
    recipientId: input.recipientId,
    expertProfileId: input.expertProfileId,
    clientCompanyName: company?.name ?? 'your company',
    expertPartyLabel: expertPartyDisplayName({
      type: profile?.type ?? 'freelancer',
      agencyName: agency?.name ?? null,
      firstName: expertUser?.firstName ?? null,
      lastName: expertUser?.lastName ?? null,
    }),
    caseTitle: input.caseTitle,
    closedDate: formatLongUtc(input.closedAt),
    closeReason: 'resolved',
    consultationCount: input.consultationCount,
    reviewToken: input.reviewToken,
  }).catch(() => {
    // publishNotificationEvent logs internally and never throws to the caller.
  });
}
