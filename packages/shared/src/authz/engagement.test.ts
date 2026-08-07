import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

const ALL_TOKENS: readonly EngagementCapability[] = Object.values(ENGAGEMENT_CAPABILITIES);

/** Agency-based expert whose agency membership row for the actor carries `actorRole`. */
function agencyContext(actorRole: string | null): HostContext {
  return { expertUserId: EXPERT_USER, agency: { agencyId: AGENCY_ID, actorRole } };
}

/** Independent expert — `agency: null` means NO agency lookup was ever performed. */
const INDEPENDENT_CONTEXT: HostContext = { expertUserId: EXPERT_USER, agency: null };

// ── resolveHostRole ──────────────────────────────────────────────────────────

describe('resolveHostRole', () => {
  it('resolves the DELIVERING EXPERT when the actor is that expert (AC #3)', () => {
    expect(resolveHostRole(INDEPENDENT_CONTEXT, { id: EXPERT_USER })).toBe(
      HOST_ROLES.DELIVERING_EXPERT
    );
  });

  it('resolves delivering_expert BEFORE any agency consideration (AC #3)', () => {
    // The expert is themselves a non-admin member of their own agency. Identity wins:
    // the agency branch is never reached, so their agency role cannot demote them.
    expect(resolveHostRole(agencyContext('expert'), { id: EXPERT_USER })).toBe(
      HOST_ROLES.DELIVERING_EXPERT
    );
  });

  it('resolves AGENCY_ADMIN for an agency owner (AC #3)', () => {
    expect(resolveHostRole(agencyContext('owner'), { id: 'user_other' })).toBe(
      HOST_ROLES.AGENCY_ADMIN
    );
  });

  it('resolves AGENCY_ADMIN for an agency admin (AC #3)', () => {
    expect(resolveHostRole(agencyContext('admin'), { id: 'user_other' })).toBe(
      HOST_ROLES.AGENCY_ADMIN
    );
  });

  it('resolves NULL for agency role `expert` — the base bundle has no MANAGE_MEMBERS (AC #4)', () => {
    expect(resolveHostRole(agencyContext('expert'), { id: 'user_colleague' })).toBeNull();
  });

  it('resolves NULL for role `member` — a company base role never grants on this axis (AC #4)', () => {
    expect(resolveHostRole(agencyContext('member'), { id: 'user_colleague' })).toBeNull();
  });

  it('resolves NULL for an unknown / empty role string (fail closed)', () => {
    expect(resolveHostRole(agencyContext('finance'), { id: 'user_other' })).toBeNull();
    expect(resolveHostRole(agencyContext(''), { id: 'user_other' })).toBeNull();
  });

  it('resolves NULL when actorRole is null — the one branch that excludes every client-side actor, delegate and guest (AC #5)', () => {
    // A company `owner` DOES hold MANAGE_MEMBERS — but their role was looked up in the
    // DELIVERING expert's agency, where they have no live row, so `actorRole` is null
    // and their company role is never consulted.
    expect(resolveHostRole(agencyContext(null), { id: 'user_client_owner' })).toBeNull();
  });

  it('resolves NULL for an independent expert when the actor is someone else (AC #6)', () => {
    expect(resolveHostRole(INDEPENDENT_CONTEXT, { id: 'user_other' })).toBeNull();
  });

  it('resolves NULL for a NULL host context — a no-holder subject (AC #8)', () => {
    expect(resolveHostRole(null, { id: EXPERT_USER })).toBeNull();
    expect(resolveHostRole(null, { id: 'user_other' })).toBeNull();
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
      expect(hostContextGrants(INDEPENDENT_CONTEXT, { id: EXPERT_USER }, token)).toBe(true);
    }
  });

  it('grants BOTH tokens to an agency owner and an agency admin', () => {
    for (const role of ['owner', 'admin']) {
      for (const token of ALL_TOKENS) {
        expect(hostContextGrants(agencyContext(role), { id: 'user_other' }, token)).toBe(true);
      }
    }
  });

  it('is FALSE for BOTH tokens when the host role is null (AC #5, AC #8)', () => {
    const nonHolderContexts: readonly [string, HostContext | null][] = [
      ['null context (match-routed discovery / admin / declined)', null],
      ['independent expert, different actor', INDEPENDENT_CONTEXT],
      ['non-member of the delivering agency', agencyContext(null)],
      ['agency role expert', agencyContext('expert')],
      ['company base role member', agencyContext('member')],
    ];

    for (const [, context] of nonHolderContexts) {
      for (const token of ALL_TOKENS) {
        expect(hostContextGrants(context, { id: 'user_other' }, token)).toBe(false);
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

/** Comments first, so the docblocks that EXPLAIN these absences do not trip the scan. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

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
