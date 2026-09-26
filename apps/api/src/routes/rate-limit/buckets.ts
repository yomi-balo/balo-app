import type { RateLimitBucket } from '@balo/shared/rate-limit';
import type { RateLimitConfig } from '../../lib/rate-limiter.js';

/**
 * BAL-461 — the bucket NUMBERS behind `POST /rate-limit/check`. Deliberately `apps/api`-only:
 * `@balo/shared/rate-limit` closes the bucket NAME tuple so both sides agree on what a bucket is
 * called, but the `max`/`windowSeconds` policy behind each name is server policy that must never
 * be sent to or read by the client, and changing a limit must never require a web deploy.
 *
 * Every `keyPrefix` is `ratelimit:web:<bucket>:user` — `checkRateLimit` appends
 * `:<actorUserId>` itself (`rate-limiter.ts`) — and none collides with an existing
 * `ratelimit:*` prefix used by the other limiters in this file's family
 * (`ratelimit:probe`, `ratelimit:session-statement:user`, `brief-parse`, …).
 *
 * `Record<RateLimitBucket, RateLimitConfig>` forces a config for every bucket name at compile
 * time — adding a name to the shared tuple without adding an entry here is a type error, not a
 * runtime surprise. `buckets.test.ts`'s "the key set equals RATE_LIMIT_BUCKETS" case is the
 * runtime mirror of that guarantee.
 *
 * All windows are 60 seconds.
 */
export const WEB_RATE_LIMIT_BUCKET_CONFIGS: Record<RateLimitBucket, RateLimitConfig> = {
  /**
   * `postMeetingMessageAction`. A fast human in live chat sends at most ~15–20 messages a
   * minute, so 30 gives 1.5–2× headroom. This is the most expensive write in the family (an
   * INSERT, a `markThreadRead` upsert, and a publish), so it gets the tightest bucket.
   */
  'meeting-chat-post': {
    keyPrefix: 'ratelimit:web:meeting-chat-post:user',
    maxRequests: 30,
    windowSeconds: 60,
  },
  /**
   * `fetchMeetingThreadAction`. One call each time the panel mounts, plus "Try again", plus
   * "Show earlier" pages of 30 rows — paging back through a 600-message thread is 20 calls.
   */
  'meeting-chat-read': {
    keyPrefix: 'ratelimit:web:meeting-chat-read:user',
    maxRequests: 60,
    windowSeconds: 60,
  },
  /**
   * `sendMeetingReactionAction`. Set above one tab's own cooldown ceiling
   * (60 000 / `REACTION_SEND_COOLDOWN_MS` 600 = 100, `use-meeting-realtime.ts:344`), so a single
   * tab tapping flat out is never refused. The key is per user, so several tabs or devices
   * tapping at the ceiling, or queued arrivals, CAN still be refused — never write "never
   * refused" unqualified. The refusal is quiet and the reaction float stays, the same as a tap
   * the client-side cooldown itself coalesces.
   */
  'meeting-reaction': {
    keyPrefix: 'ratelimit:web:meeting-reaction:user',
    maxRequests: 120,
    windowSeconds: 60,
  },
  /**
   * `createMeetingRealtimeTokenAction`. One call per connection open, plus one per 15-minute TTL
   * refresh, plus reloads and tabs. Honest use stays at roughly 5 or fewer per minute, and a
   * refusal self-heals — ably-js retries a non-403 refusal rather than failing the connection.
   */
  'meeting-realtime-token': {
    keyPrefix: 'ratelimit:web:meeting-realtime-token:user',
    maxRequests: 30,
    windowSeconds: 60,
  },
  /**
   * The three typing actions (case, project and in-call), through `relayTypingSignal` — ONE
   * bucket across all three surfaces, because a person types in one composer at a time. The
   * honest ceiling is at most ~80 per minute on one surface, and several tabs cost about what
   * one does. A false refusal costs 30 seconds of the typing indicator.
   */
  'typing-signal': {
    keyPrefix: 'ratelimit:web:typing-signal:user',
    maxRequests: 120,
    windowSeconds: 60,
  },
  /**
   * The proposal PDF route. Honest use is 1–5 downloads a minute (one per proposal, plus the
   * share menu). The render itself is cached, so what a request costs beyond this gate is the
   * invocation, not a fresh render.
   */
  'proposal-pdf': {
    keyPrefix: 'ratelimit:web:proposal-pdf:user',
    maxRequests: 30,
    windowSeconds: 60,
  },
};
