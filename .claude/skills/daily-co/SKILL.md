---
name: daily-co
description: >
  How to drive Daily (daily.co) from Balo's backend: provision rooms, mint meeting
  tokens at admission, reconcile presence/identity, eject, and record. Balo uses the Call
  Object SDK with a custom UI (not Daily Prebuilt) and calls Daily's REST API directly (no
  broker). Use when implementing or changing any server-side Daily work. Trigger on:
  Daily, daily.co, meeting token, room provisioning, JoinGrant, roomUrl, participantId,
  enable_knocking, Daily recording. NOT for: the in-call client UI (daily-react hooks =
  BAL-435), Ably chat (BAL-437), or Recall.ai external-venue capture (separate vendor).
---

# Daily Integration Skill

Daily is Balo's V1 meeting venue (ADR-1043 meeting primitive). Balo uses the **Call Object
SDK** (`@daily-co/daily-js` + `@daily-co/daily-react`) with a **custom UI — not Prebuilt**,
and calls Daily's **REST API directly** (Fastify + `DAILY_API_KEY`, async on BullMQ). No
Membrane/broker.

Server side only here — rooms, tokens, presence, eject, recording. The in-call client
mount is **BAL-435**. Recall.ai (external-venue capture) is a separate vendor and pipeline.

## Flow

```
provision (BAL-129)   POST /rooms  → store roomName + roomUrl on the meeting   [at scheduling]
                      private room, NO enable_knocking

admit → mint (BAL-132)  host admits (row flips) → guest's next poll mints:
                        POST /meeting-tokens → return JoinGrant ONCE
                        (no token exists before admission — that IS the gate)

join (BAL-435)        client validates grant → call.join({ url, token })
presence (BAL-134)    client participant events → meeting_presence  (the "arrived" signal)
record (optional)     enable_recording on room/token
cleanup               room auto-deletes after exp once all participants leave, or DELETE /rooms/:name
```

## Settled config — apply these values

| Thing                      | Value                                                    | Pointer        |
| -------------------------- | -------------------------------------------------------- | -------------- |
| Room `privacy`             | `'private'` (top-level on create)                        | admission gate |
| Room `exp`                 | ≥ the token `exp` (else joins fail)                      | BAL-129        |
| Room `enable_knocking`     | **not set** — gate is token issuance, not Daily knocking | BAL-132        |
| Token `room_name`          | always the meeting's room                                | required       |
| Token `exp`                | `scheduled_end + 24h`                                    | BAL-132        |
| Token `eject_at_token_exp` | `false`                                                  | BAL-132        |
| Token `is_owner`           | host `true`, guest `false`                               | BAL-132        |
| Token `user_id`            | participantId — `'u'\|'g'` + 32 hex                      | BAL-132        |
| Where tokens are minted    | server-side only; API key never client-side              | —              |

The client-facing grant is the `JoinGrant` in `@balo/shared/meetings`
(`{ roomUrl, token, isOwner, expiresAt, participantId }`) — reuse it; Zod-validate `roomUrl`
against `*.daily.co` before any join.

## Scenarios → endpoint

Base URL `https://api.daily.co/v1`; `Authorization: Bearer $DAILY_API_KEY` on every call.

| Scenario                          | Call                                               | Balo specifics                                                                                                                                                                                                                                                                               |
| --------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provision room (BAL-129)          | `POST /rooms`                                      | `name` from `meetings.id` + `privacy:'private'` **top-level**; rest under `properties`. No `enable_knocking`. Make it idempotent on the name (see Errors & idempotency).                                                                                                                     |
| Update room config                | `POST /rooms/:name`                                | overrides an existing room's config (e.g. reconcile `exp`/privacy) without recreating it.                                                                                                                                                                                                    |
| Mint token at admission (BAL-132) | `POST /meeting-tokens`                             | all fields under `properties`; values from the config table.                                                                                                                                                                                                                                 |
| Validate a token                  | `GET /meeting-tokens/:token`                       | returns decoded claims — assert them in the smoke test.                                                                                                                                                                                                                                      |
| Self-sign (optional)              | JWT signed with the API key                        | skips the round-trip; short-form claim keys (`r`,`o`,`d`,`u`,`exp`,`nbf`). Keep one minting helper so REST and self-signed can't drift. Default to REST.                                                                                                                                     |
| Presence — one guest              | `GET /rooms/:name/presence?userId=<participantId>` | the admitted-not-arrived check; primary "arrived" signal is still `meeting_presence` (BAL-134).                                                                                                                                                                                              |
| Presence — all rooms              | `GET /presence`                                    | active participants grouped by room; Daily's recommended "current state" endpoint (not `/meetings`).                                                                                                                                                                                         |
| Eject participant (BAL-436)       | `POST /rooms/:name/eject`                          | body `{ ids?, user_ids?, ban? }` (max 100 each). Eject by `user_ids` = the participantId. The token stays valid, so pass `ban: true` to block rejoin (or simply don't re-mint).                                                                                                              |
| Recording (BAL-473)               | `POST /rooms/:name/recordings/start`               | ⚠ **Server-side start on the `in_progress` transition — NOT token `start_cloud_recording`, NOT client `startRecording()`** (BAL-473 D1). Room needs `enable_recording:'cloud'` under `properties`. Stop via `POST /rooms/:name/recordings/stop`. Full detail in the Recording section below. |
| Cleanup                           | expiry, or `DELETE /rooms/:name`                   | an expiring room auto-deletes after `exp` **once all participants have left**.                                                                                                                                                                                                               |

## Request bodies

Create room — `name` and `privacy` are **top-level**; everything else nests under `properties`:

```json
{
  "name": "<derived from meetings.id>",
  "privacy": "private",
  "properties": {
    "exp": 1699999999,
    "eject_at_room_exp": false,
    "max_participants": 10,
    "enable_recording": "cloud"
  }
}
```

Mint token — **all** fields under `properties`:

```json
{
  "properties": {
    "room_name": "<the meeting's room>",
    "exp": 1699999999,
    "eject_at_token_exp": false,
    "is_owner": true,
    "user_name": "Ada Lovelace",
    "user_id": "u3f9a1c...<32 hex total>"
  }
}
```

Assemble the grant (return the token exactly once; never log/persist it plaintext):

```ts
const { token } = await dailyFetch('POST', '/meeting-tokens', { properties });
const grant: JoinGrant = {
  roomUrl, // https://<DAILY_DOMAIN>/<room> — must be ∈ *.daily.co
  token, // live credential — return once, never log/persist/URL it
  isOwner, // === properties.is_owner
  expiresAt, // === properties.exp (scheduled_end + 24h)
  participantId, // === properties.user_id
};
```

## Identity & reconciliation

The token's `user_id` is Balo's participantId (`'u'|'g'` + 32 hex). Live, it's on
`participants()` and participant events; after the session it's on `GET /meetings`. That's
how Daily's session/analytics rows map back to a Balo user or guest — so never mint without
it, and it's the same value you eject by (`user_ids`) and filter presence by (`userId`).
(HIPAA caveat, doesn't bite Balo: on HIPAA domains a UUID `user_id` returns as a UUID; the
participantId isn't a UUID, so it round-trips verbatim — don't reshape it into one.)

## Traps that bite

- **`name`/`privacy` are top-level on `POST /rooms`; all token props nest under `properties`.** Nesting either wrong silently changes the config.
- **A token without `room_name` grants every room in the domain.** Always set it.
- **The token is a decodable JWT** (signed, not encrypted): never log, persist plaintext, render in the DOM, or put in a URL; never put anything secret in `user_id`/`user_name`.
- **`eject_at_token_exp:true` locks a user out of a private room at token expiry** — that's why Balo keeps it `false` with a long `exp`.
- **Prebuilt-only props are no-ops here** (custom Call Object app): `enable_prejoin_ui`, `enable_recording_ui`, closed-caption / live-caption tray, `enable_chat`, Prebuilt emoji — Daily's docs mark these "Prebuilt only". Balo re-implements the equivalents. Access/permission props (`is_owner`, `enable_screenshare`, `start_video_off/audio_off`, `enable_recording`, `exp`, `room_name`, `user_id`, `user_name`) do apply.
- **Invalid tokens fail silently on join** — assert claims in tests; don't wait for a runtime error.
- **Eject alone doesn't revoke the token** — a removed participant can rejoin with the same token unless you `ban:true` or don't re-mint.

## Errors & idempotency

Verified against Daily's REST error model and rate-limit tiers:

- **Auth errors:** missing `Authorization` header → **400** `error: "authorization-header-error"`; bad key → **401** `error: "authentication-error"`. Error bodies carry `{ error, info }`.
- **Rate limits (tiered), per key per route** — retry `429` with exponential backoff:
  - Most (room create/delete/list, presence, eject, stop recording): **20/s (100 per 5s)**.
  - **Batch** room create/delete: **~10 per 30s** (tighter — matters for bulk provisioning).
  - **Starting** a recording / live stream / dial-out: **~1/s (5 per 5s)**.
  - Analytics + listing recordings: **~2/s (50 per 30s)**.
- **Idempotent provisioning** (deterministic room name): `GET /rooms/:name` → on **404**, `POST /rooms`; if it already exists, treat as provisioned (optionally `POST /rooms/:name` to reconcile config). Don't assume a create succeeds blindly, and don't error the BullMQ job on a name that's already there.
- **`4xx` other than 429** (400 bad body / 401 bad key) → a config or payload bug, not retryable — fail the job loudly.

## Webhooks

Verified against `docs.daily.co/reference/rest-api/webhooks` (fetched **2026-08-15**). Balo's
whole scheme lives in one module — `apps/api/src/services/daily/webhook-signature.ts` — so a
vendor correction costs one file plus its test.

**Registration is a one-off per-environment OPS step, not application code.** `POST /v1/webhooks`
with the delivery URL; the response's **`hmac` field is the signing secret** and is what goes into
`DAILY_WEBHOOK_SECRET`. Nothing at runtime creates or rotates a webhook.

**Verification:**

- Headers are `X-Webhook-Signature` and `X-Webhook-Timestamp` — read them **lower-cased**
  (`x-webhook-signature` / `x-webhook-timestamp`); Fastify normalises header names.
  `X-Webhook-Timestamp` is unix **seconds**.
- Signing string is `X-Webhook-Timestamp + '.' + <raw body bytes>`. **Raw bytes, never a
  re-serialized body** — `JSON.parse` + `JSON.stringify` reorders keys and normalises whitespace,
  so a round-tripped body verifies against nothing. Register `fastify-raw-body` **scoped**
  (`global: false`, `encoding: false`, `runFirst: true`), never globally.
- HMAC-SHA256. **The secret is base64 — decode it to raw bytes before keying.** Keying on the
  base64 _text_ matches nothing.
- ⚠⚠ **THE RESULTING DIGEST IS BASE64, NOT HEX.** A hex digest fails **every genuine delivery**
  with a perfectly healthy-looking `400`: nothing errors, nothing pages, presence is simply never
  written and both clocks sit at zero. ⚠ A sign-then-verify round-trip test passes under _either_
  encoding, so pin the digest against a **fixed vector** — a round-trip alone ships the bug.
- `crypto.timingSafeEqual`, never `===`; it throws on unequal lengths, so length-check first. A
  **duplicated** header (an array) is a refusal, not a "take the first".
- Enforce a **freshness window** (Balo: ±5 min, symmetric) on the timestamp, so a captured
  delivery cannot be replayed forever. The timestamp being _inside_ the signed string is what
  binds it to the body.
- The failure reason is a **`log.warn` field**; the wire gets `400` and nothing else. A missing
  secret is a **`503`** (an outage), never a `400` — a `400` tells Daily to stop retrying.

**Events Balo consumes:** `participant.joined` / `participant.left` (the presence writer) and
`meeting.ended` (closes every open interval for the room); the three recording arms
`recording.started` / `recording.ready-to-download` / `recording.error` (see **Recording**); and
the two batch arms `batch-processor.job-finished` / `batch-processor.error` (see
**Transcription**). Any other type is acknowledged `200` and recorded, never processed.

⚠ The subscription enumerates its `eventTypes` explicitly (`POST /v1/webhooks`), so **a new arm
in `HANDLED_DAILY_EVENT_TYPES` does nothing until the per-environment subscription is
updated** — a silent, all-green failure.

**Idempotency:** the event's **`id` attribute is the key**, persisted in `daily_webhook_events`
(append-only, unique on `event_id`, mirroring `stripe_webhook_events`). `processed_at` is stamped
**inside** the effect transaction, so a persisted marker always implies a committed effect. This
is not optional bookkeeping: a replayed `participant.joined` after its interval legitimately
closed would open a second interval anchored in the past that nothing closes — a silent unbounded
over-bill on a money path.

## Recording (BAL-473)

Balo records **every** Balo Video consultation (BAL-473 D5 — always-on, no per-meeting or
per-expert switch). The recording is a platform artefact for the recap and for disputes, not a
participant preference. Notice is given in the lobby and by a persistent in-call pill.

### ⚠⚠ The event payloads — verified against docs.daily.co on 2026-08-25

**This table is the most valuable thing in this section. The payloads are not symmetric, and
assuming they are will cost you a build cycle.**

| Event                         | Payload fields (verbatim)                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `recording.started`           | `recording_id`, `action`, `layout`, `started_by`, `instance_id`, `start_ts` — ⚠ **NO `room_name`**    |
| `recording.ready-to-download` | `recording_id`, `room_name`, `start_ts`, `status`, `max_participants`, `duration`, `s3_key`, `tracks` |
| `recording.error`             | `action`, `error_msg`, `instance_id`, `room_name`, `timestamp` — ⚠ **NO `recording_id`**              |

Envelope on all three: `version`, `type`, `id`, `payload`, `event_ts`.

**Because `recording.started` names no room, a webhook arm CANNOT resolve a meeting from it, and
therefore cannot create the row.** That is why Balo's `recording-ensure` job inserts
`meeting_recordings` _before_ calling start, and passes its own row id as `instanceId`:

- `instanceId` is a **request parameter you supply** (a UUID). Balo sets it to
  `meeting_recordings.id`, which doubles as the Mux `passthrough`. No extra correlation column.
- `recording.started` resolves by `instance_id` and stamps `daily_recording_id`.
- `ready-to-download` resolves by `recording_id`, falling back to `room_name` — which is what
  makes a dropped `recording.started` cost nothing.
- `recording.error` resolves by `instance_id`.

### Endpoints

| Call                                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /rooms/:name/recordings/start` | ⚠ Returns **`{"status":"sent"}` and never the recording id**. Body keys are **camelCase**: `instanceId`, `minIdleTimeOut`, `maxDuration`, `type`, `layout`.                                                                                                                                                                                                                                                                              |
| `POST /rooms/:name/recordings/stop`  | Nothing-to-stop is **success** — Daily may have auto-stopped, or the room may already be gone.                                                                                                                                                                                                                                                                                                                                           |
| `GET /recordings/:id/access-link`    | → `{ download_link, expires }`, `expires` in unix seconds. ⚠ Short-lived — mint **inside** the ingest job, never at webhook time, never persist it.                                                                                                                                                                                                                                                                                      |
| `DELETE /recordings/:id`             | → `{ deleted: true, id }`; **404 when absent — treat as success**, same as `deleteRoom`'s 404.                                                                                                                                                                                                                                                                                                                                           |
| `POST /rooms/:name`                  | The **reconcile** call, made only on `createOrFindRoom`'s already-exists path. ⚠ **Fix round 2** — it does NOT reach a meeting whose venue is already stamped: `provisionMeeting`'s replay guard short-circuits with zero vendor calls before `createOrFindRoom` is ever called, so this never runs for the pre-deploy population. It only fixes a room hit on the re-provision path (a concurrent duplicate, or a repair re-provision). |

### `minIdleTimeOut`

Daily's default is **300s**, and shutdown takes a further 1–3 minutes. "Idle" means all
participants have muted video **and** audio — it is not the same as "the room emptied". Balo sets
**60**. Set it explicitly; inheriting the default silently widens the window in which a recording
keeps running over a call nobody is on.

⚠ A wrong body key is **silently ignored** by Daily — no error, just a recording that quietly used
the defaults. Pin the request body with a deep-equal unit test.

### Retention

> "Recordings are stored in the Daily cloud until a Daily domain owner deletes them through the
> REST API or through the dashboard."

Recordings are **domain-scoped and deleted only explicitly**. Balo deletes the source only after
Mux reports `ready`, never before — the Daily copy is the only thing a failed ingest can retry
from.

⚠ **Still smoke-test-gated, not proven:** whether a recording survives `DELETE /rooms/:name`
_specifically_. BAL-473 is designed so that either answer is survivable (stop treats
nothing-to-stop as success; cleanup treats 404 as success), but do not assert survival as fact
until the live smoke test shows it.

### Rate limits

⚠ Starting a recording sits in a much tighter tier than most calls: **~1/s (5 per 5s)**, against
20/s for room and token operations. One start per meeting is fine; a retry storm is not.

## Transcription (BAL-483)

Balo transcribes **post-call**, via Daily's **Batch Processor**, off the `recordingId` the
recording ladder already produces. There is **no real-time transcription** — no
`transcription/start`, no `transcription/stop`, no `transcript.*` webhook arm, and **no room
property**. `enable_transcription_storage` governs REAL-TIME storage only and Balo sets it
nowhere; **do not touch `rooms.ts` for transcription.**

Why post-call: real-time stores **WebVTT only**, which cannot carry `confidence` or a
participants map; the Batch Processor emits **Deepgram-native `json`**, which can. It is also
~2.7× cheaper at Balo's two-party shape (per recorded minute vs per unmuted participant minute).

⚠ **Transcription is NOT always-on, unlike recording.** `transcripts.engagement_id` is
`NOT NULL`, and three of the seven `meeting_context_type` labels (`project_discovery`,
`request_interaction`, `admin`) name no engagement. A recorded segment on such a meeting is a
clean, logged no-op — no batch job is submitted.

### The submit call

`POST /batch-processor` — the ONE body Balo sends. Pin it with a deep-equal unit test.

```json
{
  "preset": "transcript",
  "inParams": {
    "sourceType": "recordingId",
    "recordingId": "<daily recording id>",
    "language": "en"
  },
  "outParams": { "s3Config": { "s3KeyTemplate": "transcript" } }
}
```

⚠ **It returns the job id SYNCHRONOUSLY** — `{ "id": "02c2508e-…" }` — unlike
`recordings/start`, which returns `{"status":"sent"}` and no id. That id is the **entire**
correlation model: it is stamped on `meeting_recordings.transcript_job_id` and it is how the
completion webhook finds its way home.

⚠ **`s3Config`, capital `C`.** The docs' parameter table writes `s3config`; every example, the
`get-job` response, the access-link response and the webhook payload use `s3Config`.

⚠ **There is NO caller-supplied correlation token.** No `instanceId` equivalent exists. The only
caller-controlled string that survives is `outParams.s3Config.s3KeyTemplate`, echoed inside the
output S3 key — Balo does not use it.

⚠ **UNVERIFIABLE: whether the batch schema is `additionalProperties: false`.** The endpoint is
documented as prose, not OpenAPI. So the standing warning in **Recording** — "a wrong body key is
silently ignored by Daily" — is **NOT known to hold here**, and it is definitely FALSE for
real-time `transcription/start` (whose spec IS strict, so a wrong key is _rejected_). Send only
documented keys; never speculate a knob.

⚠ **UNVERIFIABLE: whether the recording must be fully processed first.** Balo never tests it —
the submit fires off `recording.ready-to-download`, i.e. only once the artefact exists.

### ⚠⚠ The event payloads — verified against docs.daily.co on 2026-09-02

| Event                          | Payload fields (verbatim)                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `batch-processor.job-finished` | `id` (the **job** id), `preset`, `status`, `input`, `output` — ⚠ **NO `room_name`, NO `instance_id`, NO `mtg_session_id`** |
| `batch-processor.error`        | `id`, `preset`, `status`, `input`, `error`, `output: {}` — same absences                                                   |

Envelope on both: `version`, `type`, `id`, `payload`, `event_ts`.

⚠ Both webhook **examples** use `sourceType: "uri"`, so `payload.input.recordingId` is
**inferred from `GET /batch-processor/:id`'s documented response, not shown on the webhook**.
Balo treats it as a FALLBACK only, and refuses it for a row already owned by a different job.

### Endpoints

| Call                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /batch-processor`                | ⚠ Returns `{ "id": … }` **synchronously**. `400` → `{ error, info }`.                                                                                                                                                                                                                                                                                                                                          |
| `GET /batch-processor/:id/access-link` | → `{ id, preset, status, transcription: [{format, link}], summary? }`. The key is **`link`** (schema and example agree — unlike `/transcript/:id/access-link`, which contradicts itself). **`400` when status ≠ `finished`** (retryable); `404` unknown job (terminal). ⚠ **No TTL is documented and no `expires` field is returned** — mint inside the ingest job on every attempt, never persist, never log. |
| `GET /batch-processor/:id`             | `{ id, preset, status, input: {sourceType, recordingId?, uri?}, output, error? }`. `status ∈ {submitted, processing, finished, error}`. The recovery path if a webhook is missed.                                                                                                                                                                                                                              |
| `DELETE /batch-processor/:id`          | Deletes the job and its output. Balo does not call it.                                                                                                                                                                                                                                                                                                                                                         |

### Output formats

`txt`, `srt`, `vtt`, **`json`** — all four are produced for every `transcript` job. Balo fetches
**`json`** and nothing else.

⚠⚠ **THE JSON IS DEEPGRAM-NATIVE, AND ITS SPEAKERS ARE ORDINALS, NOT IDENTITIES.**
`results.channels[0].alternatives[0].words[]` carries `{ word, start, end, confidence, speaker,
speaker_confidence, punctuated_word }`. `speaker` is `0 | 1 | …`. **There is no `user_id`, no
participant id and no session id anywhere in the artefact** — the recording is a composited
single-channel mix, so no per-participant track exists. Balo maps ordinal _n_ to the stable ref
`speaker-n` with `source: 'diarized'` and `userId: null`; a turn with no `speaker` maps to the
synthetic `'unknown'` ref. **The recap therefore cannot name who said what.** The only known path
to real attribution is raw-tracks recording, which is a BAL-473-level change.

Diarization is **on by default** for this preset — Daily's own documented sample output carries
`speaker`/`speaker_confidence` with no parameter set. Balo passes no diarization knob.

### Storage

⚠ **No prerequisite.** "By default, batch processor outputs are stored with Daily's
HIPAA-compliant storage." The only knob is the optional **domain** property
`batch_processor_bucket` (⚠ **Amazon S3 only** — unlike `recordings_bucket` /
`transcription_bucket`, it cannot be pointed at OCI). Balo sets none.

⚠ **The one config that would silently break every job:** if `recordings_bucket` was set on the
domain or the room when a recording was made, the **domain**'s `recordings_bucket` must MATCH
when that recording id is passed to the batch processor. Balo sets no `recordings_bucket`
anywhere (`rooms.ts` sends only `enable_recording`), so this is inert today.

### ⚠⚠ The batch job DOWNLOADS the recording — do not delete it underneath

`DELETE /recordings/:id` while a batch job is in flight produces Daily's documented
`"Failed to download: 403 Forbidden"` and permanently loses that segment's transcript.
`recording-cleanup-source` therefore withholds deletion while
`transcript_job_submitted_at IS NOT NULL AND transcript_job_finished_at IS NULL`, and both batch
terminal arms re-enqueue it.

### Plan tier

`Paid plans only` — the same tier the recording already requires.

## Not this skill

- **`enable_knocking`** — Balo's admission gate is token issuance (BAL-132); native knocking contradicts it. If a ticket reaches for it, escalate rather than wire it.
- **Client SDK mount** (DailyProvider, VideoStage, device hooks) → BAL-435.
- **Recall.ai** external-venue capture → separate vendor/pipeline.
- **Deciding when to provision or who to admit** → engagement/admission lanes, not here.

## Testing

- Mint against a **non-prod Daily domain** (test key below prod).
- Smoke test = mint a token, decode the JWT, assert `room_name` / `user_id` / `exp` / `is_owner`, then `GET /meeting-tokens/:token` to confirm — as an integration test **and** a runnable live script outside CI (mock-only doesn't prove the vendor boundary).
- Unit tests assert the request body Balo sends (property names, config-table values).

## Live docs (authority for current fields)

Index: `https://docs.daily.co/llms.txt`. This file pins Balo's _values_; the docs are the
source of truth for _current field names and full property tables_ — read them at implement
time rather than hand-copying tables here.

| Scenario                                 | Page                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| REST overview: errors + rate-limit tiers | docs.daily.co/reference/rest-api                                               |
| Create room + properties                 | docs.daily.co/reference/rest-api/rooms/create-room                             |
| Update room config                       | docs.daily.co/reference/rest-api/rooms/set-room-config                         |
| Create meeting token + properties        | docs.daily.co/reference/rest-api/meeting-tokens/create-meeting-token           |
| Token config (Prebuilt-only flags noted) | docs.daily.co/reference/rest-api/meeting-tokens/config                         |
| Self-signing tokens                      | docs.daily.co/reference/rest-api/meeting-tokens/self-signing-tokens            |
| Validate token                           | docs.daily.co/reference/rest-api/meeting-tokens/validate-meeting-token         |
| Eject                                    | docs.daily.co/reference/rest-api/rooms/eject                                   |
| Webhooks: create, signature, event list  | docs.daily.co/reference/rest-api/webhooks                                      |
| Presence (per-room)                      | docs.daily.co/reference/rest-api/rooms/get-room-presence                       |
| Presence (all rooms)                     | docs.daily.co/reference/rest-api/presence                                      |
| Stop recording                           | docs.daily.co/reference/rest-api/rooms/recordings/stop                         |
| Controlling who joins (knocking)         | docs.daily.co/docs/guides/privacy-and-security/controlling-who-joins-a-meeting |
| daily-react (client — BAL-435 scope)     | docs.daily.co/reference/daily-react                                            |
