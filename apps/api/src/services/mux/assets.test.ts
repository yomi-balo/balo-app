import { describe, expect, it, vi } from 'vitest';
import { jsonResponse, useMuxEnv } from '../../test/mocks/mux.js';
import { createSignedAssetFromUrl } from './assets.js';

const RECORDING_ID = '11111111-1111-4111-8111-111111111111';
const DOWNLOAD_URL = 'https://daily-download.example/source.mp4?sig=abc';

useMuxEnv();

function fakeAssetResponse(): Response {
  return jsonResponse(201, {
    data: {
      id: 'mux_asset_1',
      status: 'preparing',
      created_at: '1700000000',
      max_resolution_tier: '1080p',
    },
  });
}

describe('createSignedAssetFromUrl (BAL-473 §7 — the only video.assets.create call site)', () => {
  it('POSTs a body that deep-equals EXACTLY { inputs, playback_policy, passthrough, video_quality }', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeAssetResponse());
    vi.stubGlobal('fetch', fetchMock);

    await createSignedAssetFromUrl({ url: DOWNLOAD_URL, passthrough: RECORDING_ID });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      inputs: [{ url: DOWNLOAD_URL }],
      playback_policy: ['signed'],
      passthrough: RECORDING_ID,
      video_quality: 'basic',
    });
  });

  it('⚠ NEVER sends max_resolution_tier — inherits the account 1080p default', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeAssetResponse());
    vi.stubGlobal('fetch', fetchMock);

    await createSignedAssetFromUrl({ url: DOWNLOAD_URL, passthrough: RECORDING_ID });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('max_resolution_tier');
  });

  it('⚠ uses `inputs` (plural), never the deprecated singular `input`', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeAssetResponse());
    vi.stubGlobal('fetch', fetchMock);

    await createSignedAssetFromUrl({ url: DOWNLOAD_URL, passthrough: RECORDING_ID });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('input');
    expect(body).toHaveProperty('inputs');
  });

  it('POSTs to /video/v1/assets', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeAssetResponse());
    vi.stubGlobal('fetch', fetchMock);

    await createSignedAssetFromUrl({ url: DOWNLOAD_URL, passthrough: RECORDING_ID });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/video/v1/assets');
    expect(init.method).toBe('POST');
  });

  it('returns only the asset id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeAssetResponse()));

    await expect(
      createSignedAssetFromUrl({ url: DOWNLOAD_URL, passthrough: RECORDING_ID })
    ).resolves.toEqual({ id: 'mux_asset_1' });
  });
});
