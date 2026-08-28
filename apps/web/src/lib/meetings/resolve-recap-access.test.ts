import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { codeLinesOf, resolveRouteDir } from '@/invariants/_source-scan';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const USER_ID = 'b0000000-0000-4000-8000-000000000002';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';
const PROFILE_ID = 'd0000000-0000-4000-8000-000000000004';

vi.mock('server-only', () => ({}));

const mockAuthorize = vi.fn();
vi.mock('./authorize-meeting-file-access', () => ({
  authorizeMeetingFileAccess: (...args: unknown[]) => mockAuthorize(...args),
}));

const { mockLog } = vi.hoisted(() => ({
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/logging', () => ({ log: mockLog }));

import { resolveRecapAccess } from './resolve-recap-access';

const MEETING = { id: MEETING_ID, status: 'ended' };
const SUBJECT = { contextType: 'case', contextId: 'e0000000-0000-4000-8000-000000000005' };

describe('resolveRecapAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes the meetingId and a MEMBER actor straight through to the SHIPPED gate', async () => {
    mockAuthorize.mockResolvedValue({
      ok: true,
      viewer: 'member',
      side: 'client',
      meeting: MEETING,
      subject: SUBJECT,
      companyId: COMPANY_ID,
      expertProfileId: PROFILE_ID,
    });

    await resolveRecapAccess(MEETING_ID, USER_ID);
    expect(mockAuthorize).toHaveBeenCalledTimes(1);
    expect(mockAuthorize).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      actor: { kind: 'member', userId: USER_ID },
    });
  });

  it('renames side to lens VERBATIM on the client arm — it never re-derives it', async () => {
    mockAuthorize.mockResolvedValue({
      ok: true,
      viewer: 'member',
      side: 'client',
      meeting: MEETING,
      subject: SUBJECT,
      companyId: COMPANY_ID,
      expertProfileId: PROFILE_ID,
    });

    const access = await resolveRecapAccess(MEETING_ID, USER_ID);
    expect(access).toEqual({
      lens: 'client',
      meeting: MEETING,
      subject: SUBJECT,
      companyId: COMPANY_ID,
      expertProfileId: PROFILE_ID,
    });
  });

  it('renames side to lens VERBATIM on the expert arm', async () => {
    mockAuthorize.mockResolvedValue({
      ok: true,
      viewer: 'member',
      side: 'expert',
      meeting: MEETING,
      subject: SUBJECT,
      companyId: COMPANY_ID,
      expertProfileId: PROFILE_ID,
    });

    const access = await resolveRecapAccess(MEETING_ID, USER_ID);
    expect(access?.lens).toBe('expert');
  });

  it('threads a null expertProfileId through (a match-routed discovery names nobody)', async () => {
    mockAuthorize.mockResolvedValue({
      ok: true,
      viewer: 'member',
      side: 'client',
      meeting: MEETING,
      subject: { contextType: 'project_discovery', contextId: 'req-1' },
      companyId: COMPANY_ID,
      expertProfileId: null,
    });

    const access = await resolveRecapAccess(MEETING_ID, USER_ID);
    expect(access?.expertProfileId).toBeNull();
  });

  /**
   * ⚠⚠ R4 / §3.3 — THE BEHAVIOURAL PAIR THAT REPLACES THE WORTHLESS SOURCE SCAN. The old
   * `expect(code).not.toContain('guestMayReadMeeting')` scanned only THIS file's own text,
   * which never mentioned the predicate — so it stayed green while BAL-445 filled the file
   * gate's guest arm and this pass-through opened the recap SILENTLY. A guard that cannot
   * observe the thing it guards is worse than no guard.
   *
   * @see resolve-guest-recap-access.test.ts — BAL-439's sibling coverage for the guest arm
   * this test proves `resolveRecapAccess` itself still refuses.
   */
  it('⚠⚠ returns null for a GUEST subject the file gate now says yes to — guest recap is BAL-439’s', async () => {
    // The file gate's guest arm is FILLED as of BAL-445, so this is the shape it really
    // returns. The recap must refuse it on its own, not inherit a denial it no longer gets.
    mockAuthorize.mockResolvedValue({
      ok: true,
      viewer: 'guest',
      guestId: 'e0000000-0000-4000-8000-00000000000e',
      accessScope: 'engagement',
      meeting: MEETING,
      subject: SUBJECT,
    });
    await expect(resolveRecapAccess(MEETING_ID, USER_ID)).resolves.toBeNull();
    expect(mockLog.warn).toHaveBeenCalledWith(
      'Recap access refused for a guest subject',
      expect.objectContaining({ meetingId: MEETING_ID })
    );
  });

  it('⚠ and it still passes MEMBER subjects straight through — the gate is narrow, not blunt', async () => {
    mockAuthorize.mockResolvedValue({
      ok: true,
      viewer: 'member',
      side: 'client',
      meeting: MEETING,
      subject: SUBJECT,
      companyId: COMPANY_ID,
      expertProfileId: PROFILE_ID,
    });
    await expect(resolveRecapAccess(MEETING_ID, USER_ID)).resolves.toMatchObject({
      lens: 'client',
    });
  });

  it('collapses EVERY gate denial into a single null — no existence oracle', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, code: 'meeting_not_found' });
    await expect(resolveRecapAccess(MEETING_ID, USER_ID)).resolves.toBeNull();
  });

  it('adds NO admin arm of its own — a denied gate stays denied whatever the reason', async () => {
    // ⚠ NAMED FOR WHAT IT PROVES. The gate is fully mocked here, so this does NOT exercise
    // `selectPrimaryMeetingContext`'s admin-drop — that behaviour is owned and tested by
    // `authorize-meeting-file-access.test.ts`, which this ticket does not touch. What IS proved
    // here is that this adapter invents no second arm: any `ok: false`, including the
    // `reason: 'none'` an admin-only meeting produces, collapses into the same single null.
    // The absence of an admin BRANCH is pinned by the source invariants below.
    mockAuthorize.mockResolvedValue({ ok: false, code: 'meeting_not_found' });
    await expect(resolveRecapAccess(MEETING_ID, USER_ID)).resolves.toBeNull();
  });
});

describe('resolve-recap-access SOURCE invariants', () => {
  // ⚠ THE READ USES A CWD-CANDIDATE LIST, NOT A BARE `process.cwd()` PATH. CI runs web vitest
  // from the REPO ROOT while a developer runs it from `apps/web`, so a single cwd-relative
  // path resolves to nothing in one of the two — and a scan that finds nothing passes every
  // assertion for the wrong reason (memory `reference_web_server_disk_asset_cwd`).
  //
  // ⚠ `codeLinesOf` is IMPORTED, not re-spelled: a second verbatim copy of the comment
  // stripper is exactly the shape SonarCloud's duplication gate exists to catch.
  const file = resolveRouteDir([
    'src/lib/meetings/resolve-recap-access.ts',
    'apps/web/src/lib/meetings/resolve-recap-access.ts',
  ]);
  const code = codeLinesOf(file === '' ? '' : readFileSync(file, 'utf8'));

  it('guards the guard — the scan really found this module and sees its code', () => {
    expect(file).not.toBe('');
    expect(code).toContain('authorizeMeetingFileAccess');
  });

  it('NEVER calls guestMayReadMeeting directly — the guest arm belongs to BAL-439, gated via the file gate', () => {
    // This module does not call the predicate itself: it composes `authorizeMeetingFileAccess`
    // (which DOES call it, as of BAL-445) and then explicitly REFUSES whatever guest verdict
    // comes back. See the module docblock and the behavioural pair above — this scan is a
    // narrow style guard, not the guest-closure proof; the tests above are.
    expect(code).not.toContain('guestMayReadMeeting');
  });

  it('does NOT open the apps/web engagement-capability seam', () => {
    // The recap is a READ. A true from hasEngagementCapability authorizes the ACT, never the
    // READ — that seam still lands with its first consumer, BAL-410 / BAL-411.
    expect(code).not.toContain('hasEngagementCapability');
    expect(code).not.toContain('authorizeEngagementHost');
  });

  it('never reads activeMode — a view toggle is never an authorization input (ADR-1029)', () => {
    expect(code).not.toContain('activeMode');
  });

  it('declares NO admin arm — a label no code path can emit is a dead union member', () => {
    // `selectPrimaryMeetingContext` DROPS admin rows inside the gate, so an admin-only meeting
    // never reaches this module at all. A defensive `admin` branch here would read as coverage
    // that does not exist; admin meetings resolve on the PLATFORM axis (ADR-1035).
    expect(code).not.toContain("'admin'");
    expect(code).not.toContain('hasPlatformCapability');
  });
});
