/**
 * BAL-483 (§8.1) — the Daily **Batch Processor** REST calls: submit a `transcript` job for one
 * finished recording, mint a short-lived access link to its `json` output, and fetch the
 * artefact itself. The submit + access-link calls go through the shared `dailyRequest` seam
 * (`client.ts`); the artefact download is the ONE exception — it is a signed S3 URL, not a Daily
 * API path — and is a bare `fetch` with `AbortSignal.timeout`, matching `client.ts`'s own posture.
 *
 * ⚠ THIS MODULE DOES NOT TOUCH `meeting_recordings`. Same discipline as `recordings.ts`: a thin,
 * injectable Daily REST wrapper. The state machine lives in
 * `packages/db/src/repositories/meeting-recordings.ts`, driven by `jobs/transcript-capture.ts`
 * and the webhook arms in `routes/daily/webhook.ts`.
 */
import { z } from 'zod';
import { dailyRequest } from './client.js';
import { DailyApiError } from './errors.js';

/**
 * BAL-483 — a distinguishable error for the {@link MAX_BATCH_ARTEFACT_BYTES} refusal, so the
 * ingest job's error classifier can tell "the artefact is too big" apart from a JSON parse
 * failure or a transient fetch fault without parsing a message string.
 */
export class BatchArtefactTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Daily batch-processor artefact exceeded ${maxBytes} bytes — refusing to parse`);
    this.name = 'BatchArtefactTooLargeError';
  }
}

/**
 * ⚠ A 60-minute Deepgram JSON is ~1–2 MB; 25 MB is two orders of magnitude of headroom and
 * still bounds a pathological body. Enforced on the FETCHED bytes, terminal (not a warning) —
 * an artefact this size is not a consultation transcript.
 */
export const MAX_BATCH_ARTEFACT_BYTES = 25 * 1024 * 1024;

/** ⚠ Mandatory, like `DAILY_REQUEST_TIMEOUT_MS` — Node's `fetch` has no default timeout. */
export const BATCH_ARTEFACT_FETCH_TIMEOUT_MS = 30_000;

/** `POST /batch-processor`'s `200` body — just the job id. */
const submitJobResponseSchema = z.object({ id: z.string().min(1) });

/**
 * `POST /batch-processor` — submit a `transcript` job for one Daily recording.
 *
 * ⚠ UNLIKE `recordings/start`, THIS RETURNS THE JOB ID SYNCHRONOUSLY (`{ "id": "…" }`). That
 * id is the ENTIRE correlation model for BAL-483: neither batch webhook carries a room, an
 * instance id or a session id.
 *
 * ⚠ SENDS ONLY DOCUMENTED KEYS. Whether the batch schema is `additionalProperties: false` is
 * UNVERIFIABLE (the endpoint is documented as prose, not OpenAPI), so — unlike `recordings/*`,
 * where a wrong key is silently ignored — a speculative knob may fail the call outright. No
 * `transformParams`; the documented defaults already produce diarized JSON with confidence.
 *
 * ⚠ `s3Config`, CAPITAL `C`. The parameter table on the docs page writes `s3config`; all five
 * request examples, the get-job response, the access-link response and the webhook payload use
 * `s3Config`. The examples win.
 */
export async function submitTranscriptBatchJob(input: {
  dailyRecordingId: string;
}): Promise<string> {
  const path = '/batch-processor';
  const body = await dailyRequest<unknown>('POST', path, {
    preset: 'transcript',
    inParams: {
      sourceType: 'recordingId',
      recordingId: input.dailyRecordingId,
      language: 'en',
    },
    outParams: { s3Config: { s3KeyTemplate: 'transcript' } },
  });
  const parsed = submitJobResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new DailyApiError(
      'POST',
      path,
      0,
      'Daily POST /batch-processor returned a body with no usable job id'
    );
  }
  return parsed.data.id;
}

/** `GET /batch-processor/{jobId}/access-link`'s body — permissive about the rest, strict about
 *  what is used. */
const batchAccessLinkSchema = z.object({
  transcription: z.array(z.object({ format: z.string(), link: z.string().min(1) })).min(1),
});

/**
 * `GET /batch-processor/{jobId}/access-link` → the signed URL for ONE output format.
 * ZOD-PARSED, NOT CAST (the `getRecordingAccessLink` discipline) — this drives a fetch whose
 * body reaches the transcript pipeline, so a wrong shape must not arrive as `undefined`.
 *
 * ⚠ NO TTL IS DOCUMENTED AND NO `expires` FIELD IS RETURNED (contrast
 * `GET /recordings/:id/access-link`). Mint on EVERY attempt; never persist; never log.
 * `400` = "job status is not finished" (retryable); `404` = unknown job id (terminal) —
 * both propagate to the caller as a raw `DailyApiError` for it to classify.
 */
export async function getBatchJobTranscriptLink(jobId: string, format: 'json'): Promise<string> {
  const path = `/batch-processor/${encodeURIComponent(jobId)}/access-link`;
  const body = await dailyRequest<unknown>('GET', path);
  const parsed = batchAccessLinkSchema.safeParse(body);
  if (!parsed.success) {
    throw new DailyApiError(
      'GET',
      path,
      0,
      'Daily GET /batch-processor/:id/access-link returned a body this platform cannot interpret'
    );
  }
  const entry = parsed.data.transcription.find((o) => o.format === format);
  if (entry === undefined) {
    throw new DailyApiError(
      'GET',
      path,
      0,
      `Daily GET /batch-processor/:id/access-link returned no \`${format}\` transcript output`
    );
  }
  return entry.link;
}

/**
 * Fetch + size-cap + `JSON.parse` one batch artefact. Bare `fetch` — a signed S3 URL, not a
 * Daily API path. ⚠ NEVER log the url. Throws `DailyApiError` on a non-2xx response and a
 * plain `Error` when the body exceeds {@link MAX_BATCH_ARTEFACT_BYTES} or fails to parse.
 */
export async function fetchBatchArtefactJson(link: string): Promise<unknown> {
  const response = await fetch(link, {
    signal: AbortSignal.timeout(BATCH_ARTEFACT_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new DailyApiError(
      'GET',
      '/batch-processor-artefact',
      response.status,
      await response.text()
    );
  }
  // ⚠⚠ FIX ROUND 1 (M6) — CHECKED BEFORE THE BODY IS MATERIALISED. `response.text()` below reads
  // the ENTIRE body into memory before the post-read size guard ever runs, so that guard alone
  // bounds PARSING but not MEMORY — a huge body still gets fully buffered first. `Content-Length`
  // is vendor-supplied and can be absent or wrong, so this is a fast-path rejection, not a
  // replacement for the post-read guard below, which stays as the backstop for a missing or
  // lying header.
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_BATCH_ARTEFACT_BYTES) {
      throw new BatchArtefactTooLargeError(MAX_BATCH_ARTEFACT_BYTES);
    }
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BATCH_ARTEFACT_BYTES) {
    throw new BatchArtefactTooLargeError(MAX_BATCH_ARTEFACT_BYTES);
  }
  return JSON.parse(text) as unknown;
}
