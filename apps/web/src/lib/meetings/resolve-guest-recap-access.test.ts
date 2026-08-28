import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { codeLinesOf, resolveRouteDir } from '@/invariants/_source-scan';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const TOKEN = 'k7Qm2ZtXpA9wLd3Vc1Rb8YvNhKsE0uJt';
const GUEST_ID = 'e0000000-0000-4000-8000-00000000000e';

vi.mock('server-only', () => ({}));

const mockResolveSubject = vi.fn();
vi.mock('./resolve-meeting-guest', () => ({
  resolveMeetingGuestSubject: (...args: unknown[]) => mockResolveSubject(...args),
}));

const mockAuthorize = vi.fn();
vi.mock('./authorize-meeting-file-access', () => ({
  authorizeMeetingFileAccess: (...args: unknown[]) => mockAuthorize(...args),
}));

import { resolveGuestRecapAccess } from './resolve-guest-recap-access';

const SUBJECT = {
  guest: { id: GUEST_ID },
  meeting: { id: MEETING_ID, status: 'ended' },
  side: 'client',
  admission: 'admitted',
};

const OWN_MEETING = { id: MEETING_ID, status: 'ended' };
const SUBJECT_CONTEXT = { contextType: 'case', contextId: 'c0000000-0000-4000-8000-000000000003' };

describe('resolveGuestRecapAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes the RAW TOKEN to the resolver and the RESOLVED SUBJECT to the gate, with exact args', async () => {
    mockResolveSubject.mockResolvedValue(SUBJECT);
    mockAuthorize.mockResolvedValue({
      ok: true,
      viewer: 'guest',
      guestId: GUEST_ID,
      accessScope: 'meeting',
      meeting: OWN_MEETING,
      guestMeeting: OWN_MEETING,
      subject: SUBJECT_CONTEXT,
    });

    await resolveGuestRecapAccess(TOKEN, MEETING_ID);

    expect(mockResolveSubject).toHaveBeenCalledWith(TOKEN);
    expect(mockAuthorize).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      actor: { kind: 'guest', guest: SUBJECT },
    });
  });

  it('the resolver returning null ⇒ null, and the GATE IS NEVER CALLED', async () => {
    mockResolveSubject.mockResolvedValue(null);

    const access = await resolveGuestRecapAccess(TOKEN, MEETING_ID);

    expect(access).toBeNull();
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it('a gate refusal (ok:false) ⇒ null', async () => {
    mockResolveSubject.mockResolvedValue(SUBJECT);
    mockAuthorize.mockResolvedValue({ ok: false, code: 'meeting_not_found' });

    await expect(resolveGuestRecapAccess(TOKEN, MEETING_ID)).resolves.toBeNull();
  });

  /**
   * ⚠⚠ THE MIRROR IMAGE OF G1 (`resolve-recap-access.test.ts:109-125`). Proves a MEMBER payload
   * (with its `side` / `companyId` / `expertProfileId`) can never be renamed into a guest view,
   * even though it is unreachable in practice given the `actor: { kind: 'guest' }` passed above.
   */
  it('⚠⚠ a `viewer: "member"` ok:true payload ⇒ null', async () => {
    mockResolveSubject.mockResolvedValue(SUBJECT);
    mockAuthorize.mockResolvedValue({
      ok: true,
      viewer: 'member',
      side: 'client',
      meeting: OWN_MEETING,
      subject: SUBJECT_CONTEXT,
      companyId: 'company-1',
      expertProfileId: 'profile-1',
    });

    await expect(resolveGuestRecapAccess(TOKEN, MEETING_ID)).resolves.toBeNull();
  });

  it('maps guestId / accessScope / meeting / subject VERBATIM', async () => {
    mockResolveSubject.mockResolvedValue(SUBJECT);
    mockAuthorize.mockResolvedValue({
      ok: true,
      viewer: 'guest',
      guestId: GUEST_ID,
      accessScope: 'engagement',
      meeting: OWN_MEETING,
      guestMeeting: OWN_MEETING,
      subject: SUBJECT_CONTEXT,
    });

    const access = await resolveGuestRecapAccess(TOKEN, MEETING_ID);

    expect(access).toEqual({
      guestId: GUEST_ID,
      accessScope: 'engagement',
      meeting: OWN_MEETING,
      subject: SUBJECT_CONTEXT,
      isOwnMeeting: true,
    });
  });

  it('isOwnMeeting is true when guestMeeting.id === meeting.id', async () => {
    mockResolveSubject.mockResolvedValue(SUBJECT);
    mockAuthorize.mockResolvedValue({
      ok: true,
      viewer: 'guest',
      guestId: GUEST_ID,
      accessScope: 'meeting',
      meeting: { id: MEETING_ID, status: 'ended' },
      guestMeeting: { id: MEETING_ID, status: 'ended' },
      subject: SUBJECT_CONTEXT,
    });

    const access = await resolveGuestRecapAccess(TOKEN, MEETING_ID);
    expect(access?.isOwnMeeting).toBe(true);
  });

  it('⚠ isOwnMeeting is false for a RETROSPECTIVE, engagement-scope read of a different meeting', async () => {
    mockResolveSubject.mockResolvedValue(SUBJECT);
    mockAuthorize.mockResolvedValue({
      ok: true,
      viewer: 'guest',
      guestId: GUEST_ID,
      accessScope: 'engagement',
      meeting: { id: MEETING_ID, status: 'ended' },
      guestMeeting: { id: 'd0000000-0000-4000-8000-00000000000d', status: 'ended' },
      subject: SUBJECT_CONTEXT,
    });

    const access = await resolveGuestRecapAccess(TOKEN, MEETING_ID);
    expect(access?.isOwnMeeting).toBe(false);
  });
});

describe('resolve-guest-recap-access SOURCE invariants', () => {
  // ⚠ CWD-CANDIDATE LIST, NOT A BARE `process.cwd()` PATH — CI runs web vitest from the repo
  // root while a developer runs it from `apps/web` (memory `reference_web_server_disk_asset_cwd`).
  const file = resolveRouteDir([
    'src/lib/meetings/resolve-guest-recap-access.ts',
    'apps/web/src/lib/meetings/resolve-guest-recap-access.ts',
  ]);
  const code = codeLinesOf(file === '' ? '' : readFileSync(file, 'utf8'));

  it('guards the guard — the scan really found this module and sees its code', () => {
    expect(file).not.toBe('');
    expect(code).toContain('authorizeMeetingFileAccess');
  });

  it('⚠⚠ R3 — NEVER calls guestMayReadMeeting directly. The guest arm belongs to the file gate, reached one module further in', () => {
    expect(code).not.toContain('guestMayReadMeeting');
  });

  it('⚠ R4 at the type level — never names companyId or expertProfileId, the fields the guest arm deliberately omits', () => {
    expect(code).not.toContain('companyId');
    expect(code).not.toContain('expertProfileId');
  });

  it('never gates on a lens, an activeMode, or an admin arm', () => {
    expect(code).not.toContain('lens');
    expect(code).not.toContain('activeMode');
    expect(code).not.toContain("'admin'");
  });

  it('does NOT open the apps/web engagement-capability seam', () => {
    expect(code).not.toContain('hasEngagementCapability');
    expect(code).not.toContain('authorizeEngagementHost');
  });
});
