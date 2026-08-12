import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPostGuestJoin = vi.fn();
vi.mock('@/lib/meetings/join-api-client', () => ({
  postGuestJoin: (...args: unknown[]) => mockPostGuestJoin(...args),
}));

import { pollGuestAdmissionAction } from './poll-guest-admission';
import { JOIN_TEMPORARILY_UNAVAILABLE_TITLE, JOIN_UNAVAILABLE_TITLE } from '@/lib/meetings/lobby';

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const GUEST_TOKEN = 'z'.repeat(43);

const GRANT = {
  roomUrl: 'https://balo.daily.co/balo-0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d',
  token: 'daily.jwt.value',
  isOwner: false,
  expiresAt: '2026-09-02T11:00:00.000Z',
  participantId: 'g555555555555455585555555555555555',
};

const VALID = { meetingId: MEETING_ID, guestToken: GUEST_TOKEN };

beforeEach(() => {
  vi.clearAllMocks();
  mockPostGuestJoin.mockResolvedValue({ ok: true, data: { state: 'waiting' } });
});

describe('pollGuestAdmissionAction — the two success states', () => {
  it('returns `waiting` with NO grant while pending', async () => {
    await expect(pollGuestAdmissionAction(VALID)).resolves.toEqual({
      success: true,
      state: 'waiting',
    });
  });

  it('⚠ a `waiting` result carries no credential of any kind', async () => {
    // A `pending` guest has NO Daily token in existence anywhere — Decision 2. If one ever
    // appeared in this shape, the queue would have stopped being enforced by token issuance.
    const result = await pollGuestAdmissionAction(VALID);

    expect(JSON.stringify(result)).not.toContain('token');
    expect(JSON.stringify(result)).not.toContain('roomUrl');
  });

  it('returns the grant once admitted', async () => {
    mockPostGuestJoin.mockResolvedValue({ ok: true, data: { state: 'admitted', grant: GRANT } });

    await expect(pollGuestAdmissionAction(VALID)).resolves.toEqual({
      success: true,
      state: 'admitted',
      grant: GRANT,
    });
  });

  it('forwards the token in the BODY position, never as part of a path', async () => {
    await pollGuestAdmissionAction(VALID);

    expect(mockPostGuestJoin).toHaveBeenCalledWith(MEETING_ID, GUEST_TOKEN);
  });
});

describe('pollGuestAdmissionAction — validation', () => {
  it.each([
    ['a non-uuid meeting id', { ...VALID, meetingId: 'nope' }],
    ['a too-short token', { ...VALID, guestToken: 'abc' }],
    ['an over-long token', { ...VALID, guestToken: 'x'.repeat(201) }],
  ])('refuses %s WITHOUT calling the api', async (_label, input) => {
    const result = await pollGuestAdmissionAction(input);

    expect(result).toMatchObject({ success: false, title: JOIN_UNAVAILABLE_TITLE });
    expect(mockPostGuestJoin).not.toHaveBeenCalled();
  });

  it('⚠ a malformed STORED token reads as a dead one, not as a form error', async () => {
    // Unlike the lobby form, this input is not something the visitor typed — it came from
    // sessionStorage or a URL. "Your input is invalid" would be meaningless and confusing.
    const result = await pollGuestAdmissionAction({ ...VALID, guestToken: 'abc' });

    expect(result).toEqual({
      success: false,
      retryable: false,
      status: 400,
      title: JOIN_UNAVAILABLE_TITLE,
    });
  });

  it('⚠ a malformed stored token is NOT retryable — re-sending the same bad value helps nobody', async () => {
    const result = await pollGuestAdmissionAction({ ...VALID, guestToken: 'abc' });

    expect(result).toMatchObject({ success: false, retryable: false });
  });
});

/**
 * ⚠⚠ THE FIX FOR "EVERY POLL FAILURE IS TERMINAL". The client cannot keep polling through a
 * blip unless this layer tells it which failures are worth retrying — and the whole 5s→15s
 * back-off exists to be run across a long wait, which it never could while a single dropped
 * packet ended the wait.
 */
describe('⚠⚠ pollGuestAdmissionAction — retryable vs terminal', () => {
  it.each([
    ['a TRANSPORT failure (dropped connection)', 0, 'request_failed'],
    ['a 429 (we are asked to slow down, not to go away)', 429, 'rate_limited'],
    ['a 500', 500, 'request_failed'],
    ['a 503 (upstream mint outage)', 503, 'meeting_token_unavailable'],
  ])('marks %s RETRYABLE', async (_label, status, code) => {
    mockPostGuestJoin.mockResolvedValue({ ok: false, status, code });

    await expect(pollGuestAdmissionAction(VALID)).resolves.toMatchObject({
      success: false,
      retryable: true,
      status,
    });
  });

  it.each([
    ['a 404 — unknown / expired / revoked / DENIED token', 404, 'meeting_not_found'],
    ['a 409 — the meeting is not open for join', 409, 'meeting_not_open_for_join'],
  ])('marks %s TERMINAL', async (_label, status, code) => {
    mockPostGuestJoin.mockResolvedValue({ ok: false, status, code });

    await expect(pollGuestAdmissionAction(VALID)).resolves.toMatchObject({
      success: false,
      retryable: false,
      status,
    });
  });

  it('passes a 429`s Retry-After through, so the client can obey it', async () => {
    mockPostGuestJoin.mockResolvedValue({
      ok: false,
      status: 429,
      code: 'rate_limited',
      retryAfterSeconds: 42,
    });

    await expect(pollGuestAdmissionAction(VALID)).resolves.toMatchObject({
      retryAfterSeconds: 42,
    });
  });
});

describe('⚠⚠ pollGuestAdmissionAction — a DENIED guest is told nothing', () => {
  it.each([
    ['meeting_not_found (also: denied, revoked, expired, unknown)', 404, 'meeting_not_found'],
    ['meeting_not_open_for_join', 409, 'meeting_not_open_for_join'],
    ['rate_limited', 429, 'rate_limited'],
    ['a transport failure', 0, 'request_failed'],
    ['a 500', 500, 'request_failed'],
  ])('maps %s to the uniform copy', async (_label, status, code) => {
    mockPostGuestJoin.mockResolvedValue({ ok: false, status, code });

    await expect(pollGuestAdmissionAction(VALID)).resolves.toMatchObject({
      success: false,
      title: JOIN_UNAVAILABLE_TITLE,
    });
  });

  it('⚠⚠ a 429 STAYS COLLAPSED — it fires pre-authorization, so a distinct message would tell a scanner it is being counted', async () => {
    mockPostGuestJoin.mockResolvedValue({ ok: false, status: 429, code: 'rate_limited' });

    await expect(pollGuestAdmissionAction(VALID)).resolves.toMatchObject({
      title: JOIN_UNAVAILABLE_TITLE,
    });
  });

  it('⚠ a 503 is the ONE un-collapsed failure — reachable only AFTER a token resolved AND the bearer was admitted', async () => {
    mockPostGuestJoin.mockResolvedValue({
      ok: false,
      status: 503,
      code: 'meeting_token_unavailable',
    });

    const result = await pollGuestAdmissionAction(VALID);

    expect(result).toMatchObject({ title: JOIN_TEMPORARILY_UNAVAILABLE_TITLE });
    // ⚠ AND IT STILL NAMES NOTHING — no meeting, no reason, no vendor.
    expect(JSON.stringify(result)).not.toContain(MEETING_ID);
    expect(JSON.stringify(result)).not.toMatch(/daily|denied|cancelled/i);
  });

  it('⚠ never says "denied" — that would confirm both that the meeting is real and that a human refused', async () => {
    mockPostGuestJoin.mockResolvedValue({ ok: false, status: 404, code: 'meeting_not_found' });

    const result = await pollGuestAdmissionAction(VALID);

    expect(JSON.stringify(result)).not.toMatch(/denied|rejected|refused/i);
  });

  it('produces ONE distinct TITLE across every collapsed failure', async () => {
    // ⚠ The TITLE is what a visitor sees; `status`/`retryable` never reach the DOM and exist
    // only to select behaviour. Asserting on the whole object would pin the wrong property.
    const titles = new Set<string>();
    for (const [status, code] of [
      [404, 'meeting_not_found'],
      [409, 'meeting_not_open_for_join'],
      [429, 'rate_limited'],
      [0, 'request_failed'],
    ] as const) {
      mockPostGuestJoin.mockResolvedValue({ ok: false, status, code });
      const result = await pollGuestAdmissionAction(VALID);
      titles.add(result.success ? 'unexpected-success' : result.title);
    }

    expect(titles).toEqual(new Set([JOIN_UNAVAILABLE_TITLE]));
  });
});
