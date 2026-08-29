import { describe, it, expect } from 'vitest';
import type { DerivedWorkspaces } from '@balo/shared/workspaces';
import type { SessionUser } from '@/lib/auth/session';
import { applyWorkspaceDerivationToSessionUser, activeWorkspaceKeyOf } from './session-workspace';

function baseUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-1',
    email: 'dana@northwind.test',
    firstName: 'Dana',
    lastName: 'Lee',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'user',
    companyId: 'company-old',
    companyName: 'Old Name',
    companyRole: 'member',
    ...overrides,
  };
}

function derivation(overrides: Partial<DerivedWorkspaces> = {}): DerivedWorkspaces {
  const companyWorkspace = {
    type: 'company' as const,
    key: 'company:company-new',
    companyId: 'company-new',
    name: 'Northwind Industrial',
    via: 'membership' as const,
    isPersonal: false,
  };
  return {
    workspaces: [companyWorkspace],
    activeWorkspace: companyWorkspace,
    session: {
      activeMode: 'client',
      companyId: 'company-new',
      companyName: 'Northwind Industrial',
      companyRole: 'owner',
    },
    ...overrides,
  };
}

describe('applyWorkspaceDerivationToSessionUser', () => {
  it('repoints all four legacy fields AND the activeWorkspace pointer together', () => {
    const user = baseUser();
    const derived = derivation();

    applyWorkspaceDerivationToSessionUser(user, derived);

    expect(user.activeMode).toBe('client');
    expect(user.companyId).toBe('company-new');
    expect(user.companyName).toBe('Northwind Industrial');
    expect(user.companyRole).toBe('owner');
    expect(user.activeWorkspace).toEqual(derived.activeWorkspace);
  });

  it('mutates the user object in place (same reference)', () => {
    const user = baseUser();
    const result = applyWorkspaceDerivationToSessionUser(user, derivation());
    expect(result).toBeUndefined();
    expect(user.companyId).toBe('company-new');
  });

  it('does not call session.save() — the caller owns the session lifecycle (no save method invoked here)', () => {
    // There is no `save` on SessionUser itself; this documents the contract by construction —
    // the function signature accepts a plain SessionUser, not a Session with .save().
    const user = baseUser();
    applyWorkspaceDerivationToSessionUser(user, derivation());
    expect('save' in user).toBe(false);
  });

  it('projects the EXPERT workspace projection correctly', () => {
    const user = baseUser();
    const expertDerived = derivation({
      activeWorkspace: { type: 'expert', key: 'expert' },
      session: {
        activeMode: 'expert',
        companyId: 'company-personal',
        companyName: "Dana's Workspace",
        companyRole: 'owner',
      },
    });

    applyWorkspaceDerivationToSessionUser(user, expertDerived);

    expect(user.activeMode).toBe('expert');
    expect(user.activeWorkspace).toEqual({ type: 'expert', key: 'expert' });
    expect(user.companyId).toBe('company-personal');
  });

  it('NEVER writes the workspace LIST onto the session user', () => {
    // ⚠ THE COOKIE-BUDGET INVARIANT, pinned at the one place every writer funnels through
    // (OAuth callback, session-sync route, switch service). The sealed `balo_session` cookie
    // crosses the browser's 4096-byte `name=value` limit at five to eight company
    // workspaces, and an
    // oversized `Set-Cookie` is SILENTLY DISCARDED — an unrecoverable sign-in loop. The
    // derivation carries the list; this patcher must drop it on the floor.
    // `lib/auth/session-cookie-size.test.ts` measures the actual bytes.
    const user = baseUser();
    const derived = derivation();

    applyWorkspaceDerivationToSessionUser(user, derived);

    expect(derived.workspaces.length).toBeGreaterThan(0);
    expect(user).not.toHaveProperty('workspaces');
    expect(Object.keys(user)).not.toContain('workspaces');
  });
});

describe('activeWorkspaceKeyOf', () => {
  it('returns undefined for a pre-BAL-494 cookie with no activeWorkspace', () => {
    expect(activeWorkspaceKeyOf(baseUser())).toBeUndefined();
  });

  it('returns the key when activeWorkspace is present', () => {
    const user = baseUser({ activeWorkspace: { type: 'expert', key: 'expert' } });
    expect(activeWorkspaceKeyOf(user)).toBe('expert');
  });
});
