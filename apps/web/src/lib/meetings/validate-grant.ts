import { z } from 'zod';
import { parseDailyParticipantId, type JoinGrant } from '@balo/shared/meetings';
import type { MeetingCallGrantRejectionReason } from '@balo/analytics/events';

/**
 * BAL-435 — **THE GRANT GATE. THE FIRST THING THAT HAPPENS, BEFORE THE VENDOR SDK EXISTS.**
 *
 * ⚠⚠ IT RUNS AT THE **SEAM**, INSIDE `MeetingCallSurface`, NOT AT THE THREE CALL SITES.
 * `join-api-client.ts` returns `parsed as T` — an unchecked cast — and that cast is UPSTREAM of
 * all three mounts. Two of those mounts (`/join/m/[meetingId]` and `/join/[token]`) are
 * ANONYMOUS PUBLIC ROUTES. A per-call-site check is three chances to forget, on the one surface
 * where forgetting hands an unvalidated URL straight to a vendor SDK. This module is the single
 * point downstream of all three.
 *
 * ⚠ PURE, CLIENT-SAFE, NO `server-only`, NO `@balo/db`. It runs in the browser by design.
 *
 * ⚠⚠ IT DOES **NOT** GATE ON AN EXPIRED `expiresAt`. `eject_at_token_exp` is FALSE: an expiring
 * token does not eject anyone, it only prevents a FRESH join. `expiresAt` is parsed for
 * VALIDITY and then never compared to `now`. Do not build a countdown that ends a call.
 */

/**
 * ⚠⚠ THE DECISION-1 ENCODING IS DEFINED **ONCE**, IN `@balo/shared/meetings`, AND THIS MODULE
 * CONSUMES THAT DEFINITION RATHER THAN RESTATING IT.
 *
 * A local `/^[ug][0-9a-f]{32}$/` shipped here first and was a second copy of
 * `PARTICIPANT_ID_PATTERN` — in a file that already imports from the very module that owns it.
 * The 33-hex fixtures this ticket had to fix in four test files are exactly the drift that
 * produces. `parseDailyParticipantId` is pure, dependency-free and client-safe, so there is no
 * cost to using it.
 */
function isParticipantId(value: string): boolean {
  return parseDailyParticipantId(value) !== null;
}

/**
 * ⚠⚠ PINNED TO **BALO's OWN DAILY DOMAIN** WHEN ONE IS CONFIGURED, not merely to the vendor.
 *
 * `*.daily.co` is a VENDOR-WIDE allow-list: any Daily customer can register a subdomain, so
 * `https://attacker.daily.co/r` passed it. Not reachable today (`meetings.join_url` is written
 * only from Daily's own create-room response for Balo's API key, and the room NAME is pinned to a
 * pure function of `meetings.id`) — but the room HOST was the one part of the venue nothing
 * pinned, and a poisoned `join_url` would hand a live Balo-minted JWT plus a camera and a
 * microphone to a third party's Daily domain.
 *
 * ⚠ THE SUFFIX RULE REMAINS THE FALLBACK when `NEXT_PUBLIC_DAILY_DOMAIN` is unset (local dev,
 * CI, and any environment that has not adopted the variable yet) — a tightening that turned into
 * an outage the day somebody forgot an env var would be a worse trade than the one it fixes.
 * ⚠ SUFFIX-ANCHORED **WITH** THE BARE APEX: a naive `endsWith('daily.co')` admits `evildaily.co`
 * and a naive `includes` admits `daily.co.attacker.example`. The dot in `.daily.co` is what makes
 * the subdomain arm safe; the explicit equality is what still admits the apex.
 *
 * ⚠ `process.env.NEXT_PUBLIC_*` IS READ AS A **STATIC PROPERTY ACCESS**, never through a computed
 * key — Next inlines it at build time only in that form.
 */
function isDailyHost(hostname: string): boolean {
  const pinned = process.env.NEXT_PUBLIC_DAILY_DOMAIN?.trim().toLowerCase() ?? '';
  if (pinned.length > 0) {
    return hostname === pinned;
  }
  return hostname === 'daily.co' || hostname.endsWith('.daily.co');
}

/**
 * ⚠ THE SHAPE ONLY. Every field is checked for the thing that would make it dangerous or
 * useless, and nothing is coerced: a grant is produced by our own api, so a value that does not
 * already match is a bug or an attack, never something to be helpfully repaired.
 */
const grantSchema = z.object({
  roomUrl: z.string().min(1),
  token: z.string().min(1),
  isOwner: z.boolean(),
  expiresAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  participantId: z.string().refine(isParticipantId),
  /**
   * BAL-134 / ADR-1049 (D3) — ⚠⚠ **A SIXTH FIELD, NEVER A WIDENING OF `isOwner`.**
   *
   * `isOwner` is the only input to the Daily `is_owner` token property, so widening it to
   * client principals would mint VENDOR-LEVEL owner tokens (eject, recording control) for the
   * paying side. The two booleans diverge the moment the viewer is a client principal, which
   * is the ordinary case on every client-booked consultation.
   *
   * ⚠⚠ **REQUIRED, NOT OPTIONAL, AND THAT IS THE WHOLE POINT OF THE SEPARATE FIELD.** An
   * optional field would let a guest arm silently omit it and default to "absent" at every
   * consumer — which is precisely the failure mode this design exists to prevent. Both guest
   * arms send an explicit `false`, hard-coded server-side exactly as `isOwner` is, so the
   * absence of the field is a BUG and this schema is where it is caught.
   */
  canEndMeeting: z.boolean(),
});

/**
 * WHICH CHECK FAILED — never the offending value.
 *
 * ⚠ THESE CODES ARE SAFE TO EMIT AS AN ANALYTICS PROPERTY **BY CONSTRUCTION**: each names a
 * rule, and none can carry a room URL or a JWT fragment.
 *
 * ⚠⚠ IT IS AN **ALIAS** OF THE ANALYTICS UNION, NOT A SECOND COPY OF IT. The two were declared
 * independently with a "Mirrors …" comment linking them, which is an acknowledgement rather than
 * a link: adding a seventh code on one side left the other green. `apps/web` depends on
 * `@balo/analytics`, never the reverse, so the package is the only direction the definition can
 * live in — and the import is TYPE-ONLY, so nothing is added to any bundle.
 */
export type GrantRejectionReason = MeetingCallGrantRejectionReason;

/**
 * A grant that has passed every check.
 *
 * ⚠⚠ IT IS **BRANDED**, AND `toJSON()` RETURNS `'[redacted]'`. A dozen components handle this
 * object; the branding stops one being handed a raw `JoinGrant` by accident, and the `toJSON`
 * means an accidental spread into a logger, a Sentry breadcrumb or a PostHog property yields a
 * literal string rather than a live credential. Cheap insurance, applied once.
 */
export interface ValidatedGrant extends JoinGrant {
  readonly __validated: true;
  toJSON(): string;
}

export type ValidateGrantResult =
  | { readonly ok: true; readonly grant: ValidatedGrant }
  | { readonly ok: false; readonly reason: GrantRejectionReason };

/** Map a Zod issue path onto the narrower code, so the analytics reason names the real rule. */
function reasonForIssuePaths(paths: readonly string[]): GrantRejectionReason {
  if (paths.includes('participantId')) return 'participant_id';
  if (paths.includes('expiresAt')) return 'expires_at';
  return 'shape';
}

function brand(grant: JoinGrant): ValidatedGrant {
  return {
    ...grant,
    __validated: true,
    // ⚠ NOT AN ARROW ASSIGNED TO A FIELD BY ACCIDENT — this is the real `toJSON` hook that
    // `JSON.stringify` calls, which is what redacts an accidental log of the whole object.
    toJSON(): string {
      return '[redacted]';
    },
  };
}

/**
 * Validate a join grant, or say which rule it broke.
 *
 * Order matters and is contract: shape first (so the URL checks always run on a string), then
 * parse, then scheme, then host.
 */
export function validateGrant(raw: unknown): ValidateGrantResult {
  const parsed = grantSchema.safeParse(raw);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => String(issue.path[0] ?? ''));
    return { ok: false, reason: reasonForIssuePaths(paths) };
  }

  let url: URL;
  try {
    url = new URL(parsed.data.roomUrl);
  } catch {
    // ⚠ NO DETAIL ESCAPES. The offending string is the thing we refuse to handle onward.
    return { ok: false, reason: 'url_parse' };
  }

  // ⚠ HTTPS ONLY, ASSERTED RATHER THAN ASSUMED. `javascript:` and `data:` both parse cleanly.
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'url_scheme' };
  }
  /*
    ⚠⚠ USERINFO IS REFUSED OUTRIGHT, EVEN ON AN OTHERWISE-VALID HOST. `https://x@sub.daily.co/r`
    already resolves to the right `hostname`, so the host check alone accepted it — and a
    credential-bearing URL handed to a vendor SDK is a shape nothing on this path has any reason
    to produce. `https://daily.co@evil.com/r` is caught by the host check (its `hostname` is
    `evil.com`); this closes the mirror image of that trick.
  */
  if (url.username.length > 0 || url.password.length > 0) {
    return { ok: false, reason: 'url_host' };
  }
  if (!isDailyHost(url.hostname)) {
    return { ok: false, reason: 'url_host' };
  }

  return { ok: true, grant: brand(parsed.data) };
}
