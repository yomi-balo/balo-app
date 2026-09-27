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
import {
  buildCaseClosedPayload,
  summariseCaseCloseAnchors,
  type CaseCloseAnchors,
} from '@balo/shared/engagements';
import { log } from '@/lib/logging';
import { sha256Hex } from '@/lib/magic-link';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import type { MeetingOrdinalInput } from '@/lib/meetings/derive-consultation-ordinal';

/**
 * BAL-572 — `capCaseTitle` / `CASE_TITLE_MAX` now live in `@balo/shared/engagements`
 * (`buildCaseClosedPayload` applies the cap itself), re-exported here so the two
 * `resolve-case.ts` callers, which still pre-cap `caseRow.title` before constructing
 * `PublishCaseClosedInput`, keep resolving the same import. The cap is idempotent
 * (`capCaseTitle(capCaseTitle(x)) === capCaseTitle(x)`), so a pre-capped title reaching
 * `buildCaseClosedPayload` a second time is a no-op, never a double ellipsis.
 */
export { capCaseTitle, CASE_TITLE_MAX } from '@balo/shared/engagements';

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
 * How many of this case's consultations were actually HELD, for
 * `engagement.case_closed.consultationCount`. ONE query for the whole sibling set — N+1 is
 * closed by construction. Degrades to 0 rather than throwing (see {@link readSiblings}).
 *
 * ⚠ THE RECAP ENTRY POINT'S READ, AND IT NEEDS ONLY THIS ONE FIGURE — it already HAS a meeting
 * in scope, so it never asks for a CTA anchor. The case surface, which needs both, uses
 * {@link readCloseAnchors} so the sibling set is still read exactly once.
 *
 * ⚠ BAL-572 — the derivation itself (held count + CTA anchor) now lives in
 * `summariseCaseCloseAnchors` (`@balo/shared/engagements`), ported from this file's own
 * `heldCountOf` / `mostRecentHeldIdOf` line for line so the api's inactivity sweep can share
 * it. This function's contract is unchanged.
 */
export async function readHeldConsultationCount(engagementId: string): Promise<number> {
  return summariseCaseCloseAnchors(await readSiblings(engagementId)).heldCount;
}

/**
 * Both figures a case-surface close needs, derived from ONE sibling read. Re-exported from
 * `@balo/shared/engagements` (BAL-572) — same shape, same import site for external callers.
 */
export type { CaseCloseAnchors };

/**
 * ⚠⚠ **ONE** `listMeetingsForContext` FOR THE WHOLE CLOSE, AND THAT IS WHY IT IS ONE FUNCTION
 * RATHER THAN TWO. The case surface needs the held COUNT and the CTA ANCHOR, both derived from
 * the same sibling set; two separate exported readers each called `readSiblings`, so a single
 * close issued the query TWICE while both docblocks claimed "ONE query for the whole sibling
 * set". The read happens here once and `summariseCaseCloseAnchors` (shared, BAL-572) runs the
 * two PURE derivations over its result.
 */
export async function readCloseAnchors(engagementId: string): Promise<CaseCloseAnchors> {
  return summariseCaseCloseAnchors(await readSiblings(engagementId));
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
 *
 * ⚠ BAL-572 — the ASSEMBLY (fallback strings, party label, title cap, date format,
 * correlation id) now lives in `buildCaseClosedPayload` (`@balo/shared/engagements`), shared
 * with the api's inactivity sweep. This function keeps its own reads (the RAW inputs
 * `buildCaseClosedPayload` needs) and its own transport — only the assembly moved.
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

  const payload = buildCaseClosedPayload({
    engagementId: input.engagementId,
    meetingId: input.meetingId,
    recipientId: input.recipientId,
    expertProfileId: input.expertProfileId,
    companyName: company?.name,
    expertProfileType: profile?.type,
    agencyName: agency?.name,
    expertFirstName: expertUser?.firstName,
    expertLastName: expertUser?.lastName,
    caseTitle: input.caseTitle,
    closedAt: input.closedAt,
    closeReason: 'resolved',
    consultationCount: input.consultationCount,
    reviewToken: input.reviewToken,
  });

  publishNotificationEvent('engagement.case_closed', payload).catch(() => {
    // publishNotificationEvent logs internally and never throws to the caller.
  });
}
