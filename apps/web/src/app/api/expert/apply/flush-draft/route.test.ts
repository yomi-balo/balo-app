import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────

const mockSaveDraftAction = vi.fn();
vi.mock('@/app/(apply)/expert/apply/_actions/save-draft', () => ({
  saveDraftAction: (...args: unknown[]) => mockSaveDraftAction(...args),
}));

// `@/lib/logging` is auto-mocked in src/test/setup.ts.

import { POST } from './route';

// ── Helpers ─────────────────────────────────────────────────────

const URL = 'http://localhost:3000/api/expert/apply/flush-draft';
const PROFILE_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

function makeRequest(body: unknown, { raw = false }: { raw?: boolean } = {}): Request {
  return new Request(URL, {
    method: 'POST',
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

// ── Tests ───────────────────────────────────────────────────────

describe('POST /api/expert/apply/flush-draft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards the parsed body to saveDraftAction and returns its result (200)', async () => {
    const result = { success: true, expertProfileId: PROFILE_ID };
    mockSaveDraftAction.mockResolvedValue(result);

    const payload = {
      step: 'profile',
      data: { yearStartedSalesforce: 2019 },
      expertProfileId: PROFILE_ID,
    };
    const res = await POST(makeRequest(payload));

    expect(res.status).toBe(200);
    expect(mockSaveDraftAction).toHaveBeenCalledWith(payload);
    await expect(res.json()).resolves.toEqual(result);
  });

  it('forwards a body without expertProfileId (profile-step create path)', async () => {
    mockSaveDraftAction.mockResolvedValue({ success: true, expertProfileId: PROFILE_ID });

    const payload = { step: 'terms', data: { termsAccepted: true } };
    const res = await POST(makeRequest(payload));

    expect(res.status).toBe(200);
    expect(mockSaveDraftAction).toHaveBeenCalledWith(payload);
  });

  it('maps an Unauthorized throw to 401', async () => {
    mockSaveDraftAction.mockRejectedValue(new Error('Unauthorized'));

    const res = await POST(makeRequest({ step: 'profile', data: {} }));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ success: false, error: 'Unauthorized' });
  });

  it('returns 400 for a malformed (invalid step) body', async () => {
    const res = await POST(makeRequest({ step: 'bogus-step', data: {} }));

    expect(res.status).toBe(400);
    expect(mockSaveDraftAction).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({ success: false, error: 'flush_failed' });
  });

  it('returns 400 for invalid JSON', async () => {
    const res = await POST(makeRequest('not-json{', { raw: true }));

    expect(res.status).toBe(400);
    expect(mockSaveDraftAction).not.toHaveBeenCalled();
  });
});
