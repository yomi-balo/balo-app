import { describe, expect, it, vi } from 'vitest';
import { jsonResponse, useDailyApiKey } from '../../test/mocks/daily.js';
import { DAILY_API_BASE } from './client.js';
import { DailyApiError } from './errors.js';
import {
  MIN_IDLE_TIMEOUT_SECONDS,
  deleteRecording,
  getRecordingAccessLink,
  startRoomRecording,
  stopRoomRecording,
} from './recordings.js';

const ROOM = 'balo-0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d';
const INSTANCE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const RECORDING_ID = 'daily-recording-id-1';

useDailyApiKey();

describe('startRoomRecording', () => {
  it('POSTs a body that deep-equals EXACTLY { instanceId, minIdleTimeOut: 60 } at the exact URL (OD-12)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { status: 'sent' }));
    vi.stubGlobal('fetch', fetchMock);

    await startRoomRecording(ROOM, { instanceId: INSTANCE_ID });

    expect(MIN_IDLE_TIMEOUT_SECONDS).toBe(60);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DAILY_API_BASE}/rooms/${ROOM}/recordings/start`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      instanceId: INSTANCE_ID,
      minIdleTimeOut: 60,
    });
  });

  it('rethrows a non-2xx — the caller (recording-ensure) decides retryability', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(400, { error: 'bad-room' })));

    await expect(startRoomRecording(ROOM, { instanceId: INSTANCE_ID })).rejects.toBeInstanceOf(
      DailyApiError
    );
  });

  it('percent-encodes the room name', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { status: 'sent' }));
    vi.stubGlobal('fetch', fetchMock);

    await startRoomRecording('balo room/1', { instanceId: INSTANCE_ID });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`${DAILY_API_BASE}/rooms/balo%20room%2F1/recordings/start`);
  });
});

describe('stopRoomRecording', () => {
  it('POSTs { instanceId } and reports `stopped` on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { status: 'sent' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(stopRoomRecording(ROOM, { instanceId: INSTANCE_ID })).resolves.toBe('stopped');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DAILY_API_BASE}/rooms/${ROOM}/recordings/stop`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ instanceId: INSTANCE_ID });
  });

  it('maps a 400 to `nothing_to_stop` — OD-7: Daily may have already auto-stopped', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(400, { error: 'not-recording' }))
    );

    await expect(stopRoomRecording(ROOM, { instanceId: INSTANCE_ID })).resolves.toBe(
      'nothing_to_stop'
    );
  });

  it('maps a 404 to `nothing_to_stop` — OD-7: the room may already be torn down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, { error: 'not-found' })));

    await expect(stopRoomRecording(ROOM, { instanceId: INSTANCE_ID })).resolves.toBe(
      'nothing_to_stop'
    );
  });

  it('rethrows a 500 — the job retries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, { error: 'boom' })));

    await expect(stopRoomRecording(ROOM, { instanceId: INSTANCE_ID })).rejects.toBeInstanceOf(
      DailyApiError
    );
  });
});

describe('getRecordingAccessLink', () => {
  it('parses { download_link, expires } and returns downloadLink + expiresAt', async () => {
    const expiresUnix = 1_700_000_000;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          download_link: 'https://daily-download.example/abc',
          expires: expiresUnix,
        })
      )
    );

    const result = await getRecordingAccessLink(RECORDING_ID);

    expect(result.downloadLink).toBe('https://daily-download.example/abc');
    expect(result.expiresAt).toEqual(new Date(expiresUnix * 1000));
  });

  it('hits the exact URL', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { download_link: 'https://x', expires: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    await getRecordingAccessLink(RECORDING_ID);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DAILY_API_BASE}/recordings/${RECORDING_ID}/access-link`);
    expect(init.method).toBe('GET');
  });

  it('⚠⚠ THROWS on a body missing `download_link` — never hands Mux `undefined`', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { expires: 1 })));

    await expect(getRecordingAccessLink(RECORDING_ID)).rejects.toBeInstanceOf(DailyApiError);
  });

  it('throws on a body missing `expires`', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { download_link: 'https://x' }))
    );

    await expect(getRecordingAccessLink(RECORDING_ID)).rejects.toBeInstanceOf(DailyApiError);
  });

  it('throws on a non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, { error: 'not-found' })));

    await expect(getRecordingAccessLink(RECORDING_ID)).rejects.toBeInstanceOf(DailyApiError);
  });
});

describe('deleteRecording', () => {
  it('issues DELETE and reports `deleted`', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { deleted: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(deleteRecording(RECORDING_ID)).resolves.toBe('deleted');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DAILY_API_BASE}/recordings/${RECORDING_ID}`);
    expect(init.method).toBe('DELETE');
  });

  it('maps 404 to `already_gone` — the D4 cleanup precedent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, { error: 'not-found' })));

    await expect(deleteRecording(RECORDING_ID)).resolves.toBe('already_gone');
  });

  it('rethrows any other non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, { error: 'boom' })));

    await expect(deleteRecording(RECORDING_ID)).rejects.toBeInstanceOf(DailyApiError);
  });
});
