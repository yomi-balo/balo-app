import { Queue, type QueueOptions } from 'bullmq';
import { getRedis } from './redis.js';

const queues = new Map<string, Queue>();

/**
 * Prefix on every {@link buildJobId} contract violation. STABLE AND GREPPABLE — exported so the
 * unit test can assert it verbatim rather than with `stringContaining`, and so an Axiom monitor
 * can be pointed at it later without re-deriving the wording.
 */
export const JOB_ID_CONTRACT_VIOLATION = 'BullMQ job id contract violation';

/**
 * `buildJobId` — THE ONLY WAY A CUSTOM BullMQ `jobId` MAY BE MINTED (BAL-531). Every hand-rolled
 * template literal at a `queue.add` call site is banned by the source-scan invariant at
 * `apps/api/src/invariants/colon-free-job-ids.test.ts`.
 *
 * BullMQ rejects most custom job ids containing `:` (`Custom Id cannot contain :` from
 * `queue.add`) — the precise rule is in THE ACTUAL BULLMQ RULE below; do not paraphrase it
 * from memory, that has gone wrong twice.
 *
 * Credit correlationIds are ledger idempotency keys, which `deriveIdempotencyKey` joins with
 * colons (`manual_purchase:{piId}`, `auto_topup:{walletId}:{entryId}`, …), so the rejected
 * shapes had never delivered a notification — surfacing only as a best-effort `log.error`
 * next to a committed money effect, which is exactly the shape that hides.
 *
 * ⚠ THE ESCAPE MUST BE INJECTIVE, or two distinct part-tuples collapse onto one job id and
 * BullMQ dedup silently drops a notification — the same silent-loss shape this fix exists to
 * remove.
 *
 * A bare `:` → `_` is not injective: every reason prefix already contains an underscore
 * (`manual_purchase`, `auto_topup`, `overdraft_settlement`), so it is collision-free only by
 * accident of the current prefix set.
 *
 * Escaping `_` → `__` first is ALSO not enough, because the replacement for `:` is then a
 * single `_` that merges with it: `a_:b` and `a:_b` both become `a___b`. "A lone `_` is a `:`,
 * a doubled `__` is a `_`" cannot be decoded on an odd run of three or more.
 *
 * So both escapes are TWO characters and the SECOND one disambiguates: `_` → `__`, `:` → `_c`.
 * Every `_` in the output opens a 2-char sequence, so decoding is unambiguous for any run
 * length — `a_:b` → `a___cb`, `a:_b` → `a_c__b`. This is structural, not a property of the
 * part values that happen to exist today. Applied UNIFORMLY to every part — not "only the
 * correlationId" as the deleted `toJobId` did — because a single escape scheme with two
 * different application rules is the seam a future call site gets wrong.
 *
 * THE ACTUAL BULLMQ RULE — read from the installed 5.70.4 source, after two rounds of this
 * comment claiming more than had been checked. `Job.addJob` throws only when
 * `jobId.includes(':') && jobId.split(':').length !== 3` — a carve-out kept for legacy
 * repeatable-job ids. So a jobId with EXACTLY two colons was accepted all along.
 *
 * Consequences, honestly scoped:
 *  · One-colon and three-plus-colon correlationIds (e.g. `manual_purchase:{pi}`,
 *    `overdraft_settlement:{session}`, `{id}:auto_accepted`, the review-nudge and
 *    dormancy-REMINDER ids) threw at `queue.add` — those had never been delivered. (The
 *    dormancy-EXPIRY id, `dormancy_expiry:{wallet}:{date}`, is a two-colon shape: it was
 *    delivering, and belongs to the rewritten set below.)
 *  · EXACTLY-two-colon ids (e.g. `auto_topup:{wallet}:{entry}`,
 *    `{userId}:onboarding_reminder:{step}`) were DELIVERING FINE, and this escape REWRITES
 *    their jobIds. A post-deploy re-publish therefore will not dedup against a retained
 *    pre-deploy job for that set: a bounded, one-time duplicate-notification window at the
 *    deploy boundary — accepted, since the alternative (preserving two-colon ids) would keep
 *    the escape non-injective and the dedup keys dependent on BullMQ's legacy carve-out.
 *  · Bare-UUID parts contain neither character and are untouched.
 *  · The dispatcher's event/template names (65 of 85 contain `_`) are now ALSO escaped, unlike
 *    before — an accepted, deliberate churn (BAL-531 D1): keeping the correlation-id half
 *    byte-identical mattered more than avoiding a rewrite of the event-name half.
 *
 * ⚠ Do NOT "optimise" this to escape only when a `:` is present. `a_cb` has no colon and would
 * pass through unchanged, while `a:b` would escape TO `a_cb` — a collision across the two sets.
 * The escape has to be unconditional to stay injective.
 *
 * ⚠ SEPARATOR: `--`, NOT ESCAPED, DELIBERATELY. Escaping `-` would rewrite every id in the
 * codebase (every UUID contains hyphens) for no benefit.
 *
 * ⚠⚠ THE TRUE PRECONDITION FOR THE JOIN TO BE UNAMBIGUOUS (corrected — an earlier draft of this
 * paragraph both misstated the precondition AND cited a non-example): no part except the LAST
 * may itself contain `--`, and no non-final part may END with `-` while the NEXT part BEGINS
 * with `-`. Two earlier claims here were wrong: "unambiguous given a fixed arity per call site,
 * which every call site has" is false (`calendar-subscription-reconcile.ts` and
 * `recording-cleanup-source.ts` call this with 2 OR 3 parts depending on a runtime branch), and
 * the cited "counter-example",
 * `buildJobId('a--b','c') === buildJobId('a','b--c')`, is not one — both sides are ARITY 2, so
 * it shows nothing about crossing arities. The real, TIGHTER collision needs no `--` inside
 * either part at all: `buildJobId('a-', 'b') === buildJobId('a', '-b')` (both `'a---b'`), fixed
 * arity on both sides — see `queue.test.ts`'s pinned example.
 *
 * Today the precondition holds, for a reason that has nothing to do with arity: every non-final
 * part in the tree is either a literal prefix (`'subscriptions'`, `'meeting-calendar-amend'`, …
 * — never ends in `-`) or a UUID (never leads or trails with `-`, by RFC 4122's fixed
 * hyphen positions). The one shipped correlation id that genuinely contains `--`
 * (`share-availability.ts`'s `{relationshipId}--{iso}--{ms}`) is safe ONLY because it is always
 * passed in the FINAL slot — the precondition explicitly permits that. Do NOT add a `--`- or
 * trailing-`-`-rejecting guard: it would throw on that shipped id and on every other id today,
 * for a collision that is a documented property of the scheme, not a live bug.
 *
 * ⚠ THE THROW IS A CANARY, NOT THE REAL ENFORCEMENT. After the escape, the result CANNOT
 * contain a colon — the throw guards against a future edit to the escape breaking that
 * invariant. It fires unconditionally, in every environment (it reads no `process.env`).
 *
 * The source-scan invariant (`apps/api/src/invariants/colon-free-job-ids.test.ts`) plus this
 * file's own unit tests are the PRIMARY enforcement — several enqueue call sites wrap `queue.add`
 * in a `catch` that logs and swallows, so a throw here would still be logged rather than crash
 * the process. But say this with the qualification the scan itself documents (see its own
 * docblock): it is a LINE-level text scan, and three shapes accidentally or adversarially defeat
 * it — a computed object key (`{ ['jobId']: x }`, now also caught, see below), a destructure-
 * rename plus shorthand (`const { id: jobId } = …` then `{ jobId }`), and a dynamically-built
 * key (`{ ['job' + 'Id']: x }`) combined with a spread. The scan is a strong deterrent against an
 * accidental hand-rolled template literal — the shape this ticket actually found three times in
 * production — not an airtight proof for a deliberately adversarial author.
 */
export function buildJobId(...parts: string[]): string {
  if (parts.length === 0) {
    throw new Error(`${JOB_ID_CONTRACT_VIOLATION}: buildJobId() called with no parts`);
  }

  const escaped = parts.map((part, index) => {
    if (part.length === 0) {
      throw new Error(`${JOB_ID_CONTRACT_VIOLATION}: part ${index} is empty`);
    }
    return part.replaceAll('_', '__').replaceAll(':', '_c');
  });

  const id = escaped.join('--');

  if (id.includes(':')) {
    throw new Error(`${JOB_ID_CONTRACT_VIOLATION}: "${id}" contains ':'`);
  }
  if (id === Number(id).toString()) {
    // BullMQ's SECOND custom-id rule, same `Job.addJob` block: an all-digit id is rejected as
    // `Custom Id cannot be integers` (`job.js:1032`, singular "Id" — quoted exactly; this
    // comment previously misquoted it as "Ids" and this docblock says elsewhere not to
    // paraphrase it from memory). No id here is all-digits today; the guard costs one line and
    // removes the whole class.
    //
    // ⚠ OUR PREDICATE IS DELIBERATELY STRICTER THAN UPSTREAM'S, NOT IDENTICAL TO IT. Upstream
    // guards with `` `${parseInt(id, 10)}` === id ``, which only rejects a STRICT integer
    // literal — `parseInt` truncates, so `'1.5'` → `1` → `'1' !== '1.5'` (upstream allows it) and
    // `'Infinity'` → `NaN` → `'NaN' !== 'Infinity'` (upstream allows that too). Our
    // `Number(id).toString()` form throws on BOTH. This is a one-directional divergence — we
    // never ACCEPT an id upstream would reject, we only reject a few upstream would accept — and
    // is kept deliberately fail-closed: no id in this codebase is, or should ever need to be,
    // a bare `'1.5'` or `'Infinity'`.
    throw new Error(`${JOB_ID_CONTRACT_VIOLATION}: "${id}" is an integer`);
  }

  return id;
}

const DEFAULT_JOB_OPTIONS: QueueOptions['defaultJobOptions'] = {
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
};

/**
 * Returns a shared BullMQ Queue for the given name.
 * Creates it on first call and caches for subsequent use.
 */
export function getQueue(name: string): Queue {
  const existing = queues.get(name);
  if (existing) return existing;

  const queue = new Queue(name, {
    connection: getRedis(),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });

  queues.set(name, queue);
  return queue;
}
