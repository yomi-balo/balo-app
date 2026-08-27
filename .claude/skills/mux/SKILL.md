---
name: mux
description: >
  How Balo drives Mux — the video storage and playback vendor chosen in ADR-1013 (+ its
  2026-07-14 amendment: Daily-native recording → Mux; Recall external-only). Covers asset
  creation from a Daily access link, the signed-playback JWT, the `passthrough` correlation
  key, the webhook signature (HEX — not base64), and the five `MUX_*` env vars. Use when
  implementing or changing any Mux work. Trigger on: Mux, mux-node, `@mux/mux-node`, video
  asset, playback id, signed playback, playback policy, passthrough, `Mux-Signature`,
  `video.asset.ready`, `MUX_SIGNING_KEY_ID`, `MUX_WEBHOOK_SECRET`, recording ingest.
  NOT for: the recap playback UI's rendering (BAL-440 — it consumes the URL this skill
  produces), Daily-side capture (`daily-co` skill), or Recall.ai external-venue capture (a
  different vendor entirely).
---

# Mux Integration Skill

Mux is Balo's video **storage and playback** vendor (ADR-1013). It is not a capture vendor:
Daily records the consultation, and Mux ingests that recording, transcodes it, and serves it
back under a **signed** playback URL. Shipped by BAL-473.

**Asset creation and webhook receipt are `apps/api`-only, structurally** — nothing in
`apps/web`'s dependency graph can reach `apps/api`'s services, and no client-reachable payload
ever carries a Mux **asset** id, a Daily recording id, or a download link.

⚠ **SIGNING runs in `apps/web` too, as of BAL-440** — this is the one narrower claim this file
used to make and no longer does. `apps/web/src/lib/mux/playback.ts` is a SECOND signer, next to
`apps/api/src/services/mux/playback.ts`, because the recap's read gate
(`authorizeMeetingFileAccess`) is `apps/web`-only with no `apps/api` counterpart — see BAL-440's
plan §2 for the full rejection of the alternatives (a Fastify route; hoisting the whole signer,
SDK included, into `@balo/shared`). The TTL bounds, the TTL-for-duration policy, the two URL
templates, AND (as of fix round 1) the option-shaping + URL-building routine itself are hoisted
into `@balo/shared/meetings` (`mux-playback-policy.ts`, PURE, zero imports) so the two signers
cannot drift; each app hands its own `jwt.signPlaybackId` in as a callback, so only the vendor
SDK client construction and key-reading exist twice. Only `MUX_SIGNING_KEY_ID` /
`MUX_SIGNING_KEY_PRIVATE` — never `MUX_TOKEN_*` or `MUX_WEBHOOK_SECRET` — are provisioned on
Vercel, because `apps/web` neither creates assets nor receives webhooks.

## Flow

```
Daily cloud recording
  └─ recording.ready-to-download ──▶ meeting_recordings: source_ready
        └─ recording-ingest (BullMQ)
             ├─ GET /recordings/:id/access-link      (Daily — minted INSIDE the job, short-lived)
             └─ POST /video/v1/assets                (Mux — inputs + signed policy + passthrough)
                  └─ meeting_recordings: ingesting, mux_asset_id stamped
                       └─ video.asset.ready (webhook) ──▶ ready, mux_playback_id + duration + ready_at
                            └─ recording-cleanup-source ──▶ DELETE /recordings/:id on Daily
```

The Daily source is **never** deleted before `ready` — it is the only thing a failed ingest can
retry from (BAL-473 D4).

## Settled config — do not re-derive these

| Setting               | Value                         | Why                                                                                                                                      |
| --------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `video_quality`       | `'basic'`                     | Cheapest tier. Replaces the deprecated `encoding_tier`. Values: `basic \| plus \| premium`.                                              |
| `max_resolution_tier` | **NOT SENT**                  | ⚠ There is **no 720p tier**. Values are `1080p \| 1440p \| 2160p` and the default is `1080p` — omitting it inherits the cheapest option. |
| `playback_policy`     | `['signed']`                  | ⚠ **Never `'public'`.** See the traps.                                                                                                   |
| `passthrough`         | `meeting_recordings.id`       | The only correlation Mux hands back on the webhook. Set it on every create.                                                              |
| `inputs`              | `[{ url }]` — **plural**      | ⚠ `input` (singular) is deprecated.                                                                                                      |
| Signing algorithm     | RS256                         | The only value Mux accepts. Key id travels as `keyid` → `kid`.                                                                           |
| `aud` claim           | `'v'` video · `'t'` thumbnail | Two different audiences; a video token will not sign a thumbnail.                                                                        |
| Signed-URL TTL        | default 1h, ceiling 2h        | Short by policy — a leaked URL should stop working quickly.                                                                              |

## Traps that bite

1. ⚠⚠ **The webhook digest is HEX. Daily's is base64.** Both are HMAC-SHA256 over
   `` `${timestamp}.${rawBody}` ``, so a **round-trip test passes under either encoding** and
   proves nothing. Pin both suites against a **fixed vector**. This is the single most likely
   place for a silent bug in this integration.
2. **The Mux secret is a plain string.** Daily's is base64-encoded and must be decoded before
   use. Copying the Daily verifier and changing the digest encoding is not enough — the key
   handling differs too.
3. **Asset id ≠ playback id, and the difference is a security boundary.** The **asset id** is an
   API handle (it can delete the asset) and must never reach a client. The **playback id** is
   inert without a signed token, and is the only one that may travel.
4. **A `public` playback policy makes `stream.mux.com/{playbackId}.m3u8` playable by anyone
   holding the id, forever, with no way to revoke short of deleting the asset.** Consultations
   are private. Always `['signed']`.
5. **`passthrough` is the only correlation you get.** Mux's webhook does not know about
   `meetings`. If you forget it, the only fallback is `mux_asset_id`, and a create that failed
   before the id was stamped is unrecoverable.
6. **The Daily access link is short-lived.** Mint it **inside** the ingest job, never at webhook
   time and never persisted. `GET /recordings/:id/access-link` returns `{ download_link, expires }`
   — `expires` is unix seconds, so log the returned value rather than assuming a TTL.

## Errors & idempotency

- `recording-ingest` no-ops when `mux_asset_id` is already stamped — the create is not replayed.
- Retry/backoff on `429` and `5xx`. A non-retryable `4xx` throws `UnrecoverableError` so BullMQ
  stops at one attempt.
- Exhausted retries → `meeting_recordings.status = 'failed'` with `failed_stage = 'mux_ingest'`
  via `worker.on('failed')`.
- `video.asset.errored` → `failed`, `failed_stage = 'mux_asset'`.
- ⚠ A late vendor error **never** un-publishes a `ready` row — `markFailed` refuses on
  `status = 'ready'`. BAL-440 may already be rendering it.
- Vendor error text goes to `failure_reason` (capped) and `log.error`, **never to PostHog** —
  a vendor error body is arbitrary text and can contain a signed URL. The analytics event
  carries a closed `RecordingFailureReason` union instead.

## Webhooks

`POST /webhooks/mux` — its own route plugin, its own `fastify-raw-body` registration, its own
rate-limit budget. Nothing is inherited from the Daily route.

- Header: `Mux-Signature: t=<unix_seconds>,v1=<hex>`
- Tolerance: 5 minutes
- Verification: `Webhooks.verifySignature` from `@mux/mux-node` — it uses WebCrypto and is
  therefore **async**, unlike the Daily verifier.
- Marker table `mux_webhook_events`, append-only, unique on the Mux event id. Replays
  short-circuit before the transaction; a concurrent duplicate loses the unique index.
- Handled: `video.asset.ready`, `video.asset.errored`. Everything else acks `200` and records a
  marker — an unhandled type must never `500`, or Mux's retry queue eventually disables the
  endpoint and takes the handled types down with it.

## Env topology

Five vars total. All five are on the Railway API service (`apps/api` has **no env schema** —
access is bare `process.env.X`, so each var's absent-key behaviour is documented at its
declaration in `apps/api/.env.example` **and** the var is listed in root `turbo.json`
`globalEnv`. Both places are required). As of BAL-440, **two** of the five — the signing pair —
are ALSO provisioned on **Vercel** (`apps/web/.env.example`), because `apps/web/src/lib/mux/
playback.ts` is the second signer. The other three (`MUX_TOKEN_*`, `MUX_WEBHOOK_SECRET`) stay
Railway-only, since `apps/web` neither creates assets nor receives webhooks.

| Var                       | Where                | Absent ⇒                                                                                                                                                                                                                           |
| ------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MUX_TOKEN_ID`            | Railway only         | `getMuxClient()` throws; every `recording-ingest` fails and rows stall at `source_ready`. The Daily source is retained, so re-drivable.                                                                                            |
| `MUX_TOKEN_SECRET`        | Railway only         | as above                                                                                                                                                                                                                           |
| `MUX_WEBHOOK_SECRET`      | Railway only         | `POST /webhooks/mux` answers **503** to every delivery. Assets still transcode; nothing ever reaches `ready`; the source is never cleaned up.                                                                                      |
| `MUX_SIGNING_KEY_ID`      | Railway **+ Vercel** | Each app's `signedPlaybackUrl()` / `signedThumbnailUrl()` throws. Ingest unaffected. On Vercel: the poster mint fails soft (`posterUrl: null`) and the playback mint toasts an error — the recap page still renders, nothing 500s. |
| `MUX_SIGNING_KEY_PRIVATE` | Railway **+ Vercel** | as above. Store the base64 PEM Mux hands out, verbatim, in both places.                                                                                                                                                            |

Registering the webhook endpoint is a **once-per-environment ops step**, not something code does.

## ⚠ ADR-1013's cost table is stale

It predates Mux's 2024 tier rename and still reasons in terms of a 720p tier that no longer
exists. BAL-473 did **not** edit the ADR — refreshing it is a tracked follow-up. Do not quote
that table as current pricing.

## Not this skill

- **Recap playback UI** — BAL-440 (shipped). This skill produces the signed URL (now from
  BOTH apps, see above); BAL-440's `apps/web` components (`RecordingBlock`,
  `RecordingPlayerDialog`) render it, attach `hls.js` for non-Safari browsers, and fire the
  playback analytics event. The mint's Server Action and mapper live under
  `apps/web/src/app/(dashboard)/meetings/[meetingId]/_actions/` and `_lib/`.
- **Daily-side capture** — the `daily-co` skill's `## Recording` section.
- **Recall.ai** — external-venue capture, a different vendor, not Mux.
- **Retention / deletion sweeps** — out of scope of BAL-473, tracked separately.

## Live docs

| Topic                | URL                                                       |
| -------------------- | --------------------------------------------------------- |
| Create an asset      | `https://www.mux.com/docs/api-reference`                  |
| Signed playback URLs | `https://www.mux.com/docs/guides/secure-video-playback`   |
| Webhook signatures   | `https://www.mux.com/docs/core/verify-webhook-signatures` |
| Node SDK             | `https://github.com/muxinc/mux-node-sdk`                  |
