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

| Scenario                          | Call                                               | Balo specifics                                                                                                                                                                                                                                                                                |
| --------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provision room (BAL-129)          | `POST /rooms`                                      | `name` from `meetings.id` + `privacy:'private'` **top-level**; rest under `properties`. No `enable_knocking`. Make it idempotent on the name (see Errors & idempotency).                                                                                                                      |
| Update room config                | `POST /rooms/:name`                                | overrides an existing room's config (e.g. reconcile `exp`/privacy) without recreating it.                                                                                                                                                                                                     |
| Mint token at admission (BAL-132) | `POST /meeting-tokens`                             | all fields under `properties`; values from the config table.                                                                                                                                                                                                                                  |
| Validate a token                  | `GET /meeting-tokens/:token`                       | returns decoded claims — assert them in the smoke test.                                                                                                                                                                                                                                       |
| Self-sign (optional)              | JWT signed with the API key                        | skips the round-trip; short-form claim keys (`r`,`o`,`d`,`u`,`exp`,`nbf`). Keep one minting helper so REST and self-signed can't drift. Default to REST.                                                                                                                                      |
| Presence — one guest              | `GET /rooms/:name/presence?userId=<participantId>` | the admitted-not-arrived check; primary "arrived" signal is still `meeting_presence` (BAL-134).                                                                                                                                                                                               |
| Presence — all rooms              | `GET /presence`                                    | active participants grouped by room; Daily's recommended "current state" endpoint (not `/meetings`).                                                                                                                                                                                          |
| Eject participant (BAL-436)       | `POST /rooms/:name/eject`                          | body `{ ids?, user_ids?, ban? }` (max 100 each). Eject by `user_ids` = the participantId. The token stays valid, so pass `ban: true` to block rejoin (or simply don't re-mint).                                                                                                               |
| Recording                         | `enable_recording` on room/token                   | modes `'cloud' \| 'cloud-audio-only' \| 'local' \| 'raw-tracks'`. Auto-start via token `start_cloud_recording` (needs `enable_recording:'cloud'`), or client `startRecording()`; stop via `POST /rooms/:name/recordings/stop`. Bucket config: see the recording docs — don't assume defaults. |
| Cleanup                           | expiry, or `DELETE /rooms/:name`                   | an expiring room auto-deletes after `exp` **once all participants have left**.                                                                                                                                                                                                                |

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

**Events Balo consumes:** `participant.joined` and `participant.left` (the presence writer), plus
`meeting.ended`, which closes every open interval for the room when the last participant leaves.
Any other type is acknowledged `200` and recorded, never processed.

**Idempotency:** the event's **`id` attribute is the key**, persisted in `daily_webhook_events`
(append-only, unique on `event_id`, mirroring `stripe_webhook_events`). `processed_at` is stamped
**inside** the effect transaction, so a persisted marker always implies a committed effect. This
is not optional bookkeeping: a replayed `participant.joined` after its interval legitimately
closed would open a second interval anchored in the past that nothing closes — a silent unbounded
over-bill on a money path.

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
