import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Comments are stripped first, so the docblocks that EXPLAIN these absences do not trip
// the scans below. ONE shared indexOf-scan implementation (no regex ⇒ no ReDoS surface,
// and no second copy to drift) — see `@balo/shared/testing`'s own docblock.
import { stripComments } from '../testing/strip-comments';
import {
  ENGAGEMENT_CAPABILITIES,
  ENGAGEMENT_ROLE_CAPABILITIES,
  HOST_ROLES,
  hostContextGrants,
  hostRoleHasCapability,
  resolveHostRole,
  type EngagementCapability,
  type HostContext,
  type HostRole,
} from './engagement';

/**
 * Unit tests for the ENGAGEMENT-capability axis pure core (BAL-413 / ADR-1046).
 *
 * Pure map + pure derivation — mocks nothing, touches no DB. Authorization logic is
 * the "ALWAYS test" category: every allow branch and every deny branch is pinned here
 * so a host role can never silently gain or lose a token, and so the deny branches
 * that exclude clients, delegates, guests and agency `expert`s cannot quietly widen.
 *
 * ⚠ The per-arm context ASSEMBLY (which row names which expert) is NOT tested here —
 * it has no home in a pure module. It lives in
 * `apps/api/src/services/meetings/authorize-engagement-host.test.ts`.
 */

const EXPERT_USER = 'user_expert_1';
const AGENCY_ID = 'agency_1';
const OTHER_USER = 'user_other';

const ALL_TOKENS: readonly EngagementCapability[] = Object.values(ENGAGEMENT_CAPABILITIES);

/**
 * Agency-based expert whose agency membership row for `resolvedForActorId` carries
 * `actorRole`.
 *
 * ⚠ `resolvedForActorId` IS A REQUIRED PARAMETER ON PURPOSE, not defaulted. A default
 * would let a test silently build a context for the wrong actor and re-normalise exactly
 * the confused-deputy bug this brand exists to close — the same way these helpers did
 * before BAL-413's security fix. Every caller must say whose context this is.
 */
function agencyContext(actorRole: string | null, resolvedForActorId: string): HostContext {
  return {
    resolvedForActorId,
    expertUserId: EXPERT_USER,
    agency: { agencyId: AGENCY_ID, actorRole },
  };
}

/** Independent expert — `agency: null` means NO agency lookup was ever performed. */
function independentContext(resolvedForActorId: string): HostContext {
  return { resolvedForActorId, expertUserId: EXPERT_USER, agency: null };
}

// ── resolveHostRole ──────────────────────────────────────────────────────────

describe('resolveHostRole', () => {
  it('resolves the DELIVERING EXPERT when the actor is that expert (AC #3)', () => {
    expect(resolveHostRole(independentContext(EXPERT_USER), { id: EXPERT_USER })).toBe(
      HOST_ROLES.DELIVERING_EXPERT
    );
  });

  it('resolves delivering_expert BEFORE any agency consideration (AC #3)', () => {
    // The expert is themselves a non-admin member of their own agency. Identity wins:
    // the agency branch is never reached, so their agency role cannot demote them.
    expect(resolveHostRole(agencyContext('expert', EXPERT_USER), { id: EXPERT_USER })).toBe(
      HOST_ROLES.DELIVERING_EXPERT
    );
  });

  it('resolves AGENCY_ADMIN for an agency owner (AC #3)', () => {
    expect(resolveHostRole(agencyContext('owner', OTHER_USER), { id: OTHER_USER })).toBe(
      HOST_ROLES.AGENCY_ADMIN
    );
  });

  it('resolves AGENCY_ADMIN for an agency admin (AC #3)', () => {
    expect(resolveHostRole(agencyContext('admin', OTHER_USER), { id: OTHER_USER })).toBe(
      HOST_ROLES.AGENCY_ADMIN
    );
  });

  it('resolves NULL for agency role `expert` — the base bundle has no MANAGE_MEMBERS (AC #4)', () => {
    expect(
      resolveHostRole(agencyContext('expert', 'user_colleague'), { id: 'user_colleague' })
    ).toBeNull();
  });

  it('resolves NULL for role `member` — a company base role never grants on this axis (AC #4)', () => {
    expect(
      resolveHostRole(agencyContext('member', 'user_colleague'), { id: 'user_colleague' })
    ).toBeNull();
  });

  it('resolves NULL for an unknown / empty role string (fail closed)', () => {
    expect(resolveHostRole(agencyContext('finance', OTHER_USER), { id: OTHER_USER })).toBeNull();
    expect(resolveHostRole(agencyContext('', OTHER_USER), { id: OTHER_USER })).toBeNull();
  });

  it('resolves NULL when actorRole is null — the one branch that excludes every client-side actor, delegate and guest (AC #5)', () => {
    // A company `owner` DOES hold MANAGE_MEMBERS — but their role was looked up in the
    // DELIVERING expert's agency, where they have no live row, so `actorRole` is null
    // and their company role is never consulted.
    expect(
      resolveHostRole(agencyContext(null, 'user_client_owner'), { id: 'user_client_owner' })
    ).toBeNull();
  });

  it('resolves NULL for an independent expert when the actor is someone else (AC #6)', () => {
    expect(resolveHostRole(independentContext(OTHER_USER), { id: OTHER_USER })).toBeNull();
  });

  it('resolves NULL for a NULL host context — a no-holder subject (AC #8)', () => {
    expect(resolveHostRole(null, { id: EXPERT_USER })).toBeNull();
    expect(resolveHostRole(null, { id: OTHER_USER })).toBeNull();
  });
});

// ── The confused-deputy guard: a context is an answer about ONE actor ────────

describe('resolveHostRole — cross-actor reuse is denied (BAL-413 security fix)', () => {
  /**
   * THE ATTACK THIS CLOSES. `HostContext.agency.actorRole` is resolved FOR ONE ACTOR, but
   * `resolveHostRole` / `hostContextGrants` take `actor` as a SEPARATE parameter. Without
   * the `resolvedForActorId` brand, the natural resolve-once / check-many shape —
   *
   *   const ctx = await resolveHostContext(subject, agencyOwnerId);  // actorRole: 'owner'
   *   hostContextGrants(ctx, { id: attackerId }, 'host_meetings');   // → true
   *
   * — hands the owner's AGENCY_ADMIN role to every other actor checked against the same
   * context. That is the LIKELY first misuse, not a contrived one: "resolve the meeting's
   * host context, then check each participant" is exactly how BAL-132's admit/deny surface
   * wants to consume this, and `resolveHostContext` is exported to encourage reading the
   * identity out of it.
   *
   * ⚠ The check must sit ABOVE the delivering-expert comparison, or the FIRST case below
   * would still pass: an attacker who happens to BE the delivering expert of some other
   * meeting would otherwise be granted through the identity branch on a context resolved
   * for somebody else entirely.
   */
  it('denies an attacker reusing an agency OWNER’s context — the escalation path', () => {
    const ownersContext = agencyContext('owner', 'user_agency_owner');
    expect(resolveHostRole(ownersContext, { id: 'user_agency_owner' })).toBe(
      HOST_ROLES.AGENCY_ADMIN
    );
    expect(resolveHostRole(ownersContext, { id: 'user_attacker' })).toBeNull();
  });

  it('denies reuse on the DELIVERING-EXPERT path too — the brand is checked first', () => {
    // The context names EXPERT_USER as the delivering expert, so the identity branch
    // WOULD fire for them — but it was resolved for somebody else, so it never gets there.
    const strangersContext = agencyContext(null, 'user_stranger');
    expect(resolveHostRole(strangersContext, { id: EXPERT_USER })).toBeNull();
    expect(resolveHostRole(independentContext('user_stranger'), { id: EXPERT_USER })).toBeNull();
  });

  it('denies BOTH tokens on BOTH paths when a context is reused across actors', () => {
    const reusedContexts: readonly HostContext[] = [
      agencyContext('owner', 'user_agency_owner'), // agency-admin path
      agencyContext('admin', 'user_agency_admin'), // agency-admin path
      independentContext(EXPERT_USER), // delivering-expert path
      agencyContext('expert', EXPERT_USER), // delivering-expert path, agency-based
    ];
    for (const context of reusedContexts) {
      for (const token of ALL_TOKENS) {
        expect(hostContextGrants(context, { id: 'user_attacker' }, token)).toBe(false);
      }
    }
  });

  it('still GRANTS when the context is used for the actor it was resolved for (non-vacuity)', () => {
    // Guards the guard: without this, the four denials above would also pass if the brand
    // check denied unconditionally.
    for (const token of ALL_TOKENS) {
      expect(
        hostContextGrants(
          agencyContext('owner', 'user_agency_owner'),
          { id: 'user_agency_owner' },
          token
        )
      ).toBe(true);
      expect(hostContextGrants(independentContext(EXPERT_USER), { id: EXPERT_USER }, token)).toBe(
        true
      );
    }
  });
});

// ── hostRoleHasCapability ────────────────────────────────────────────────────

describe('hostRoleHasCapability', () => {
  it('grants host_meetings to the delivering expert (AC #3)', () => {
    expect(
      hostRoleHasCapability(HOST_ROLES.DELIVERING_EXPERT, ENGAGEMENT_CAPABILITIES.HOST_MEETINGS)
    ).toBe(true);
  });

  it('grants manage_engagement to the delivering expert — the SECOND token, same holder (AC #3)', () => {
    expect(
      hostRoleHasCapability(HOST_ROLES.DELIVERING_EXPERT, ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT)
    ).toBe(true);
  });

  it('grants BOTH tokens to an agency admin (AC #3)', () => {
    for (const token of ALL_TOKENS) {
      expect(hostRoleHasCapability(HOST_ROLES.AGENCY_ADMIN, token)).toBe(true);
    }
  });

  it('grants nothing to an unrecognised host role (fail closed)', () => {
    for (const token of ALL_TOKENS) {
      // A role string that is not in the map — the runtime shape of a future
      // mis-wired caller. Cast is confined to this fail-closed assertion.
      expect(hostRoleHasCapability('spectator' as HostRole, token)).toBe(false);
    }
  });
});

// ── hostContextGrants (the composition every resolver ends in) ───────────────

describe('hostContextGrants', () => {
  it('grants BOTH tokens to the delivering expert', () => {
    for (const token of ALL_TOKENS) {
      expect(hostContextGrants(independentContext(EXPERT_USER), { id: EXPERT_USER }, token)).toBe(
        true
      );
    }
  });

  it('grants BOTH tokens to an agency owner and an agency admin', () => {
    for (const role of ['owner', 'admin']) {
      for (const token of ALL_TOKENS) {
        // Resolved FOR this actor — see the cross-actor block above for what happens when
        // a context resolved for somebody else is reused here.
        expect(hostContextGrants(agencyContext(role, OTHER_USER), { id: OTHER_USER }, token)).toBe(
          true
        );
      }
    }
  });

  it('is FALSE for BOTH tokens when the host role is null (AC #5, AC #8)', () => {
    // Every context here is resolved FOR `OTHER_USER`, so each denial is attributable to
    // the branch it names rather than to the cross-actor brand.
    const nonHolderContexts: readonly [string, HostContext | null][] = [
      ['null context (match-routed discovery / admin / declined)', null],
      ['independent expert, different actor', independentContext(OTHER_USER)],
      ['non-member of the delivering agency', agencyContext(null, OTHER_USER)],
      ['agency role expert', agencyContext('expert', OTHER_USER)],
      ['company base role member', agencyContext('member', OTHER_USER)],
    ];

    for (const [, context] of nonHolderContexts) {
      for (const token of ALL_TOKENS) {
        expect(hostContextGrants(context, { id: OTHER_USER }, token)).toBe(false);
      }
    }
  });
});

// ── The one-holder-set invariant (AC #12) ────────────────────────────────────

describe('ENGAGEMENT_ROLE_CAPABILITIES', () => {
  it('maps each token to its snake_case wire value', () => {
    expect(ENGAGEMENT_CAPABILITIES.HOST_MEETINGS).toBe('host_meetings');
    expect(ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT).toBe('manage_engagement');
  });

  it('gives delivering_expert and agency_admin the IDENTICAL holder bundle (AC #12)', () => {
    // Pins the ADR-1046 2026-07-31 amendment. If the holder sets ever diverge they
    // diverge HERE, in the map — never by a second resolver — and this is the test a
    // divergence must consciously edit.
    expect(ENGAGEMENT_ROLE_CAPABILITIES[HOST_ROLES.DELIVERING_EXPERT]).toEqual(
      ENGAGEMENT_ROLE_CAPABILITIES[HOST_ROLES.AGENCY_ADMIN]
    );
  });

  it('covers EVERY EngagementCapability token — a third token cannot be silently unmapped (AC #12)', () => {
    expect(ALL_TOKENS.length).toBeGreaterThan(0); // non-vacuity
    for (const hostRole of Object.values(HOST_ROLES)) {
      expect([...ENGAGEMENT_ROLE_CAPABILITIES[hostRole]].sort()).toEqual([...ALL_TOKENS].sort());
    }
  });

  it('covers EVERY HostRole — a third host role cannot be silently unmapped', () => {
    const mapped = Object.keys(ENGAGEMENT_ROLE_CAPABILITIES).sort();
    expect(mapped).toEqual([...Object.values(HOST_ROLES)].sort());
  });
});

// ── AC #2: the pure core stays importable from apps/api ──────────────────────

describe('the pure core is dependency-free (AC #2)', () => {
  const source = stripComments(
    readFileSync(fileURLToPath(new URL('./engagement.ts', import.meta.url)), 'utf8')
  );

  it('reads its own source (non-vacuity guard for the scans below)', () => {
    expect(source).toContain('export function resolveHostRole');
  });

  it("never imports 'server-only' — it must be callable from apps/api and a client bundle", () => {
    expect(source).not.toContain('server-only');
  });

  it('never imports @balo/db — the pure core performs no I/O', () => {
    expect(source).not.toContain('@balo/db');
  });

  it('never imports a logger — a pure predicate observes nothing', () => {
    expect(source).not.toContain('@balo/shared/logging');
    expect(source).not.toContain('createLogger');
  });

  it('never compares a role string directly — every role decision goes through roleHasCapability', () => {
    expect(source).toContain('roleHasCapability(');
    expect(source).not.toMatch(/role\s*===\s*'/);
    expect(source).not.toMatch(/actorRole\s*===\s*'/);
  });
});
