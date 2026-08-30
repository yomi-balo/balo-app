import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('server-only', () => ({}));

const PERSONAL_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const REP_ID = '33333333-3333-4333-8333-333333333333';

const mockLoadWorkspaceDerivationMaterials = vi.fn();
vi.mock('./derive-workspaces', () => ({
  loadWorkspaceDerivationMaterials: (...args: unknown[]) =>
    mockLoadWorkspaceDerivationMaterials(...args),
}));

const mockUpdate = vi.fn();
// BAL-499 (D7) — additive: `companiesRepository.findById` is what `buildNavContext` (via
// `resolveNavCapabilities`) reaches when the actor's session `companyRole` grants
// MANAGE_MEMBERS. Not exercised by the pre-existing `switchWorkspace` tests, only by the D7
// block below, which chains the real `buildNavContext` on top of a real switch.
const mockFindCompanyById = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: { update: (...args: unknown[]) => mockUpdate(...args) },
  companiesRepository: { findById: (...args: unknown[]) => mockFindCompanyById(...args) },
}));

const mockTrackServerAndFlush = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...args: unknown[]) => mockTrackServerAndFlush(...args),
  WORKSPACE_SERVER_EVENTS: { SWITCHED: 'workspace_switched' },
}));

const { mockLogWarn, mockLogInfo } = vi.hoisted(() => ({
  mockLogWarn: vi.fn(),
  mockLogInfo: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({
  log: { warn: mockLogWarn, info: mockLogInfo, error: vi.fn() },
}));

let mockSessionObj: { user?: Record<string, unknown>; save: ReturnType<typeof vi.fn> };
const mockGetSession = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getSession: () => mockGetSession() }));

import { switchWorkspace } from './switch-workspace';
import { buildNavContext } from '@/lib/navigation/nav-context';
import { creditsChipIsInScope } from '@/components/layout/credits-chip-scope';
import type { SessionUser } from '@/lib/auth/session';

// ── Helpers ─────────────────────────────────────────────────────

function materials(overrides: Record<string, unknown> = {}) {
  return {
    input: {
      hasApprovedExpertProfile: true,
      memberships: [
        { companyId: PERSONAL_ID, name: "Dana's Workspace", isPersonal: true, role: 'owner' },
      ],
      eligibleCompanyIds: [PERSONAL_ID],
      representedCompanies: [{ companyId: REP_ID, name: 'Represented Co', isPersonal: false }],
    },
    stored: { activeMode: 'client', activeCompanyId: null },
    ...overrides,
  };
}

/** A two-membership actor, currently on their personal workspace. */
function twoCompanyOverrides(): Record<string, unknown> {
  return {
    input: {
      hasApprovedExpertProfile: false,
      memberships: [
        { companyId: PERSONAL_ID, name: "Dana's", isPersonal: true, role: 'owner' },
        { companyId: ORG_ID, name: 'Northwind', isPersonal: false, role: 'admin' },
      ],
      eligibleCompanyIds: [PERSONAL_ID, ORG_ID],
      representedCompanies: [],
    },
    stored: { activeMode: 'client', activeCompanyId: PERSONAL_ID },
  };
}

const user = { id: 'user-1' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadWorkspaceDerivationMaterials.mockResolvedValue(materials());
  mockSessionObj = {
    user: {
      id: 'user-1',
      activeMode: 'client',
      companyId: PERSONAL_ID,
      companyName: "Dana's Workspace",
      companyRole: 'owner',
    },
    save: vi.fn().mockResolvedValue(undefined),
  };
  mockGetSession.mockResolvedValue(mockSessionObj);
  mockUpdate.mockResolvedValue({});
  mockFindCompanyById.mockResolvedValue({ isPersonal: false });
});

// ── Tests ───────────────────────────────────────────────────────

describe('switchWorkspace', () => {
  it('rejects a malformed key', async () => {
    const result = await switchWorkspace(user, 'not-a-valid-key', 'switcher');
    expect(result).toEqual({ ok: false, reason: 'invalid_target' });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockTrackServerAndFlush).not.toHaveBeenCalled();
  });

  it('rejects a target not in the derived list (not_eligible) — no DB write, no analytics', async () => {
    const foreignId = '99999999-9999-4999-8999-999999999999';
    const result = await switchWorkspace(user, `company:${foreignId}`, 'switcher');
    expect(result).toEqual({ ok: false, reason: 'not_eligible' });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockTrackServerAndFlush).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Workspace switch rejected: target not in derived list',
      expect.objectContaining({ userId: 'user-1' })
    );
  });

  it('returns not_eligible when the actor has no derivable workspace at all', async () => {
    mockLoadWorkspaceDerivationMaterials.mockResolvedValue(
      materials({
        input: {
          hasApprovedExpertProfile: false,
          memberships: [],
          eligibleCompanyIds: [],
          representedCompanies: [],
        },
      })
    );
    const result = await switchWorkspace(user, 'expert', 'switcher');
    expect(result).toEqual({ ok: false, reason: 'not_eligible' });
  });

  it('R1 — rejects a representation-only workspace with a DISTINCT reason', async () => {
    const result = await switchWorkspace(user, `company:${REP_ID}`, 'switcher');
    expect(result).toEqual({ ok: false, reason: 'representation_switch_not_enabled' });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockTrackServerAndFlush).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Workspace switch rejected: representation workspace is not switchable (BAL-314)',
      expect.objectContaining({ userId: 'user-1', targetKey: `company:${REP_ID}` })
    );
  });

  it('company target writes { activeMode: client, activeCompanyId }', async () => {
    mockLoadWorkspaceDerivationMaterials.mockResolvedValue(materials(twoCompanyOverrides()));

    const result = await switchWorkspace(user, `company:${ORG_ID}`, 'switcher');

    expect(mockUpdate).toHaveBeenCalledWith('user-1', {
      activeMode: 'client',
      activeCompanyId: ORG_ID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changed).toBe(true);
      expect(result.workspace).toMatchObject({ companyId: ORG_ID });
    }
  });

  it('expert target writes { activeMode: expert } and does NOT clear activeCompanyId', async () => {
    mockLoadWorkspaceDerivationMaterials.mockResolvedValue(
      materials({ stored: { activeMode: 'client', activeCompanyId: PERSONAL_ID } })
    );

    const result = await switchWorkspace(user, 'expert', 'switcher');

    expect(mockUpdate).toHaveBeenCalledWith('user-1', { activeMode: 'expert' });
    expect(mockUpdate.mock.calls[0]?.[1]).not.toHaveProperty('activeCompanyId');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.workspace).toEqual({ type: 'expert', key: 'expert' });
  });

  it('patches AND saves the session on a real switch', async () => {
    await switchWorkspace(user, 'expert', 'switcher');
    expect(mockSessionObj.user?.activeMode).toBe('expert');
    expect(mockSessionObj.save).toHaveBeenCalled();
  });

  it('fires exactly one analytics event with distinct_id and the caller trigger', async () => {
    await switchWorkspace(user, 'expert', 'deep_link_auto');
    expect(mockTrackServerAndFlush).toHaveBeenCalledTimes(1);
    expect(mockTrackServerAndFlush).toHaveBeenCalledWith('workspace_switched', {
      from_type: 'company',
      to_type: 'expert',
      trigger: 'deep_link_auto',
      distinct_id: 'user-1',
    });
  });

  // The expert-target assertion above can never observe `to_company_id`, which is exactly the
  // conditional-spread property most likely to regress. Assert it on a COMPANY target.
  it('a company target carries to_company_id on the analytics payload', async () => {
    mockLoadWorkspaceDerivationMaterials.mockResolvedValue(materials(twoCompanyOverrides()));

    await switchWorkspace(user, `company:${ORG_ID}`, 'switcher');

    expect(mockTrackServerAndFlush).toHaveBeenCalledTimes(1);
    expect(mockTrackServerAndFlush).toHaveBeenCalledWith('workspace_switched', {
      from_type: 'company',
      to_type: 'company',
      to_company_id: ORG_ID,
      trigger: 'switcher',
      distinct_id: 'user-1',
    });
  });

  it('no-op when already on the target: no write, no analytics, no save, changed:false', async () => {
    mockLoadWorkspaceDerivationMaterials.mockResolvedValue(
      materials({ stored: { activeMode: 'client', activeCompanyId: PERSONAL_ID } })
    );

    const result = await switchWorkspace(user, `company:${PERSONAL_ID}`, 'switcher');

    expect(result).toEqual({
      ok: true,
      changed: false,
      workspace: expect.objectContaining({ companyId: PERSONAL_ID }),
    });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockTrackServerAndFlush).not.toHaveBeenCalled();
    expect(mockSessionObj.save).not.toHaveBeenCalled();
  });

  it('logs info with from/to keys and trigger on a real switch', async () => {
    await switchWorkspace(user, 'expert', 'switcher');
    expect(mockLogInfo).toHaveBeenCalledWith(
      'Workspace switched',
      expect.objectContaining({
        userId: 'user-1',
        fromKey: `company:${PERSONAL_ID}`,
        toKey: 'expert',
        trigger: 'switcher',
      })
    );
  });
});

/**
 * BAL-499 (D7) — "no expert workspace ever paints the chip, including across a switch" is
 * testable TODAY at the session/RSC level, without any BAL-496 switcher UI: the REAL
 * `switchWorkspace` (this file's subject) mutates the session in place, the REAL
 * `buildNavContext` projects it into a `NavContext`, and the REAL `creditsChipIsInScope` gates
 * on that context — chained end to end, no stub, no mock of any of the three.
 */
describe('credits chip never survives a switch into the expert workspace (BAL-499 D7)', () => {
  it('switching into the expert workspace takes the chip out of scope', async () => {
    const result = await switchWorkspace(user, 'expert', 'switcher');
    expect(result.ok).toBe(true);

    // F9 — names the real target type instead of routing through `never`. `mockSessionObj.user`
    // is only a PARTIAL `SessionUser` fixture (the fields `buildNavContext` actually reads), so
    // TS won't allow the single-step `as SessionUser` (types don't "sufficiently overlap");
    // `unknown` is the required intermediate, not a further type-safety hole.
    const ctx = await buildNavContext(mockSessionObj.user as unknown as SessionUser);

    expect(ctx.workspaceType).toBe('expert');
    expect(creditsChipIsInScope(ctx)).toBe(false);
  });

  it('the mirror: switching into a company workspace keeps the chip in scope', async () => {
    mockLoadWorkspaceDerivationMaterials.mockResolvedValue(materials(twoCompanyOverrides()));

    const result = await switchWorkspace(user, `company:${ORG_ID}`, 'switcher');
    expect(result.ok).toBe(true);

    const ctx = await buildNavContext(mockSessionObj.user as unknown as SessionUser);

    expect(ctx.workspaceType).toBe('company');
    expect(creditsChipIsInScope(ctx)).toBe(true);
  });
});
