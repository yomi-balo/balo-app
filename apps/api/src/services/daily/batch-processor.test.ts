import { describe, expect, it, vi } from 'vitest';
import { jsonResponse, useDailyApiKey } from '../../test/mocks/daily.js';
import { DAILY_API_BASE } from './client.js';
import { DailyApiError } from './errors.js';
import {
  MAX_BATCH_ARTEFACT_BYTES,
  fetchBatchArtefactJson,
  getBatchJobTranscriptLink,
  submitTranscriptBatchJob,
} from './batch-processor.js';

const DAILY_RECORDING_ID = 'daily-recording-id-1';
const JOB_ID = '02c2508e-8835-4f3e-bcf2-e319d00f0eec';

useDailyApiKey();

describe('submitTranscriptBatchJob', () => {
  it('POSTs the EXACT §2 body at the exact URL and returns the job id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: JOB_ID }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await submitTranscriptBatchJob({ dailyRecordingId: DAILY_RECORDING_ID });

    expect(result).toBe(JOB_ID);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DAILY_API_BASE}/batch-processor`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      preset: 'transcript',
      inParams: {
        sourceType: 'recordingId',
        recordingId: DAILY_RECORDING_ID,
        language: 'en',
      },
      outParams: { s3Config: { s3KeyTemplate: 'transcript' } },
    });
  });

  it('⚠⚠ throws DailyApiError when the body carries no usable job id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, {})));

    await expect(
      submitTranscriptBatchJob({ dailyRecordingId: DAILY_RECORDING_ID })
    ).rejects.toBeInstanceOf(DailyApiError);
  });

  it('rethrows a non-2xx — the caller (transcript-capture submit) decides retryability', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(400, { error: 'bad-request' })));

    await expect(
      submitTranscriptBatchJob({ dailyRecordingId: DAILY_RECORDING_ID })
    ).rejects.toBeInstanceOf(DailyApiError);
  });
});

describe('getBatchJobTranscriptLink', () => {
  it('picks the `json` entry from transcription[] and returns its `link`', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          id: JOB_ID,
          preset: 'transcript',
          status: 'finished',
          transcription: [
            { format: 'txt', link: 'https://example.test/txt' },
            { format: 'json', link: 'https://example.test/json' },
          ],
        })
      )
    );

    const result = await getBatchJobTranscriptLink(JOB_ID, 'json');

    expect(result).toBe('https://example.test/json');
  });

  it('hits the exact URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        transcription: [{ format: 'json', link: 'https://example.test/json' }],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await getBatchJobTranscriptLink(JOB_ID, 'json');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DAILY_API_BASE}/batch-processor/${JOB_ID}/access-link`);
    expect(init.method).toBe('GET');
  });

  it('⚠⚠ throws when no `json` entry exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          transcription: [{ format: 'txt', link: 'https://example.test/txt' }],
        })
      )
    );

    await expect(getBatchJobTranscriptLink(JOB_ID, 'json')).rejects.toBeInstanceOf(DailyApiError);
  });

  it('throws on a body missing `transcription`', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, {})));

    await expect(getBatchJobTranscriptLink(JOB_ID, 'json')).rejects.toBeInstanceOf(DailyApiError);
  });

  it('propagates a 400 (job not finished) and a 404 (unknown job) as DailyApiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(400, { error: 'not-finished' })));
    await expect(getBatchJobTranscriptLink(JOB_ID, 'json')).rejects.toBeInstanceOf(DailyApiError);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, { error: 'not-found' })));
    await expect(getBatchJobTranscriptLink(JOB_ID, 'json')).rejects.toBeInstanceOf(DailyApiError);
  });

  /** ⚠ No test in this suite may assert a link VALUE reaching a logger — this module logs
   *  nothing at all, by construction (grep confirms no `createLogger` import here). The
   *  caller (`jobs/transcript-capture.ts`) is where that discipline is actually exercised. */
});

describe('fetchBatchArtefactJson', () => {
  it('fetches, size-checks and JSON.parses the artefact', async () => {
    // ⚠ `jsonResponse` is deliberately a 4-member stand-in scoped to `dailyRequest`'s needs
    // (its own docblock says so) — `.headers` is added HERE, locally, rather than widening
    // that shared helper for the one caller (M6) that reads Content-Length.
    const fetchMock = vi.fn().mockResolvedValue({
      ...jsonResponse(200, { results: { channels: [] } }),
      headers: new Headers(),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchBatchArtefactJson('https://example.test/signed-artefact');

    expect(result).toEqual({ results: { channels: [] } });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://example.test/signed-artefact');
  });

  it('throws DailyApiError on a non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, { error: 'boom' })));

    await expect(fetchBatchArtefactJson('https://example.test/x')).rejects.toBeInstanceOf(
      DailyApiError
    );
  });

  it('⚠⚠ refuses an artefact larger than MAX_BATCH_ARTEFACT_BYTES', async () => {
    const hugeText = 'a'.repeat(MAX_BATCH_ARTEFACT_BYTES + 1);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => hugeText,
      } as unknown as Response)
    );

    await expect(fetchBatchArtefactJson('https://example.test/x')).rejects.toThrow(/exceeded/);
  });

  it('⚠⚠ FIX ROUND 1 (M6) — refuses on a lying Content-Length BEFORE reading the body', async () => {
    const textFn = vi.fn().mockResolvedValue('{}');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': String(MAX_BATCH_ARTEFACT_BYTES + 1) }),
        text: textFn,
      } as unknown as Response)
    );

    await expect(fetchBatchArtefactJson('https://example.test/x')).rejects.toThrow(/exceeded/);
    // ⚠ THE WHOLE POINT — the body is never materialised when the header alone is enough.
    expect(textFn).not.toHaveBeenCalled();
  });

  it('a Content-Length within the cap is not refused up front — the post-read guard still runs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': '2' }),
        text: async () => '{}',
      } as unknown as Response)
    );

    await expect(fetchBatchArtefactJson('https://example.test/x')).resolves.toEqual({});
  });

  it('⚠ a MISSING Content-Length falls through to the post-read guard as the backstop', async () => {
    const hugeText = 'a'.repeat(MAX_BATCH_ARTEFACT_BYTES + 1);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => hugeText,
      } as unknown as Response)
    );

    await expect(fetchBatchArtefactJson('https://example.test/x')).rejects.toThrow(/exceeded/);
  });

  it('throws on unparseable JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => 'not json',
      } as unknown as Response)
    );

    await expect(fetchBatchArtefactJson('https://example.test/x')).rejects.toThrow();
  });
});
