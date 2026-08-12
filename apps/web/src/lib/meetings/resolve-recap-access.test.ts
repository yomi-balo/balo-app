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

import { resolveRecapAccess } from './resolve-recap-access';

const MEETING = { id: MEETING_ID, status: 'ended' };
const SUBJECT = { contextType: 'case', contextId: 'e0000000-0000-4000-8000-000000000005' };

describe('resolveRecapAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes the meetingId and userId straight through to the SHIPPED gate', async () => {
    mockAuthorize.mockResolvedValue({
      ok: true,
      side: 'client',
      meeting: MEETING,
      subject: SUBJECT,
      companyId: COMPANY_ID,
      expertProfileId: PROFILE_ID,
    });

    await resolveRecapAccess(MEETING_ID, USER_ID);
    expect(mockAuthorize).toHaveBeenCalledTimes(1);
    expect(mockAuthorize).toHaveBeenCalledWith({ meetingId: MEETING_ID, userId: USER_ID });
  });

  it('renames side to lens VERBATIM on the client arm — it never re-derives it', async () => {
    mockAuthorize.mockResolvedValue({
      ok: true,
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
      side: 'client',
      meeting: MEETING,
      subject: { contextType: 'project_discovery', contextId: 'req-1' },
      companyId: COMPANY_ID,
      expertProfileId: null,
    });

    const access = await resolveRecapAccess(MEETING_ID, USER_ID);
    expect(access?.expertProfileId).toBeNull();
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

  it('NEVER calls guestMayReadMeeting — the guest arm belongs to BAL-132 (D2)', () => {
    // There is no guest-authenticated read session on main. Calling the predicate here would
    // authorize a read against a grant with no authenticated subject to bind it to, which is
    // worse than denying. `guestMayReadMeeting`'s own "BAL-388 MUST CALL THIS" docblock is
    // STALE and is not authority.
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
