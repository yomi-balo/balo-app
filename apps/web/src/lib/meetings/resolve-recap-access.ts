import 'server-only';

import type { Meeting } from '@balo/db';
import type { PrimaryMeetingContext } from '@balo/shared/meetings';
import type { RecapLens } from '@balo/analytics/events';
import { authorizeMeetingFileAccess } from './authorize-meeting-file-access';
import { log } from '@/lib/logging';

/**
 * BAL-388 — THE RECAP READ GATE. A THIN LENS ADAPTER over the SHIPPED
 * `authorizeMeetingFileAccess`, not a second resolution chain.
 *
 * ⚠⚠ THE CHAIN IS NOT FORKED, AND THAT IS THE WHOLE POINT. "Who may read this meeting" is
 * defined ONCE, in `authorize-meeting-file-access.ts`: findById → listByMeeting →
 * `selectPrimaryMeetingContext` → `resolveMeetingContextOwner` → the membership/expert arms →
 * the request-grain decline gate. That module is UNTOUCHED by this ticket, and so is its
 * test. This file only RENAMES what it already returns.
 *
 * ⚠ THE GATE'S RESULT IS ALREADY LENS-SHAPED. It is action-NAMED, but its success payload
 * carries `side: 'client' | 'expert'` — resolved server-side from PARTY MEMBERSHIP against the
 * context's own owning row. So `lens = access.side` is a rename, not a re-derivation. The lens
 * is NEVER `users.activeMode` (a view toggle, never an authorization input — ADR-1029), never
 * a role comparison, and never anything taken from the URL or a request body.
 *
 * ⚠⚠ THIS IS THE **MEMBERSHIP/VISIBILITY** AXIS, AND THE ENGAGEMENT AXIS WOULD BE A CATEGORY
 * ERROR HERE. The recap is a READ surface. CLAUDE.md records that a `true` from
 * `hasEngagementCapability` "authorizes the ACT, never the READ", and the file gate's own
 * docblock §(a) already settled that a download is a read. The recap reads the SAME meeting
 * and the SAME files, plus artefacts — a strict superset of an already-settled read. This
 * module therefore does NOT open the `apps/web` engagement-axis seam; that still lands with
 * its first consumer (BAL-410 / BAL-411), and `engagement-capability-not-membership.test.ts`
 * stays green. A source-scan test pins the absence.
 *
 * ⚠ CROSS-TENANCY IS DISCHARGED INSIDE THE GATE, for a FIFTH caller.
 * `meeting_contexts.context_id` has NO FK and NO RLS, so the owning party is resolved from
 * the context's OWN row before any authorization. The recap inherits that and MUST NEVER
 * infer the owning party from the URL or re-resolve it downstream.
 *
 * ⚠⚠ ADMIN-CONTEXT MEETINGS RESOLVE TO `null` AND THE PAGE 404s — a DELIBERATE deviation from
 * the design spec's "admin renders a minimal shell", forced by the code:
 * `selectPrimaryMeetingContext` DROPS `admin` rows outright, so an admin-only meeting yields
 * `{ok:false, reason:'none'}` and the gate denies. The design's admin arm is structurally
 * UNREACHABLE. There is deliberately NO defensive `admin` branch anywhere in this feature: a
 * reserved label no code path can emit is a dead union member, and it reads as coverage that
 * does not exist. Admin meetings belong on the PLATFORM axis (ADR-1035), out of scope here.
 *
 * ⚠⚠ **THIS MODULE STILL REFUSES A GUEST VERDICT — DELIBERATELY, NOT BY OVERSIGHT.** BAL-445
 * filled `authorizeMeetingFileAccess`'s guest arm for meeting files and in-call chat, which
 * means this module's pass-through would otherwise open the MEMBER recap to a guest SILENTLY
 * — it has no independent gate of its own, only a rename over the file gate's answer. The gate
 * below is that explicit, documented refusal, and it stays: `RecapLens` is NOT widened to admit
 * `'guest'` (R5). **BAL-439 built the guest recap as a SIBLING, `resolve-guest-recap-access.ts`
 * (`lib/meetings/`), with its own view-model — never a fourth lens value on this one.** There is
 * still no guest lens on this surface; there is a different surface entirely.
 *
 * ⚠ `RecapLens` is NOT widened to admit `'guest'`. The type error `lens: access.side` would
 * raise on the guest arm (which carries no `side` — see `authorize-meeting-file-access.ts`)
 * is the natural compiler brake, and it is KEPT. The branch below is what satisfies the
 * compiler — but it is written as a gate with a log line, not a cast, precisely so a future
 * reader cannot silence it by widening the type.
 *
 * ⚠ IT ALSO CLOSES THE RECAP'S **MUTATION** PATH. `authorize-recap-case-mutation.ts` composes
 * this function, so a guest can no more resolve a case from the recap than read one.
 */

export interface RecapAccess {
  /** The viewer's resolved SIDE, renamed. Returned by the gate; never accepted as input. */
  lens: RecapLens;
  /** Threaded back so the loader never re-reads the meeting (nor can disagree with the gate). */
  meeting: Meeting;
  /** The PRIMARY context that governs this meeting. Never `admin` — see above. */
  subject: PrimaryMeetingContext;
  /** The company that owns the primary context. Always resolved, on BOTH sides. */
  companyId: string;
  /** `null` for a `match`-routed `project_discovery`, which names nobody. */
  expertProfileId: string | null;
}

/**
 * Resolve a viewer onto one side of a meeting, or `null`.
 *
 * ⚠ ONE `null` FOR EVERY DENIAL — missing, soft-deleted, unauthorised, declined, admin-only
 * and ambiguous all collapse into it, exactly as the underlying gate collapses them into one
 * `meeting_not_found` literal. The SHAPE goes to the gate's own `log.warn`; the caller answers
 * one `notFound()` with one copy, so the page is never an existence oracle.
 */
export async function resolveRecapAccess(
  meetingId: string,
  userId: string
): Promise<RecapAccess | null> {
  const access = await authorizeMeetingFileAccess({
    meetingId,
    actor: { kind: 'member', userId },
  });
  if (!access.ok) {
    return null;
  }

  /**
   * ⚠⚠ THE GUEST GATE — DELIBERATE, DOCUMENTED, AND **NOT** INHERITED FROM THE FILE ARM. See
   * the module docblock. `access.viewer !== 'member'` is unreachable IN PRACTICE given the
   * `actor: { kind: 'member' }` passed above — but `AuthorizeMeetingFileAccessResult`'s guest
   * `ok:true` arm is still part of the STATIC return type (TypeScript does not narrow a
   * function's return type by the literal value of its input), so `access.side` below would
   * not typecheck without this branch. That is the natural compiler brake, kept — and it is
   * written as a logged, explicit refusal rather than a cast, so a future reader cannot
   * silence it by widening `RecapLens`.
   */
  if (access.viewer !== 'member') {
    log.warn('Recap access refused for a guest subject', { meetingId, guestId: access.guestId });
    return null;
  }

  return {
    lens: access.side,
    meeting: access.meeting,
    subject: access.subject,
    companyId: access.companyId,
    expertProfileId: access.expertProfileId,
  };
}
