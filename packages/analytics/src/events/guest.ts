/**
 * BAL-408 / ADR-1044 — guest participation analytics.
 *
 * SERVER-ONLY. Every producer is a server surface: the `apps/api` invite / remove /
 * admit / deny routes, plus the `apps/web` `/join/[token]` landing, which is an RSC. They
 * MUST NOT be added to `AllEvents` (the client union) nor to the
 * `apps/web/src/test/setup.ts` client `vi.mock('@/lib/analytics')` export list — that mock
 * is client-only, and adding a server constant to it would be misleading rather than merely
 * redundant. The `REVIEW_SERVER_EVENTS` / `MEETING_SERVER_EVENTS` precedent.
 *
 * ⚠ REGISTRATION IS FOUR FILES, NOT THREE. CLAUDE.md's checklist omits
 * `packages/analytics/src/server/index.ts`, and `apps/api` imports from
 * `@balo/analytics/server` ONLY — so skipping that re-export leaves these constants
 * unimportable from the app that emits most of them, and the failure lands in `apps/api`'s
 * typecheck rather than here (`@balo/analytics` has no typecheck and no test script of its
 * own; its co-located guard tests run via `npx vitest run packages/analytics`).
 *
 * ⚠⚠ NO EMAIL ADDRESSES, NO DOMAINS, NO NAMES, NO TOKENS — EVER. The whole feature is about
 * external people, so the temptation is real and the rule is absolute. `same_domain` is the
 * derived boolean that answers the product question ("did the scope widen because they are
 * a colleague?") without recording anything about the address; the `share.ts` precedent
 * records the domain itself, and this deliberately records less.
 *
 * ⚠ `guest_invite_opened`'s `distinct_id` IS `meeting_guests.id`, NOT A USER ID — a guest
 * has none. It is a stable pseudonymous handle that becomes joinable to a real person only
 * if BAL-345's (currently inert) domain auto-join ever writes `converted_to_user_id`.
 *
 * ⚠ TWO EVENTS ARE DELIBERATELY **NOT** DECLARED HERE, because an analytics constant with
 * no producer is a FALSE PostHog signal — a funnel step that can never fire reads as 100%
 * drop-off, and the exact-key-set guard below would pin it forever:
 *   · `guest_joined` `{ party, join_method: 'magic_link' | 'link_share', admitted }`
 *     → **BAL-132**. Nothing can join: `@daily-co/daily-js` is not a dependency of any
 *     package, and no `pending` admission row is ever produced.
 *   · `guest_converted_to_member` `{ days_since_meeting }` → **BAL-345**, whichever ticket
 *     makes domain auto-join live. Nothing writes `converted_to_user_id`.
 * Both shapes are written out above so those tickets add them verbatim.
 */
import type {
  GuestAccessScopeLabel,
  MeetingContextTypeLabel,
  MeetingGuestSide,
  MeetingParticipationRoleLabel,
} from '@balo/shared/meetings';

export const GUEST_SERVER_EVENTS = {
  /** A host admitted a waiting guest. ⚠ INERT until BAL-132 produces a `pending` row. */
  GUEST_ADMITTED: 'guest_admitted',
  /** A host denied a waiting guest. ⚠ INERT for the same reason. */
  GUEST_DENIED: 'guest_denied',
  /** The `/join/{token}` landing resolved a LIVE token and rendered. */
  GUEST_INVITE_OPENED: 'guest_invite_opened',
  /** One guest row committed. Emitted once PER GUEST, not once per batch. */
  GUEST_INVITED: 'guest_invited',
  /** A guest's access was revoked. */
  GUEST_REMOVED: 'guest_removed',
} as const;

/**
 * WHERE the invite was composed. ⚠ THE FIELD THIS WHOLE EVENT SET EXISTS TO MEASURE, and
 * the only part of the invite contract that differs between the three consuming surfaces
 * (BAL-400 booking confirm, BAL-421 case surface, BAL-132 in-call). Required on the wire.
 */
export type GuestInviteEntryPoint = 'booking_confirm' | 'case_surface' | 'in_call';

export interface GuestServerEventMap {
  [GUEST_SERVER_EVENTS.GUEST_INVITED]: {
    entry_point: GuestInviteEntryPoint;
    /** SERVER-DERIVED from the actor's resolved side — never what the client claimed. */
    party: MeetingGuestSide;
    participation_role: MeetingParticipationRoleLabel;
    access_scope: GuestAccessScopeLabel;
    /**
     * Whether the address matched one of the client company's registered `party_domains`
     * — i.e. WHY the scope came out as it did. ⚠ A BOOLEAN, never the domain.
     */
    same_domain: boolean;
    /** The PRIMARY context's type (the D3 precedence winner). */
    context_type: MeetingContextTypeLabel;
    /** The INVITER's user id. */
    distinct_id: string;
  };
  [GUEST_SERVER_EVENTS.GUEST_REMOVED]: {
    party: MeetingGuestSide;
    access_scope: GuestAccessScopeLabel;
    /** Whether the guest had ever opened their link — did revocation actually take anything away? */
    had_joined: boolean;
    /** The REMOVER's user id. */
    distinct_id: string;
  };
  [GUEST_SERVER_EVENTS.GUEST_ADMITTED]: {
    party: MeetingGuestSide;
    /** The HOST's user id. */
    distinct_id: string;
  };
  [GUEST_SERVER_EVENTS.GUEST_DENIED]: {
    party: MeetingGuestSide;
    /** The HOST's user id. */
    distinct_id: string;
  };
  [GUEST_SERVER_EVENTS.GUEST_INVITE_OPENED]: {
    party: MeetingGuestSide;
    access_scope: GuestAccessScopeLabel;
    /** `true` on the first ever open — `access_count` was 0 before this request. */
    first_open: boolean;
    /** ⚠ `meeting_guests.id` — a guest has NO user id. See the module docblock. */
    distinct_id: string;
  };
}
