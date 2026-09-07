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
 * ⚠⚠ THE TRUE PRECONDITION FOR THE JOIN TO BE UNAMBIGUOUS — THIRD FORMULATION. The first two
 * drafts of this paragraph were both wrong, and both wrongness has now been fixed differently:
 * the first claimed "unambiguous given a fixed arity per call site", which is false on its own
 * terms (`calendar-subscription-reconcile.ts` and `recording-cleanup-source.ts` call this with 2
 * OR 3 parts depending on a runtime branch). The second replaced it with "no part except the
 * LAST may itself contain `--`, and no non-final part may END with `-` while the NEXT part
 * BEGINS with `-`" — a condition on a PAIR of adjacent parts, checked nowhere, which is not a
 * precondition a single call can violate and so enforces nothing: it admits BOTH
 * `buildJobId('a-', 'b')` and `buildJobId('a', '-b')`, and both produce `'a---b'` — the precondition
 * permitted the exact collision it was supposed to rule out. This codebase treats this docblock
 * as a load-bearing control, and an over-claiming comment restating a broken invariant a third
 * time is exactly the defect BAL-531's fix round exists to stop re-committing.
 *
 * The correct, simpler, SUFFICIENT condition, stated as a property of ONE part at a time, not a
 * pair: **every part except the last contains no `--` and does not end with `-`.** Given that,
 * the first `--` in the joined string is always the first separator (a non-final part can never
 * manufacture one, on its own or by combining a trailing `-` with the next part's leading `-`),
 * so decoding back into the original arity-many parts is unique FOR A FIXED ARITY. This says
 * nothing about, and is not claimed to say anything about, collisions ACROSS different arities —
 * `queue.test.ts` pins the fixed-arity guarantee, not a cross-arity one. The final part is
 * completely unconstrained: it may contain `--`, and it may lead or trail with `-`.
 *
 * Enforced in code, not just documented: `buildJobId` below throws
 * `${JOB_ID_CONTRACT_VIOLATION}: non-final part ... ` when a NON-FINAL part violates this — a
 * guard the second, disproven formulation explicitly told the reader NOT to add (on the
 * mistaken belief it would break the one shipped `--`-bearing id). It doesn't: that id
 * (`{relationshipId}--{iso}` on the availability-shared correlationId, joined at
 * `notifications/publisher.ts`'s `buildJobId(event, correlationId)`) always lands in the FINAL
 * slot, which this guard never inspects. Every other non-final part in the tree today is a
 * literal prefix (`'subscriptions'`, `'meeting-calendar-amend'`, …), a UUID (RFC 4122's fixed
 * hyphen positions mean it can never lead or trail with `-`, or contain `--`), or a
 * dedupe/force token (`force`/`noforce`, a Daily batch or webhook event id) — none of which trip
 * the guard; `queue.test.ts` pins the real event-name and template-name sets (from
 * `notifications/engine/rules.ts`) against it directly rather than trusting this claim.
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

  // Enforce the precondition documented above: a NON-FINAL part may not contain `--` and may not
  // end with `-` — either would let it manufacture (or hand off) a separator, breaking per-arity
  // unique decoding. The FINAL part is deliberately exempt (see the docblock's `--`-bearing
  // correlationId example, which always lands last).
  const lastIndex = escaped.length - 1;
  escaped.forEach((part, index) => {
    if (index === lastIndex) {
      return;
    }
    if (part.includes('--') || part.endsWith('-')) {
      throw new Error(
        `${JOB_ID_CONTRACT_VIOLATION}: non-final part ${index} ("${part}") contains "--" or ends with "-"`
      );
    }
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
