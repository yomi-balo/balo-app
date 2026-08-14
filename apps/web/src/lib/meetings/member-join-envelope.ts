import { z } from 'zod';
import type { MeetingContextTypeWithHolder, MeetingViewerRole } from '@balo/shared/meetings';

/**
 * BAL-435 (rulings R6 + R10) — **THE MEMBER-JOIN RESPONSE ENVELOPE, PARSED AT THE SEAM.**
 *
 * ── ⚠⚠ WHY THIS EXISTS AT ALL ───────────────────────────────────────────────────────────────
 *
 * `join-api-client.ts` ends with `return { ok: true, data: parsed as T }` — an UNCHECKED CAST of
 * an external JSON body. `validateGrant` neutralises that for the grant's five fields, but R6 and
 * R10 put four more fields on the envelope BESIDE the grant, and those were consumed raw:
 * `context.type` went straight into a TOTAL lookup table with no `default:` arm, so an
 * unexpected value was `undefined(...)` — a `TypeError` on the join path, tripping the error
 * boundary and denying somebody their live call. The totality of that table is a COMPILE-TIME
 * property; this is the runtime half of it.
 *
 * ── ⚠⚠ EVERY FIELD DEGRADES INDEPENDENTLY, AND NOTHING HERE CAN FAIL A JOIN ─────────────────
 *
 * A malformed `context` must not cost the viewer their `viewerRole`, and a malformed anything
 * must not cost them the CALL — the grant is validated separately, at `MeetingCallSurface`, and
 * that is the check with the authority to refuse. So each field is parsed on its own and an
 * unparseable one becomes `null`, which is a LIVE path everywhere it appears: both guest mounts
 * legitimately have none of these.
 *
 * ⚠ PURE AND CLIENT-SAFE. No `server-only`, no `@balo/db`, no logging — it runs in the browser.
 */

/** ⚠ THE SIX HOLDER-BEARING LABELS. `admin` is structurally unreachable on a member join. */
const CONTEXT_TYPES = [
  'case',
  'project_discovery',
  'project_kickoff',
  'package_session',
  'retainer_checkin',
  'request_interaction',
] as const satisfies readonly MeetingContextTypeWithHolder[];

/**
 * ⚠ THE COMPILE-TIME HALF OF THE SAME GUARD. A SEVENTH holder-bearing label added to the shared
 * union fails `tsc` HERE — the array above would no longer cover it — rather than silently
 * becoming an unparseable value that degrades the whole envelope to `null` in production.
 */
type MissingContextType = Exclude<MeetingContextTypeWithHolder, (typeof CONTEXT_TYPES)[number]>;
type AssertNever<T extends never> = T;
export type AssertEnvelopeContextTypesComplete = AssertNever<MissingContextType>;

const contextSchema = z.object({
  type: z.enum(CONTEXT_TYPES),
  id: z.string().uuid(),
  /** ⚠ `null` IS A FIRST-CLASS ANSWER — three of the six shapes have no title column at all. */
  title: z.string().nullable().optional(),
});

const VIEWER_ROLES = ['client', 'expert'] as const satisfies readonly MeetingViewerRole[];

const viewerRoleSchema = z.enum(VIEWER_ROLES);

/** ⚠ AN INSTANT, VALIDATED AS ONE. A string that does not parse is not a start time. */
const scheduledStartSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)));

const counterpartySchema = z.string().trim().min(1);

export interface MemberJoinContextValue {
  readonly type: MeetingContextTypeWithHolder;
  readonly id: string;
  readonly title: string | null;
}

export interface MemberJoinEnvelope {
  /** The meeting's context — the heading and the "Back to {context}" destination. */
  readonly context: MemberJoinContextValue | null;
  /** ⚠ THE SERVER'S RESOLVED SIDE. Never a lens, never `activeMode`. */
  readonly viewerRole: MeetingViewerRole | null;
  /** The other party's name, or `null` ⇒ party-neutral waiting copy. */
  readonly counterpartyFirstName: string | null;
  /** ISO 8601, or `null`. ⚠ Formatted in the VIEWER's timezone, never on the server. */
  readonly scheduledStart: string | null;
}

/** Every field absent — what both guest mounts and any unparseable body resolve to. */
const EMPTY_ENVELOPE: MemberJoinEnvelope = {
  context: null,
  viewerRole: null,
  counterpartyFirstName: null,
  scheduledStart: null,
};

/** ⚠ `unknown` in, never a cast: this is the point downstream of `parsed as T`. */
function readField(raw: unknown, key: string): unknown {
  if (typeof raw !== 'object' || raw === null) return undefined;
  return (raw as Record<string, unknown>)[key];
}

function parseContext(raw: unknown): MemberJoinContextValue | null {
  const parsed = contextSchema.safeParse(raw);
  if (!parsed.success) return null;
  return { type: parsed.data.type, id: parsed.data.id, title: parsed.data.title ?? null };
}

/**
 * Read the four envelope fields, each degrading to `null` on its own.
 *
 * ⚠ IT NEVER THROWS AND IT NEVER REFUSES A CALL. See the module docblock.
 */
export function parseMemberJoinEnvelope(raw: unknown): MemberJoinEnvelope {
  if (typeof raw !== 'object' || raw === null) return EMPTY_ENVELOPE;

  const viewerRole = viewerRoleSchema.safeParse(readField(raw, 'viewerRole'));
  const counterparty = counterpartySchema.safeParse(readField(raw, 'counterpartyFirstName'));
  const scheduledStart = scheduledStartSchema.safeParse(readField(raw, 'scheduledStart'));

  return {
    context: parseContext(readField(raw, 'context')),
    viewerRole: viewerRole.success ? viewerRole.data : null,
    counterpartyFirstName: counterparty.success ? counterparty.data : null,
    scheduledStart: scheduledStart.success ? scheduledStart.data : null,
  };
}
