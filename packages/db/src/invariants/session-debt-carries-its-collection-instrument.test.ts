import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  resolveSettlementInstrument,
  type ResolvedSettlementInstrument,
  type SettlementInstrumentCandidates,
} from '@balo/shared/credit';

/**
 * ⚠⚠ INVARIANT — A SESSION THAT CAN INCUR A DEBT CARRIES THE STRIPE INSTRUMENT THAT WAS ON FILE
 * WHEN THAT DEBT WAS INCURRED, WHENEVER THE WALLET HELD ONE AT THAT MOMENT — PINNED ONCE AND
 * NEVER REWRITTEN, WITH A WRITE-ONCE TOP-UP AT TERMINAL SETTLEMENT FOR THE CARD-LESS-OPEN CASE —
 * AND SETTLEMENT RESOLVES WHAT IT CHARGES THROUGH THAT PIN, UNDER CONSENT READ LIVE. CONSENT
 * ITSELF IS NEVER PINNED. (Plan §5.4: the conditional clause is not weasel wording — a wallet
 * that has never held a card has no instrument to pin, and its debt goes to a receivable on the
 * mandate check regardless.)
 *
 * BAL-525 (ADR-1040 Amendment 5). Follows the named precedents: `@balo/shared/credit`'s pure
 * core pinned for a money rule (`expert-paid-for-time-made-available.test.ts`), and the nearest
 * sibling, BAL-523's `overdraft-grace-requires-card-backed-mode.test.ts` — header framing,
 * pure-core table, anti-collapse assertions, `fileURLToPath(new URL(..., import.meta.url))`
 * source scans, and COUNTED occurrence assertions rather than bare `toContain`.
 *
 * ⚠ THIS FILE CREATES THE INVARIANT; IT DOES NOT AMEND ONE. Before BAL-525 there was no record
 * anywhere of which Stripe instrument a session's debt was incurred against —
 * `stripe_payment_intent_id` records the CHARGE, not the CARD — and `settleOverdraft` simply
 * re-read the wallet's CURRENT card at settlement time. Per ADR-1032 steps 1–2, this suite was
 * AUTHORED AND RUN RED before the schema columns and the repository pin sites existed — that
 * failure was expected and correct, not a mistake to "fix" by reordering the plan. The schema,
 * the migration, the pin helpers, and the `settleOverdraft` reshape all ship together in THIS
 * commit, so a reader on `main` finds this suite green, not red.
 *
 * ⚠⚠ THE PIN IS EVIDENCE AND PREFERENCE, NEVER AUTHORITY (O2). `settleOverdraft` PREFERS the
 * pinned instrument, FALLS BACK to the wallet's live pair when the pin is absent or the pin
 * disagrees with it, and WARNS on disagreement. It never refuses to charge because the pin is
 * gone, and it never charges the pin when the live wallet says otherwise — the anti-collapse
 * assertions below pin that shape by NAME, not merely by a changed count. Making the pin
 * authoritative ("charge the pin or nothing") is BAL-535's ruling, not this one's: it would
 * decide who eats the loss when the pinned instrument is gone, and the dunning sweep never
 * re-charges a receivable.
 *
 * ⚠⚠ NEVER PIN THE MANDATE (O4). `mandate_status` / `mandate_ref` must stay absent from this
 * table forever — a pinned `'active'` would let a client who revoked consent (or whose card
 * Stripe detached) still be charged off-session on a stale snapshot. The instrument (a fact
 * about the past) is pinned; the permission (a fact about now) is read live, always, at
 * settlement time. The schema source scan below asserts this by name.
 *
 * ⚠ THE O3 CONSENT FIX IS A SEPARATE, INDEPENDENT CLAIM FROM THE PIN ITSELF. `settleOverdraft`
 * must stop trusting a `mandateActive` boolean threaded from an already-committed transaction
 * and re-run `isWalletMandateActive` on its own fresh wallet read. The cross-package scan below
 * asserts the stale-gate shape is gone and the fresh check is present — this is the one
 * behavioural change in the eventual PR, and it is a consent fix, not a collection-policy one.
 */

/**
 * Read a scanned source file, resolved relative to THIS test file (`import.meta.url`), never
 * `process.cwd()` — CI runs vitest from the repo root, so a cwd-relative read would pass locally
 * and ENOENT in CI (memory `reference_web_server_disk_asset_cwd`).
 *
 * ⚠ O10 — if the file cannot be read, this suite must fail with an explicit message naming the
 * path and saying the file moved. A scan that silently finds zero occurrences and passes is a
 * false green, which is precisely the failure class this suite exists to prevent.
 *
 * ⚠ WHITESPACE-NORMALIZED before any assertion in this suite ever sees it — every run of
 * whitespace (spaces, newlines, indentation) collapses to a single space. A source-scan
 * assertion pins an invariant like "this column exists with this type", never "this
 * declaration occupies exactly one physical line": a Prettier rewrap must not be able to make
 * this suite say a column is gone. This is applied uniformly to EVERY scan in this file (the
 * schema, the repository, and the cross-package `end-session.ts` scan) — a single mechanism,
 * not a one-off carve-out for the column that used to need a `// prettier-ignore`. It does NOT
 * weaken what the assertions catch: a genuinely renamed or removed identifier still fails,
 * because normalization only touches whitespace, never token content or order.
 */
function readScannedSourceOrFail(displayPath: string, url: URL): string {
  const abs = fileURLToPath(url);
  try {
    return readFileSync(abs, 'utf8').replace(/\s+/g, ' ');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `BAL-525 invariant source scan: could not read "${displayPath}" (resolved to "${abs}"). ` +
        'This file has moved or been renamed — update the path in ' +
        `session-debt-carries-its-collection-instrument.test.ts rather than letting the scan ` +
        `silently pass with zero matches. Underlying error: ${reason}`
    );
  }
}

const CUS_1 = 'cus_1';
const CUS_OLD = 'cus_old';
const CUS_NEW = 'cus_new';
const PM_1 = 'pm_1';
const PM_OLD = 'pm_old';
const PM_NEW = 'pm_new';

interface Row {
  label: string;
  candidates: SettlementInstrumentCandidates;
  expected: ResolvedSettlementInstrument;
}

/** The minimum table pre-flight/plan §7.2 asks for, plus labels the anti-collapse tests key on. */
const ROWS: readonly Row[] = [
  {
    label: 'no pin at all — legacy row, or a session opened by a card-less wallet',
    candidates: {
      pinned: { customerId: null, paymentMethodId: null },
      live: { customerId: CUS_1, paymentMethodId: PM_1 },
    },
    expected: { customerId: CUS_1, paymentMethodId: PM_1, source: 'wallet', pinDisagrees: false },
  },
  {
    label: 'pin agrees with the live wallet',
    candidates: {
      pinned: { customerId: CUS_1, paymentMethodId: PM_1 },
      live: { customerId: CUS_1, paymentMethodId: PM_1 },
    },
    expected: { customerId: CUS_1, paymentMethodId: PM_1, source: 'pinned', pinDisagrees: false },
  },
  {
    label: 'pin disagrees — payment method changed since the debt was incurred',
    candidates: {
      pinned: { customerId: CUS_1, paymentMethodId: PM_OLD },
      live: { customerId: CUS_1, paymentMethodId: PM_NEW },
    },
    expected: {
      customerId: CUS_1,
      paymentMethodId: PM_NEW,
      source: 'wallet',
      pinDisagrees: true,
    },
  },
  {
    label: 'pin disagrees — customer changed since the debt was incurred (customer half counts)',
    candidates: {
      pinned: { customerId: CUS_OLD, paymentMethodId: PM_1 },
      live: { customerId: CUS_NEW, paymentMethodId: PM_1 },
    },
    expected: {
      customerId: CUS_NEW,
      paymentMethodId: PM_1,
      source: 'wallet',
      pinDisagrees: true,
    },
  },
  {
    label:
      'half-set pin — payment method half missing (the pair CHECK makes this unreachable in production; the resolver fails safe anyway)',
    candidates: {
      pinned: { customerId: CUS_1, paymentMethodId: null },
      live: { customerId: CUS_1, paymentMethodId: PM_1 },
    },
    expected: { customerId: CUS_1, paymentMethodId: PM_1, source: 'wallet', pinDisagrees: false },
  },
  {
    label:
      'half-set pin — customer half missing (the pair CHECK makes this unreachable in production; the resolver fails safe anyway)',
    candidates: {
      pinned: { customerId: null, paymentMethodId: PM_1 },
      live: { customerId: CUS_1, paymentMethodId: PM_1 },
    },
    expected: { customerId: CUS_1, paymentMethodId: PM_1, source: 'wallet', pinDisagrees: false },
  },
];

describe('INVARIANT: session debt carries its collection instrument — pure core (resolveSettlementInstrument)', () => {
  it.each(ROWS)('$label', ({ candidates, expected }) => {
    expect(resolveSettlementInstrument(candidates)).toEqual(expected);
  });

  it('⚠⚠ ANTI-COLLAPSE #1 — the pin is consulted at all', () => {
    // An implementation that ignores the pin entirely (`return { ...live, source: 'wallet',
    // pinDisagrees: false }` unconditionally) empties this set and fails HERE, by name — not
    // merely by a changed count.
    const pinnedRows = ROWS.filter(
      (row) => resolveSettlementInstrument(row.candidates).source === 'pinned'
    );
    expect(pinnedRows.map((row) => row.label)).toEqual(['pin agrees with the live wallet']);
  });

  it('⚠⚠ ANTI-COLLAPSE #2 — the pin is never authority', () => {
    // An implementation "improved" into a pin-or-nothing rule fails here, loudly: the resolved
    // payment method must equal the LIVE one on every row where they could possibly differ.
    // Authority over a stale pin is BAL-535's ruling, not this function's.
    const rowsWhereResolvedOverridesLive = ROWS.filter((row) => {
      const resolved = resolveSettlementInstrument(row.candidates);
      return resolved.paymentMethodId !== row.candidates.live.paymentMethodId;
    });
    expect(rowsWhereResolvedOverridesLive).toEqual([]);
  });

  it('pinDisagrees implies source === "wallet" — the two fields can never contradict', () => {
    for (const row of ROWS) {
      const resolved = resolveSettlementInstrument(row.candidates);
      if (resolved.pinDisagrees) {
        expect(resolved.source).toBe('wallet');
      }
    }
  });
});

describe('INVARIANT: the schema pins the instrument, never the mandate (source scan)', () => {
  it('the three pin columns and both CHECKs exist by name; the mandate columns stay absent forever (O4)', () => {
    const schema = readScannedSourceOrFail(
      'packages/db/src/schema/credit-sessions.ts',
      new URL('../schema/credit-sessions.ts', import.meta.url)
    );

    // The three pin columns exist, by DB name. The third is WHITESPACE-NORMALIZED (see
    // `readScannedSourceOrFail`): the live declaration wraps the options object across three
    // lines (Prettier, at 100 printWidth) and gains a trailing comma inside `{ }` as a result —
    // collapsing runs of whitespace to one space is what lets this assertion survive that
    // rewrap without caring how many lines the declaration spans.
    expect(schema).toContain("text('settlement_stripe_customer_id')");
    expect(schema).toContain("text('settlement_stripe_payment_method_id')");
    expect(schema).toContain(
      "timestamp('settlement_instrument_pinned_at', { withTimezone: true, })"
    );
    // Both CHECKs exist, by constraint name.
    expect(schema).toContain("'credit_sessions_settlement_instrument_pair'");
    expect(schema).toContain("'credit_sessions_settlement_instrument_pinned_at_pair'");

    // ⚠⚠ O4 / ADR-1040 Amendment 5 §C — CONSENT IS NEVER PINNED. A later "completion of the
    // set" fails HERE, by name, with this comment as the reason.
    expect(schema).not.toContain('settlement_mandate_status');
    expect(schema).not.toContain('settlement_mandate_ref');
    expect(schema).not.toContain('settlementMandateStatus');
    expect(schema).not.toContain('settlementMandateRef');
  });
});

describe('INVARIANT: the pin sites are wired at exactly the counts this rule depends on (drift alarm)', () => {
  it('⚠⚠ THE DRIFT ALARM — a new first-negative debt site must not silently escape the pin', () => {
    const repo = readScannedSourceOrFail(
      'packages/db/src/repositories/credit-sessions.ts',
      new URL('../repositories/credit-sessions.ts', import.meta.url)
    );

    // THREE ledger-writing sites exist in this file today — `postMeterTick`, `settleFromPresence`'s
    // top-up loop, and `applyExternalDuration`'s loop — and each spells `reason: 'session_consume'`
    // TWICE (the entry's reason and the idempotency key's), for 6 total. A FOURTH site adds two
    // more and fails here. When it does, DO NOT bump the number: state where that site's pin lives
    // (a base pin at `open()`, or a `settlementInstrumentTopUpPin` call in its own terminal
    // wallet-locked transaction) and add it to plan §7.4's table before touching this assertion.
    //
    // ⚠ KNOWN LIMIT, NOT EXHAUSTIVE: this alarm only scans THIS file. A fourth debt-incurring site
    // added to a DIFFERENT repository file, or one that spells its ledger reason as something
    // other than the literal `'session_consume'`, escapes this count silently — there is no
    // repo-wide "every negative-balance write" scan, only this one file's. Treat a green run here
    // as "no new site in credit-sessions.ts", not "no new site anywhere".
    expect((repo.match(/reason: 'session_consume'/g) ?? []).length).toBe(6);

    // The BASE pin has EXACTLY ONE caller — `open()`, the only production INSERT into
    // credit_sessions. 1 definition + 1 call = 2 occurrences of the call form (matched on the
    // opening `(`, never on a bare identifier, so a prose mention in a docblock cannot inflate
    // the count — BAL-523's R8 note).
    expect((repo.match(/settlementInstrumentBasePin\(/g) ?? []).length).toBe(2);
    // The TOP-UP pin has EXACTLY TWO callers — the two terminal wallet-locked UPDATEs (`end`,
    // `settleFromPresence`). 1 definition + 2 calls = 3. A third means someone pinned somewhere
    // that is not a terminal settlement.
    expect((repo.match(/settlementInstrumentTopUpPin\(/g) ?? []).length).toBe(3);

    // Write-once is enforced in SQL via COALESCE over the row's own pre-UPDATE value, not by a
    // droppable caller guard. COUNTED, not a bare `toContain('COALESCE(')` — the bare form also
    // matches the import-block comment at the top of this file (`credit-sessions.ts:17`,
    // "`COALESCE(...)`") and would stay green even if the top-up pin helper were rewritten to a
    // plain overwrite. Three occurrences: the two pin columns plus the pinned-at timestamp, each
    // wrapping `${creditSessions.settlement…}` inside the COALESCE.
    expect((repo.match(/COALESCE\(\$\{creditSessions\.settlement/g) ?? []).length).toBe(3);

    // ⚠ BAL-523's counts must stay UNDISTURBED — restated here so a BAL-525 edit that perturbs
    // them fails in BOTH suites rather than only in the older one
    // (`overdraft-grace-requires-card-backed-mode.test.ts`, which must stay green and unedited).
    expect((repo.match(/walletAllowsOverdraftGrace\(/g) ?? []).length).toBe(1);
    expect(
      (repo.match(/mandateActive: isWalletMandateActive\(/g) ?? []).length
    ).toBeGreaterThanOrEqual(4);
  });
});

describe('INVARIANT: settlement actually resolves through the pin (cross-package source scan)', () => {
  it('⚠ the stale commit-time gate is gone, the mandate is re-verified fresh, and the instrument is resolved through exactly one seam', () => {
    // ⚠⚠ O10 — this is a TEST-ONLY, READ-ONLY scan of `apps/api` source from `packages/db`'s
    // invariants directory. It creates no package dependency and no import edge. The invariant
    // this suite defends is a TWO-PACKAGE property — the schema/repository pin plus
    // `settleOverdraft`'s resolution of it — and splitting it across two files would let either
    // half drift without the other noticing. Precedent for reading across a package boundary
    // from this directory: `public-review-never-names-the-reviewer.test.ts` and
    // `expert-paid-for-time-made-available.test.ts` both read `packages/shared` source from
    // here; this goes one level further, to the repo root.
    const endSession = readScannedSourceOrFail(
      'apps/api/src/services/credit-session/end-session.ts',
      new URL('../../../../apps/api/src/services/credit-session/end-session.ts', import.meta.url)
    );

    // The stale-gate shape is GONE: the wallet read must be unconditional, never gated on a
    // boolean computed inside an already-committed, already-unlocked transaction (O3). Pinned
    // POSITIVELY, not by `not.toContain` on the OLD parameter name: `settleOverdraft`'s threaded
    // observation is now `observed.mandateActiveAtCommit`, so the literal
    // `'mandateActive ? await creditWalletsRepository.findById'` is unwritable by the CURRENT
    // signature regardless of whether the read is actually unconditional — a negative assertion
    // pinned to a literal the code cannot produce can never fail, and this suite caught exactly
    // that shape passing 12/12 against a reinstated stale conditional read spelled with the new
    // parameter name (`observed.mandateActiveAtCommit ? await creditWalletsRepository.findById(...)
    // : ...`). Assert the unconditional read positively instead: it exists, and exactly once.
    expect(endSession).toContain(
      'const wallet = await creditWalletsRepository.findById(session.walletId);'
    );
    expect((endSession.match(/creditWalletsRepository\.findById\(/g) ?? []).length).toBe(1);
    // O3 — the mandate is re-verified on settlement's OWN fresh wallet read, not inherited.
    expect(endSession).toContain('!isWalletMandateActive(wallet)');
    // O2 — exactly ONE resolution site; `reconcileStuckSettlement` goes through `settleOverdraft`
    // rather than resolving its own instrument a second time.
    expect((endSession.match(/resolveSettlementInstrument\(/g) ?? []).length).toBe(1);
    // ⚠ The Stripe idempotency key is NOT instrument-varied (plan §6.5) — the first settlement
    // attempt fixes the instrument at Stripe for the session's whole life; no "try the pin, then
    // fall back to the live card" ladder.
    expect(endSession).toContain('idempotencyKey: settlementIdempotencyKey(session.id)');
  });
});
