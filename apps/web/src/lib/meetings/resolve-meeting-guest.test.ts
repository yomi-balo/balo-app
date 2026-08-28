import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const RAW_TOKEN = 'k7Qm2ZtXpA9wLd3Vc1Rb8YvNhKsE0uJt';
const TOKEN_HASH = createHash('sha256').update(RAW_TOKEN).digest('hex');
const GUEST_ID = 'a0000000-0000-4000-8000-00000000000a';
const MEETING_ID = 'b0000000-0000-4000-8000-00000000000c';

const { mockFindByTokenHash, mockLog } = vi.hoisted(() => ({
  mockFindByTokenHash: vi.fn(),
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@balo/db', () => ({
  meetingGuestsRepository: {
    findLiveByTokenHash: (...a: unknown[]) => mockFindByTokenHash(...a),
  },
}));

vi.mock('@/lib/logging', () => ({ log: mockLog }));

import { resolveMeetingGuestSubject } from './resolve-meeting-guest';

const MEETING = {
  id: MEETING_ID,
  status: 'scheduled',
} as never;

function guestRow(overrides: Partial<Record<string, unknown>> = {}): {
  guest: Record<string, unknown>;
  meeting: unknown;
} {
  return {
    guest: {
      id: GUEST_ID,
      tokenHash: TOKEN_HASH,
      party: 'client',
      accessScope: 'meeting',
      meetingId: MEETING_ID,
      admission: 'admitted',
      ...overrides,
    },
    meeting: MEETING,
  };
}

describe('resolveMeetingGuestSubject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves a live, matching token to a subject with side derived and tokenHash stripped', async () => {
    mockFindByTokenHash.mockResolvedValue(guestRow());

    const subject = await resolveMeetingGuestSubject(RAW_TOKEN);

    expect(subject).not.toBeNull();
    expect(subject?.side).toBe('client');
    expect(subject?.meeting).toBe(MEETING);
    expect(subject?.guest).not.toHaveProperty('tokenHash');
    expect(subject?.guest.id).toBe(GUEST_ID);
    expect(mockFindByTokenHash).toHaveBeenCalledWith(TOKEN_HASH);
  });

  it('resolves the expert side identically', async () => {
    mockFindByTokenHash.mockResolvedValue(guestRow({ party: 'expert' }));

    const subject = await resolveMeetingGuestSubject(RAW_TOKEN);

    expect(subject?.side).toBe('expert');
  });

  it('returns null and logs info when the repository finds no live row (wrong/expired/revoked/denied/cancelled)', async () => {
    mockFindByTokenHash.mockResolvedValue(undefined);

    const subject = await resolveMeetingGuestSubject(RAW_TOKEN);

    expect(subject).toBeNull();
    expect(mockLog.info).toHaveBeenCalledWith(
      'Guest join link not active',
      expect.objectContaining({ tokenHashPrefix: TOKEN_HASH.slice(0, 8) })
    );
  });

  it('returns null when the resolved row does not hash-match the presented token', async () => {
    mockFindByTokenHash.mockResolvedValue(guestRow({ tokenHash: 'deadbeef' }));

    const subject = await resolveMeetingGuestSubject(RAW_TOKEN);

    expect(subject).toBeNull();
    expect(mockLog.info).toHaveBeenCalledWith('Guest join link not active', expect.any(Object));
  });

  it('returns null and logs warn on a corrupt/unplaceable party', async () => {
    mockFindByTokenHash.mockResolvedValue(guestRow({ party: 'observer' }));

    const subject = await resolveMeetingGuestSubject(RAW_TOKEN);

    expect(subject).toBeNull();
    expect(mockLog.warn).toHaveBeenCalledWith(
      'Guest row carries an unplaceable party',
      expect.objectContaining({ guestId: GUEST_ID })
    );
  });

  it('never logs the raw token or the full hash — only an 8-char hash prefix', async () => {
    mockFindByTokenHash.mockResolvedValue(undefined);

    await resolveMeetingGuestSubject(RAW_TOKEN);

    const [, fields] = mockLog.info.mock.calls[0] as [string, { tokenHashPrefix: string }];
    expect(fields.tokenHashPrefix).toHaveLength(8);
    expect(fields.tokenHashPrefix).not.toBe(TOKEN_HASH);
    expect(JSON.stringify(mockLog.info.mock.calls)).not.toContain(RAW_TOKEN);
  });

  it('resolves an ended meeting — the shipped asymmetry with the mutation gate', async () => {
    mockFindByTokenHash.mockResolvedValue({
      guest: guestRow().guest,
      meeting: { id: MEETING_ID, status: 'ended' },
    });

    const subject = await resolveMeetingGuestSubject(RAW_TOKEN);

    expect(subject).not.toBeNull();
    expect((subject?.meeting as { status: string }).status).toBe('ended');
  });

  // ⚠⚠ F1 (fix-round-1) — DELIBERATE: this resolver still resolves a `pending` row. The
  // admission check belongs at the READ gate (`authorizeMeetingFileAccess`'s guest arm via
  // `guestIsAdmittedForRead`), NOT here — `/join/[token]/page.tsx` legitimately renders the
  // waiting card for a not-yet-admitted guest, and `pollGuestAdmissionAction` depends on this
  // resolver still returning a subject for a `pending` row. Do not push the admission check
  // down into this function.
  it('DELIBERATELY still resolves a `pending` (never-admitted) guest, and threads its admission onto the subject', async () => {
    mockFindByTokenHash.mockResolvedValue(guestRow({ admission: 'pending' }));

    const subject = await resolveMeetingGuestSubject(RAW_TOKEN);

    expect(subject).not.toBeNull();
    expect(subject?.admission).toBe('pending');
  });

  it('threads `admitted`/`pre_admitted` admission onto the subject identically', async () => {
    mockFindByTokenHash.mockResolvedValue(guestRow({ admission: 'pre_admitted' }));

    const subject = await resolveMeetingGuestSubject(RAW_TOKEN);

    expect(subject?.admission).toBe('pre_admitted');
  });
});
