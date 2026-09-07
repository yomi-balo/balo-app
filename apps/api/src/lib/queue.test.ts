import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildJobId, JOB_ID_CONTRACT_VIOLATION } from './queue.js';
import { notificationRules } from '../notifications/engine/rules.js';

/**
 * BAL-531 — `buildJobId` is the ONLY way a custom BullMQ jobId may be minted. This suite pins:
 *  1. the two ticket acceptance examples verbatim;
 *  2. BullMQ's actual `Job.addJob` predicate, restated so a future misquote is caught here first;
 *  3. the escape's injectivity — the whole reason it is two characters, not one;
 *  4. the four throw guards, in every environment.
 *
 * `queue.test.ts` is a NEW file — no existing suite covered `lib/queue.ts` before this ticket.
 */

describe('buildJobId — ticket acceptance examples', () => {
  it('example 1 — meeting-calendar-amend', () => {
    const id = buildJobId('meeting-calendar-amend', '3f2a2b7e-1234-4a1b-9c3d-abcdefabcdef');
    expect(id.includes(':')).toBe(false);
    expect(id).toBe('meeting-calendar-amend--3f2a2b7e-1234-4a1b-9c3d-abcdefabcdef');
  });

  it('example 2 — credit-session-low-balance with a colon-bearing correlationId', () => {
    const id = buildJobId('credit-session-low-balance', 'user-1', 'calendar-sub-lapse:2026-09-04');
    expect(id.includes(':')).toBe(false);
    expect(id).toBe('credit-session-low-balance--user-1--calendar-sub-lapse_c2026-09-04');
  });
});

describe('buildJobId — the actual BullMQ rule, pinned', () => {
  const FIXTURES = [
    buildJobId('meeting-calendar-amend', '3f2a2b7e-1234-4a1b-9c3d-abcdefabcdef'),
    buildJobId('credit-session-low-balance', 'user-1', 'calendar-sub-lapse:2026-09-04'),
    buildJobId('expert.application_submitted', 'app-456'),
    buildJobId('auto_topup', 'wallet-a', 'entry-1'),
    buildJobId('dormancy_expiry', 'wallet-a', '2026-09-04'),
    buildJobId('a', 'manual:x'),
    buildJobId('a', 'manual_x'),
  ] as const;

  it('every id has zero colons', () => {
    for (const id of FIXTURES) {
      expect(id.includes(':')).toBe(false);
    }
  });

  it('every id satisfies the verbatim upstream predicate from bullmq@5.70.4 Job.addJob', () => {
    for (const id of FIXTURES) {
      expect(id.includes(':') && id.split(':').length !== 3).toBe(false);
    }
  });
});

describe('buildJobId — injectivity (the reason the escape is two characters)', () => {
  it('swapped colon/underscore order stays distinct', () => {
    expect(buildJobId('e', 'a_:b')).not.toBe(buildJobId('e', 'a:_b'));
  });

  it('a literal colon and a literal underscore in the "same" position do not collide', () => {
    expect(buildJobId('e', 'manual:x')).not.toBe(buildJobId('e', 'manual_x'));
  });

  it('two distinct auto-topup dedup keys stay distinct', () => {
    expect(buildJobId('auto_topup', 'w', 'e1')).not.toBe(buildJobId('auto_topup', 'w', 'e2'));
  });
});

describe('buildJobId — uniform escaping is deliberate (D1), not an accident', () => {
  it('escapes the event-name part the same way as every other part', () => {
    expect(buildJobId('expert.application_submitted', 'app-456')).toBe(
      'expert.application__submitted--app-456'
    );
  });
});

describe('JOB_ID_CONTRACT_VIOLATION — verbatim stability', () => {
  // BAL-531 fix round F1 — every `toThrow(...)` above INTERPOLATES this imported constant, so it
  // proved only that the constant equals itself: PROVED by mutation — changing `lib/queue.ts`'s
  // wording left 30/30 tests passing. Pin the LITERAL itself here, so a future rewording is
  // caught by this file first, not discovered when an Axiom monitor pointed at the old wording
  // goes quiet.
  it('the exported prefix is verbatim stable — a monitor is pointed at this literal', () => {
    expect(JOB_ID_CONTRACT_VIOLATION).toBe('BullMQ job id contract violation');
  });
});

describe('buildJobId — the non-final-part guard (fix round 2, G1 — third docblock formulation)', () => {
  // The docblock's SECOND formulation ("no non-final part may end with '-' while the NEXT part
  // begins with '-'") was a condition on a PAIR, checked nowhere, and admitted BOTH members of
  // this exact colliding pair. The guard below closes it by rejecting the OFFENDING part on its
  // own, regardless of what the next part looks like.
  it('throws for a non-final part ending with "-" (the pair the docblock names)', () => {
    expect(() => buildJobId('a-', 'b')).toThrow(JOB_ID_CONTRACT_VIOLATION);
    // The other member of the pair is UNAFFECTED — 'a' does not end with '-' and '-b' is the
    // FINAL part, which the guard never inspects.
    expect(buildJobId('a', '-b')).toBe('a---b');
  });

  it('throws for a non-final part containing "--"', () => {
    expect(() => buildJobId('a--b', 'c')).toThrow(JOB_ID_CONTRACT_VIOLATION);
    expect(() => buildJobId('a--b', 'c')).toThrow(
      `${JOB_ID_CONTRACT_VIOLATION}: non-final part 0 ("a--b") contains "--" or ends with "-"`
    );
  });

  it('the FINAL part is unconstrained — may contain "--" or lead/trail with "-"', () => {
    expect(() => buildJobId('a', 'b--c')).not.toThrow();
    expect(() => buildJobId('a', '-b-')).not.toThrow();
  });

  // BAL-283 (Ruling 3) — `conversation.availability_shared`'s real shape:
  // `buildJobId(event, correlationId)` where `correlationId` = `${relationshipId}--${sharedAtIso}`
  // (`routes/notifications/schema.ts`'s `conversationAvailabilitySharedPayload` docblock;
  // minted via `notifications/publisher.ts`'s `buildJobId(event, payload.correlationId)`).
  // correlationId is always the LAST part — pin that this shipped `--`-bearing shape survives
  // the new guard unharmed.
  it('the shipped availability-shared correlationId ("{relationshipId}--{iso}") survives, final slot only', () => {
    const relationshipId = '3f2a2b7e-1234-4a1b-9c3d-abcdefabcdef';
    // A real ISO timestamp carries colons, which get escaped like any other part — the point
    // pinned here is the "--" INSIDE the correlationId, not the timestamp's own escaping.
    const sharedAtIso = '2026-09-04T12:00:00.000Z';
    const correlationId = `${relationshipId}--${sharedAtIso}`;
    const id = buildJobId('conversation.availability_shared', correlationId);
    expect(id.includes(':')).toBe(false);
    // `relationshipId` contains neither `_` nor `:`, so it (and the "--" that follows it, which
    // came from INSIDE the final part, not from `buildJobId`'s own join) survives byte-identical
    // — proof the guard did not treat the final part's internal "--" as an extra separator.
    expect(id).toContain(`--${relationshipId}--`);
  });
});

describe('buildJobId — canonical collision pair, asserted directly (review non-blocking #2)', () => {
  // Previously pinned only indirectly via the 2-part `buildJobId('e', 'manual:x')` vs
  // `buildJobId('e', 'manual_x')` case below. The reviewer asked for the single-part pair named
  // in the docblock's "a bare `:` -> `_` is not injective" discussion, asserted on its own.
  it('buildJobId("a:b") !== buildJobId("a_cb")', () => {
    expect(buildJobId('a:b')).not.toBe(buildJobId('a_cb'));
  });
});

describe('buildJobId — the real event-name and template-name sets never trip the new guard', () => {
  // The reviewer flagged the 85+ template names as the one set they could not enumerate by hand.
  // `notifications/engine/rules.ts` is a pure data file (no imports), so pulling it in here
  // carries no import-cycle risk.
  const eventNames = Object.keys(notificationRules);
  const templates = Object.values(notificationRules)
    .flat()
    .map((rule) => rule.template);

  it('has a non-trivial number of event names and templates to check (non-vacuity)', () => {
    expect(eventNames.length).toBeGreaterThan(20);
    expect(templates.length).toBeGreaterThan(60);
  });

  it("every event name is safe as buildJobId's FIRST (non-final) part — mirrors publisher.ts", () => {
    for (const event of eventNames) {
      expect(() => buildJobId(event, 'correlation-id-1')).not.toThrow();
    }
  });

  it("every rule template is safe as buildJobId's FIRST (non-final) part — mirrors dispatcher.ts", () => {
    for (const template of templates) {
      expect(() => buildJobId(template, 'recipient-1', 'correlation-id-1')).not.toThrow();
    }
  });
});

describe('buildJobId — throws', () => {
  it('throws on zero parts', () => {
    expect(() => buildJobId()).toThrow(JOB_ID_CONTRACT_VIOLATION);
    expect(() => buildJobId()).toThrow(
      `${JOB_ID_CONTRACT_VIOLATION}: buildJobId() called with no parts`
    );
  });

  it('throws on an empty part', () => {
    expect(() => buildJobId('a', '')).toThrow(JOB_ID_CONTRACT_VIOLATION);
  });

  it('throws when the escaped, joined result is all-digit', () => {
    expect(() => buildJobId('123')).toThrow(JOB_ID_CONTRACT_VIOLATION);
  });

  describe('fires in every environment', () => {
    const originalEnv = process.env.NODE_ENV;

    afterEach(() => {
      vi.stubEnv('NODE_ENV', originalEnv ?? 'test');
    });

    it('throws with NODE_ENV=production', () => {
      vi.stubEnv('NODE_ENV', 'production');
      expect(() => buildJobId()).toThrow(JOB_ID_CONTRACT_VIOLATION);
    });

    it('throws with NODE_ENV=test', () => {
      vi.stubEnv('NODE_ENV', 'test');
      expect(() => buildJobId()).toThrow(JOB_ID_CONTRACT_VIOLATION);
    });
  });
});
