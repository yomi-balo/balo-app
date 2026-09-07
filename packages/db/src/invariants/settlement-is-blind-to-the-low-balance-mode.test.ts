import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * ⚠⚠ INVARIANT — NEITHER SETTLEMENT SERVICE READS `low_balance_mode`, IN ANY SPELLING.
 * ADR-1040 Amendment 6 §A.1 / §C (BAL-535): settlement is mode-blind, PERMANENTLY. A
 * `notify_only` client IS charged off-session for time an expert delivered past zero — the
 * low-balance mode governs grace ENTRY only, and never governs settlement.
 *
 * ⚠ THIS FILE FENCES EXISTING BEHAVIOUR; IT DOES NOT DRIVE A CHANGE. Unlike the sibling suites
 * created alongside the code they pin (`overdraft-grace-requires-card-backed-mode.test.ts`,
 * `session-debt-carries-its-collection-instrument.test.ts`), this suite is GREEN on authoring —
 * `settleOverdraft` and `settleSessionFromPresence` already never read the mode, and ADR-1040
 * Amendment 6 rules that this stays true forever. It is a fence against a future "alignment"
 * refactor, not a change driver. A reader finding this suite green on `main` should read that as
 * "the rule holds", not as "nothing happened here".
 *
 * **Why this suite is needed and what it catches that nothing else does.**
 * `overdraft-grace-requires-card-backed-mode.test.ts`'s "SETTLEMENT IS UNMOVED BY THE MODE" test
 * already proves the PURE PREDICATE `isWalletMandateActive` ignores `lowBalanceMode` — but its
 * source scan reads `packages/db/src/repositories/credit-sessions.ts` ONLY. Neither shipped
 * suite scans `apps/api`'s two settlement SERVICES. So a refactor that added
 * `walletAllowsOverdraftGrace(wallet)` — or a bare `wallet.lowBalanceMode !== 'notify_only'` —
 * directly inside `settleOverdraft` or `settleSessionFromPresence` would leave BOTH shipped
 * suites green. This file closes that gap.
 *
 * Follows the named precedent's mechanics — `session-debt-carries-its-collection-instrument.test.ts`:
 * `readScannedSourceOrFail(displayPath, url)` via `fileURLToPath(new URL(...,
 * import.meta.url))` (never `process.cwd()` — CI runs vitest from the repo root), whitespace
 * normalisation, and COUNTED occurrence assertions rather than bare `toContain` / `not.toContain`.
 */

/** See `session-debt-carries-its-collection-instrument.test.ts` for the rationale in full. */
function readScannedSourceOrFail(displayPath: string, url: URL): string {
  const abs = fileURLToPath(url);
  try {
    return readFileSync(abs, 'utf8').replace(/\s+/g, ' ');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `BAL-535 invariant source scan: could not read "${displayPath}" (resolved to "${abs}"). ` +
        'This file has moved or been renamed — update the path in ' +
        `settlement-is-blind-to-the-low-balance-mode.test.ts rather than letting the scan ` +
        `silently pass with zero matches. Underlying error: ${reason}`
    );
  }
}

const MODES = ['notify_only', 'keep_going', 'auto_topup'] as const;

const SCANNED_FILES: ReadonlyArray<{ displayPath: string; url: URL }> = [
  {
    displayPath: 'apps/api/src/services/credit-session/end-session.ts',
    url: new URL(
      '../../../../apps/api/src/services/credit-session/end-session.ts',
      import.meta.url
    ),
  },
  {
    displayPath: 'apps/api/src/services/credit-session/settle-from-presence.ts',
    url: new URL(
      '../../../../apps/api/src/services/credit-session/settle-from-presence.ts',
      import.meta.url
    ),
  },
];

describe('INVARIANT: settlement is blind to the low-balance mode (ADR-1040 Amendment 6 §A.1/§C)', () => {
  for (const { displayPath, url } of SCANNED_FILES) {
    describe(displayPath, () => {
      it('⚠⚠ ANTI-ALIGNMENT #1 — never names the low-balance mode', () => {
        const src = readScannedSourceOrFail(displayPath, url);
        expect(src.match(/lowBalanceMode/g) ?? []).toHaveLength(0);
        expect(src.match(/low_balance_mode/g) ?? []).toHaveLength(0);
      });

      it('⚠⚠ ANTI-ALIGNMENT #2 — the grace-entry predicate is never called from settlement', () => {
        const src = readScannedSourceOrFail(displayPath, url);
        expect(src.match(/walletAllowsOverdraftGrace\(/g) ?? []).toHaveLength(0);
      });

      it('⚠⚠ ANTI-ALIGNMENT #3 — no card-backed-mode predicate reaches settlement', () => {
        const src = readScannedSourceOrFail(displayPath, url);
        expect(src.match(/isCardBackedLowBalanceMode\(/g) ?? []).toHaveLength(0);
        expect(src.match(/CARD_BACKED_LOW_BALANCE_MODES/g) ?? []).toHaveLength(0);
      });

      it('⚠⚠ ANTI-ALIGNMENT #4 — no mode LITERAL appears', () => {
        const src = readScannedSourceOrFail(displayPath, url);
        for (const mode of MODES) {
          const occurrences = (src.match(new RegExp(`'${mode}'`, 'g')) ?? []).length;
          expect(occurrences).toBe(0);
        }
      });
    });
  }

  /**
   * ⚠⚠ FIX ROUND N8 — RESCOPED, DELIBERATELY. This assertion used to be titled "settlement still
   * gates on the mandate ALONE, and does so exactly once", which asserted a rule ADR-1040
   * Amendment 6 never made. §H prohibits a MODE read in these two services and says NOTHING
   * against a second mandate predicate — so a future correctness fix that legitimately re-read
   * the mandate (say, on the reconcile arm) would have failed under a name claiming the ADR
   * forbade it. It is now scoped to what it actually is: a SNAPSHOT of today's shape, whose job
   * is to make a change here deliberate rather than to forbid one. The load-bearing half — that
   * settlement gates on the mandate and not on the mode — lives in the four ANTI-ALIGNMENT
   * assertions above, which ARE the ADR's rule.
   *
   * If you are here because you added a second `isWalletMandateActive(` call: check it is not a
   * mode read in disguise, bump the count, and say why in one line. That is the whole ceremony.
   */
  it('SNAPSHOT (not a rule) — end-session.ts holds exactly one mandate gate today, in settleOverdraft', () => {
    const src = readScannedSourceOrFail(
      'apps/api/src/services/credit-session/end-session.ts',
      new URL('../../../../apps/api/src/services/credit-session/end-session.ts', import.meta.url)
    );
    // The ADR's actual requirement: settlement's gate IS the mandate. That part is a rule.
    expect(src).toContain('!isWalletMandateActive(wallet)');
    // The count is the snapshot. Amendment 6 §H does not forbid a second mandate predicate.
    expect(src.match(/isWalletMandateActive\(/g) ?? []).toHaveLength(1);
  });

  // ⚠ `settle-from-presence.ts` holds NO mandate predicate at all — it threads
  // `repoResult.mandateActive` onward and the settlement decision belongs to `settleOverdraft`.
  // Do NOT write a `>= 1` assertion against this file for `isWalletMandateActive(` — it would
  // fail today, correctly: the file's only mandate touch is a pass-through, not a gate.
  // Same N8 caveat as above: this is a SNAPSHOT of where the gate lives, not a prohibition on
  // the presence service ever growing one.
  it('SNAPSHOT (not a rule) — the presence service holds no mandate predicate of its own', () => {
    const src = readScannedSourceOrFail(
      'apps/api/src/services/credit-session/settle-from-presence.ts',
      new URL(
        '../../../../apps/api/src/services/credit-session/settle-from-presence.ts',
        import.meta.url
      )
    );
    expect(src.match(/isWalletMandateActive\(/g) ?? []).toHaveLength(0);
  });
});
