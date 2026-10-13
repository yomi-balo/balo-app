import { expect, it } from 'vitest';

export interface ApprovedProfileRow {
  id: string;
  userId: string;
  approvedAt: Date | null;
}

export const APPROVED_PROFILE_ROW: ApprovedProfileRow = {
  id: 'profile-1',
  userId: 'user-1',
  approvedAt: new Date('2026-01-01T00:00:00.000Z'),
};

export const DRAFT_PROFILE_ROW: ApprovedProfileRow = { ...APPROVED_PROFILE_ROW, approvedAt: null };

export interface ApprovedExpertGateHarness {
  setSessionUser(user: { activeMode: 'client' | 'expert'; expertProfileId?: string }): void;
  setProfileRow(row: ApprovedProfileRow | undefined): void;
  readonly findApprovalById: { mock: { calls: unknown[][] } };
  run(): Promise<unknown>;
  expectAllowed(result: unknown): void;
  expectRefused(result: unknown): void;
  expectNoSideEffect(): void;
}

/**
 * The three approved-expert gate cases every guarded Server Action must satisfy. Shared so the
 * suites do not each clone the same block (the Sonar duplication gate).
 */
export function itEnforcesApprovedExpertGate(h: ApprovedExpertGateHarness): void {
  it('allows an approved expert whose active view is client', async () => {
    h.setSessionUser({ activeMode: 'client', expertProfileId: APPROVED_PROFILE_ROW.id });
    h.setProfileRow(APPROVED_PROFILE_ROW);
    h.expectAllowed(await h.run());
  });

  it('refuses a user with no expert profile without reading one', async () => {
    h.setSessionUser({ activeMode: 'expert' });
    h.setProfileRow(APPROVED_PROFILE_ROW);
    h.expectRefused(await h.run());
    expect(h.findApprovalById.mock.calls).toHaveLength(0);
  });

  it('refuses an unapproved (draft) expert profile', async () => {
    h.setSessionUser({ activeMode: 'expert', expertProfileId: DRAFT_PROFILE_ROW.id });
    h.setProfileRow(DRAFT_PROFILE_ROW);
    h.expectRefused(await h.run());
    h.expectNoSideEffect();
  });
}
