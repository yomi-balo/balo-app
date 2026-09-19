import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_REFUSAL_HEADER,
  classifyAccountRefusal,
  isAccountRefusalCode,
  reasonOfRefusal,
} from './account-liveness';

describe('classifyAccountRefusal (BAL-568)', () => {
  it('reads a MISSING row as account_deleted — the sync routes missing-row arm', () => {
    expect(classifyAccountRefusal(null)).toBe('account_deleted');
  });

  /**
   * ⚠ REFUSES RATHER THAN THROWING. Repository reads in this codebase differ on the absent-row
   * sentinel (`findFirst` yields `undefined`, the explicit projections yield `null`). A TypeError
   * raised inside `requireAuth` or `getCurrentUser` would be a 500, not a refusal — the wrong
   * direction for a fail-closed predicate to be wrong in.
   */
  it('⚠ reads an UNDEFINED row as account_deleted too, and does not throw', () => {
    expect(classifyAccountRefusal(undefined)).toBe('account_deleted');
  });

  it('reads a live row as null — no refusal', () => {
    expect(classifyAccountRefusal({ status: 'active', deletedAt: null })).toBeNull();
  });

  it('reads a suspended row as account_suspended', () => {
    expect(classifyAccountRefusal({ status: 'suspended', deletedAt: null })).toBe(
      'account_suspended'
    );
  });

  /**
   * The enum's THIRD member. The ticket names only "suspended"; `userRowIsLive` does not
   * distinguish them, so `inactive` must refuse identically — otherwise the one status nobody
   * wrote a ticket about is the one that keeps acting.
   */
  it('reads an INACTIVE row as account_suspended too', () => {
    expect(classifyAccountRefusal({ status: 'inactive', deletedAt: null })).toBe(
      'account_suspended'
    );
  });

  it('reads a soft-deleted but otherwise active row as account_deleted', () => {
    expect(classifyAccountRefusal({ status: 'active', deletedAt: new Date('2026-01-01') })).toBe(
      'account_deleted'
    );
  });

  /**
   * ⚠ THE ONE CASE WHERE THE TWO CONDITIONS DISAGREE, AND THE ONLY REASON THE ORDER IS PINNED.
   * `app/api/auth/session-sync/route.ts` branches on `deletedAt` BEFORE `status`, and BAL-197's
   * shipped copy was written against that order. Checking `status` first would send a
   * suspended-and-deleted account to `/login?error=account_suspended` — a regression of shipped
   * copy for exactly that row.
   */
  it('⚠ PRECEDENCE: suspended AND soft-deleted reads account_deleted, not account_suspended', () => {
    expect(classifyAccountRefusal({ status: 'suspended', deletedAt: new Date('2026-01-01') })).toBe(
      'account_deleted'
    );
  });
});

describe('reasonOfRefusal', () => {
  it('maps each code to the Pino/PostHog word the sync route already writes', () => {
    expect(reasonOfRefusal('account_deleted')).toBe('deleted');
    expect(reasonOfRefusal('account_suspended')).toBe('suspended');
  });
});

describe('isAccountRefusalCode', () => {
  it('accepts exactly the two codes', () => {
    expect(isAccountRefusalCode('account_suspended')).toBe(true);
    expect(isAccountRefusalCode('account_deleted')).toBe(true);
  });

  it('fails closed on everything else, case variants included', () => {
    for (const value of ['', null, undefined, 'ACCOUNT_SUSPENDED', 'suspended', 0, {}]) {
      expect(isAccountRefusalCode(value), `${String(value)} must not be a refusal code`).toBe(
        false
      );
    }
  });
});

describe('the wire marker', () => {
  it('is the lower-case header name Fastify/undici normalise to', () => {
    expect(ACCOUNT_REFUSAL_HEADER).toBe('x-balo-session-invalid');
    expect(ACCOUNT_REFUSAL_HEADER).toBe(ACCOUNT_REFUSAL_HEADER.toLowerCase());
  });
});

/**
 * ⚠⚠ R5's ONE-DEFINITION PIN, AND IT IS A SOURCE ASSERTION ON PURPOSE. Every behavioural case
 * above passes just as happily against an inlined `row.status !== 'active'` copy — the whole
 * point of R5 is that a SECOND definition must be impossible to add quietly, and only reading
 * the source can see that.
 */
describe('⚠ one definition of "live" (R5)', () => {
  const SOURCE = readFileSync(new URL('./account-liveness.ts', import.meta.url), 'utf8');

  it('delegates to userRowIsLive and restates none of its conditions', () => {
    expect(SOURCE.length).toBeGreaterThan(200);
    expect(SOURCE).toContain('userRowIsLive(row)');
    expect(SOURCE).toContain("import { userRowIsLive } from './staff-access';");

    // ⚠⚠ THE STATUS HALF IS DELEGATED IN FULL — this module never reads `row.status` at all, and
    // never compares against the `'active'` literal. Liveness cannot be reconstructed without a
    // status comparison, so banning all three spellings makes a second definition unwritable here.
    // (The docblock's prose `status = 'active'` uses a single `=` and is a different string.)
    expect(SOURCE).not.toContain('row.status');
    expect(SOURCE).not.toContain("!== 'active'");
    expect(SOURCE).not.toContain("=== 'active'");

    // ⚠ `row.deletedAt` IS DELIBERATELY NOT BANNED, and the distinction is the point. Choosing
    // BETWEEN the two refusal codes is this module's own job, and it needs exactly one column to
    // do it; that is a PRECEDENCE rule, not a restatement of "live". What would be a second
    // definition is the CONJUNCTION — `deletedAt … && status …` — which the status bans above
    // already make unwritable.
    expect(SOURCE).toContain('row.deletedAt');
  });
});
