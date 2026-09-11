import { describe, it, expect, vi, beforeEach } from 'vitest';
import { log } from '@/lib/logging';

const { mockCallSessionApi } = vi.hoisted(() => ({ mockCallSessionApi: vi.fn() }));

vi.mock('@/lib/credit/api-client', () => ({
  callSessionApi: mockCallSessionApi,
}));

import { requestAdminRedrive } from './admin-redrive';

describe('requestAdminRedrive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('200 → ok: true with the result, and hits the redrive route', async () => {
    const result = {
      kind: 'recording-ingest',
      entityId: 'rec-1',
      auditEventId: 'audit-1',
      jobId: 'recording-ingest--rec-1--redrive-audit-1',
    };
    mockCallSessionApi.mockResolvedValue({ ok: true, status: 200, data: result });

    expect(await requestAdminRedrive('recording-ingest', 'rec-1')).toEqual({ ok: true, result });
    expect(mockCallSessionApi).toHaveBeenCalledWith(
      '/admin/redrive/recording-ingest/rec-1',
      'POST'
    );
  });

  it('403 → forbidden, and logs a warning (never an error)', async () => {
    mockCallSessionApi.mockResolvedValue({ ok: false, status: 403, error: 'forbidden' });
    const result = await requestAdminRedrive('recording-ingest', 'rec-1');
    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    expect(log.warn).toHaveBeenCalledWith('Admin re-drive denied to a staff viewer', {
      kind: 'recording-ingest',
      entityId: 'rec-1',
    });
  });

  it('409 → not_redrivable', async () => {
    mockCallSessionApi.mockResolvedValue({ ok: false, status: 409, error: 'not_redrivable' });
    expect(await requestAdminRedrive('recording-ingest', 'rec-1')).toEqual({
      ok: false,
      reason: 'not_redrivable',
    });
  });

  it('502 → enqueue_failed', async () => {
    mockCallSessionApi.mockResolvedValue({ ok: false, status: 502, error: 'enqueue_failed' });
    expect(await requestAdminRedrive('transcript-pipeline', 'tr-1')).toEqual({
      ok: false,
      reason: 'enqueue_failed',
    });
  });

  it('503 → unavailable', async () => {
    mockCallSessionApi.mockResolvedValue({ ok: false, status: 503, error: 'redrive_unavailable' });
    expect(await requestAdminRedrive('recording-ingest', 'rec-1')).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('transport error (status 0) → unavailable', async () => {
    mockCallSessionApi.mockResolvedValue({ ok: false, status: 0, error: 'Something went wrong.' });
    expect(await requestAdminRedrive('recording-ingest', 'rec-1')).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('never collapses distinct failures to the same reason', async () => {
    mockCallSessionApi.mockResolvedValueOnce({ ok: false, status: 409, error: 'not_redrivable' });
    const notRedrivable = await requestAdminRedrive('recording-ingest', 'rec-1');
    mockCallSessionApi.mockResolvedValueOnce({ ok: false, status: 502, error: 'enqueue_failed' });
    const enqueueFailed = await requestAdminRedrive('recording-ingest', 'rec-1');
    expect(notRedrivable).not.toEqual(enqueueFailed);
  });
});
