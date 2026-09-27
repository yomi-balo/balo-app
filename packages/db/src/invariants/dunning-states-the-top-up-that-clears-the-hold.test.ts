import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { amountNeededToClearHold, creditCoversOutstandingDebt } from '@balo/shared/credit';

/**
 * ⚠⚠ INVARIANT — THE DUNNING NOTICE STATES THE TOP-UP THAT CLEARS THE HOLD. ADR-1040 Amendment 7
 * §G (BAL-474, owner ruling D6.2; orchestrator rulings D7.1 / D7.2).
 *
 * Owner, verbatim: "Fix the copy to be neutral about number of over-runs but state the total
 * amount needed." The figure a billing admin is told is therefore NOT a receivable's own
 * `amount_minor` (a stale per-session snapshot that is false the moment a second debt, a partial
 * top-up or a promo lands) but the smallest cash credit after which the Amendment 6 §F coverage
 * predicate is true — so "top up this amount or more and the hold clears" is literally true.
 *
 * ⚠ THIS FILE CREATES THE INVARIANT. Per ADR-1032 it was AUTHORED AND RUN RED before
 * `amountNeededToClearHold`, `creditReceivablesRepository.readHoldStatus`, the wallet-grain
 * dunning claim and `listWalletsDueForDailyDunning` existed. The integration half (a real wallet
 * with two debts and a promo) is `dunning-states-the-top-up-that-clears-the-hold.integration.test.ts`.
 */

interface ScannedFile {
  displayPath: string;
  url: URL;
}

function file(displayPath: string, relativeToThisFile: string): ScannedFile {
  return { displayPath, url: new URL(relativeToThisFile, import.meta.url) };
}

function readScannedSourceOrFail({ displayPath, url }: ScannedFile): string {
  const abs = fileURLToPath(url);
  try {
    return readFileSync(abs, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `BAL-474 invariant source scan: could not read "${displayPath}" (resolved to "${abs}"). ` +
        'This file has moved or been renamed — update the path in ' +
        'dunning-states-the-top-up-that-clears-the-hold.test.ts rather than letting the scan ' +
        `silently pass with zero matches. Underlying error: ${reason}`
    );
  }
}

/** Comments removed — a docblock naming a call can neither satisfy nor break a scan. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[^]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** The balanced `{ … }` block that starts at the first `{` at or after `from`. */
function sliceBlock(code: string, from: number): string {
  const open = code.indexOf('{', from);
  if (open === -1) {
    throw new Error('no block found');
  }
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    const char = code[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open, index + 1);
    }
  }
  throw new Error('unbalanced block');
}

/**
 * The declaration that starts at `marker`, up to its own closing line. Prettier closes a
 * top-level function with a line that is exactly `}` and an object-literal member (a repository
 * method, a template-map entry) with a line that is exactly `  },` — so the slice ends at the first
 * such line at the declaration's own indentation. Deliberately NOT brace-matched from the
 * signature: a destructured parameter or an object return type would be mistaken for the body.
 */
function sliceDeclaration(code: string, marker: string, indent: 0 | 2): string {
  const start = code.indexOf(marker);
  if (start === -1) {
    throw new Error(`Marker not found: "${marker}"`);
  }
  const closing = new RegExp(`\\n {${indent}}\\},?\\n`, 'g');
  closing.lastIndex = start + marker.length;
  const match = closing.exec(code);
  return code.slice(start, match === null ? code.length : match.index);
}

const DUNNING_SWEEP = file(
  'apps/api/src/jobs/receivable-dunning-sweep.ts',
  '../../../../apps/api/src/jobs/receivable-dunning-sweep.ts'
);
const NOTIFY = file(
  'apps/api/src/services/credit-session/notify.ts',
  '../../../../apps/api/src/services/credit-session/notify.ts'
);
const RECEIVABLES_REPO = file(
  'packages/db/src/repositories/credit-receivables.ts',
  '../repositories/credit-receivables.ts'
);
const EMAIL_FACTORY = file(
  'apps/api/src/notifications/channels/templates/index.ts',
  '../../../../apps/api/src/notifications/channels/templates/index.ts'
);
const EMAIL_TEMPLATE = file(
  'apps/api/src/notifications/channels/templates/session-settlement-failed.tsx',
  '../../../../apps/api/src/notifications/channels/templates/session-settlement-failed.tsx'
);
const IN_APP_TEMPLATES = file(
  'apps/api/src/notifications/channels/templates/in-app-templates.ts',
  '../../../../apps/api/src/notifications/channels/templates/in-app-templates.ts'
);

/** −30,000 … +5,000 in 500-minor steps. */
const BALANCES: readonly number[] = Array.from(
  { length: (30_000 + 5_000) / 500 + 1 },
  (_, index) => -30_000 + index * 500
);
const PROMOS: readonly number[] = [0, 2_000, 12_000];

/** Every way `amountNeededToClearHold(balance, promo)` could fail its four properties. */
function shortfallViolations(balance: number, promo: number): string[] {
  const needed = amountNeededToClearHold(balance, promo);
  const label = `balance ${balance}, promo ${promo} → ${needed}`;
  const checks: ReadonlyArray<readonly [boolean, string]> = [
    // Never negative — a notice never quotes a refund.
    [needed >= 0, 'negative'],
    // Paying it clears — "a top-up of this or more clears the hold" is TRUE.
    [creditCoversOutstandingDebt(balance + needed, promo), 'paying it does not clear'],
    // …and it is the SMALLEST such figure — one cent less does not clear.
    [
      needed === 0 || !creditCoversOutstandingDebt(balance + needed - 1, promo),
      'one cent less also clears',
    ],
    // Zero exactly when the balance already covers it — the covered-but-held state the claim
    // heals rather than publishing a notice that quotes A$0.00.
    [
      (needed === 0) === creditCoversOutstandingDebt(balance, promo),
      'zero does not coincide with already-covered',
    ],
  ];
  return checks.filter(([holds]) => !holds).map(([, what]) => `${label}: ${what}`);
}

describe("INVARIANT: the dunning figure is exactly the coverage predicate's shortfall", () => {
  it('amountNeededToClearHold is the smallest cash credit after which creditCoversOutstandingDebt holds', () => {
    const failures = BALANCES.flatMap((balance) =>
      PROMOS.flatMap((promo) => shortfallViolations(balance, promo))
    );
    expect(failures).toEqual([]);
    // Positive controls — the grid holds both covered and uncovered states.
    expect(BALANCES.some((balance) => amountNeededToClearHold(balance, 0) > 0)).toBe(true);
    expect(BALANCES.some((balance) => amountNeededToClearHold(balance, 0) === 0)).toBe(true);
  });

  it('the daily reminder is wallet-grain: the sweep lists wallets, never republishes per-session failures', () => {
    const sweep = codeOnly(readScannedSourceOrFail(DUNNING_SWEEP));
    expect(sweep).toContain('listWalletsDueForDailyDunning(');
    expect(sweep).not.toContain('publishSettlementFailure(');
    // The per-receivable dunning reads are gone with it.
    expect(sweep).not.toContain('listOpenForDunning(');
    expect(sweep).not.toContain('markDunned(');
  });

  it('notify.ts obtains the figure only via readHoldStatus inside claimHoldDunningNotice, under the wallet lock taken first', () => {
    const notify = codeOnly(readScannedSourceOrFail(NOTIFY));
    const claim = sliceDeclaration(notify, 'export async function claimHoldDunningNotice(', 0);
    const txIdx = claim.indexOf('db.transaction(');
    expect(txIdx).toBeGreaterThanOrEqual(0);
    // The FIRST awaited call inside the claim's transaction is the wallet advisory lock — every
    // credit writer takes it first, so the figure and the stamp come from one locked snapshot.
    const firstAwaitInTx = claim.indexOf('await ', txIdx);
    expect(claim.slice(firstAwaitInTx)).toMatch(/^await acquireWalletLock\(/);
    const readIdx = claim.indexOf('readHoldStatus(');
    expect(readIdx).toBeGreaterThan(firstAwaitInTx);

    // ⚠ `readHoldStatus(` has EXACTLY two call sites in this file, each under the wallet lock taken first:
    // the claim above and the booking guard's heal. A third — an unlocked read from a publisher or a
    // helper — is how the figure a client is told gets torn against a top-up that committed between reads.
    expect(notify.split('readHoldStatus(').length - 1).toBe(2);
    const heal = sliceDeclaration(notify, 'export async function healCoveredHoldNow(', 0);
    const healLockIdx = heal.indexOf('acquireWalletLock(');
    expect(healLockIdx).toBeGreaterThanOrEqual(0);
    expect(heal.indexOf('readHoldStatus(')).toBeGreaterThan(healLockIdx);

    // The publisher takes its figure from the claim, never from a read of its own.
    const publish = sliceDeclaration(notify, 'export async function publishHoldDunningNotice(', 0);
    expect(publish).toContain('claimHoldDunningNotice(');
    expect(publish).not.toContain('readHoldStatus(');
    // The figure is computed in ONE place (the repository reader), never re-derived here.
    expect(notify).not.toContain('amountNeededToClearHold(');
    expect(notify).not.toContain('sumPromoGrantedSince(');
  });

  it('readHoldStatus computes the figure from the SAME two inputs the coverage clear uses', () => {
    const repo = codeOnly(readScannedSourceOrFail(RECEIVABLES_REPO));
    const reader = sliceDeclaration(repo, 'async readHoldStatus(', 2);
    expect(reader).toContain('amountNeededToClearHold(');
    expect(reader).toContain('earliestOpenDebtAnchor(');
    expect(reader).toContain('sumPromoGrantedSince(');
  });

  it('the dunning templates quote topUpNeededMinor, never a per-receivable amountMinor', () => {
    // The email is rendered by the `index.ts` factory (which computes the props) into the `.tsx`
    // template; the in-app entry reads the payload directly. Neither may reach a receivable's
    // own stale `amountMinor`.
    const factory = sliceDeclaration(
      codeOnly(readScannedSourceOrFail(EMAIL_FACTORY)),
      "'session-settlement-failed': (",
      2
    );
    expect(factory).toContain('topUpNeededMinor');
    expect(factory).not.toContain('amountMinor)');
    expect(factory).not.toContain('data.amountMinor');

    const inApp = sliceDeclaration(
      codeOnly(readScannedSourceOrFail(IN_APP_TEMPLATES)),
      "'session-settlement-failed': (",
      2
    );
    expect(inApp).toContain('topUpNeededMinor');
    expect(inApp).not.toContain('data.amountMinor');

    const template = codeOnly(readScannedSourceOrFail(EMAIL_TEMPLATE));
    expect(template).not.toContain('amountMinor');
  });

  it('the daily stamp is written only under the daily_reminder arm — a new debt never pushes the due set back', () => {
    // R3-F1 / D7.1 — a `receivable_opened` notice is never throttled and never stamps, so an
    // off-cycle notice can never delay the next daily reminder.
    const notify = codeOnly(readScannedSourceOrFail(NOTIFY));
    expect(notify.match(/stampDailyDunning\(/g) ?? []).toHaveLength(1);
    const claim = sliceDeclaration(notify, 'export async function claimHoldDunningNotice(', 0);
    const armIdx = claim.indexOf("if (trigger === 'daily_reminder')");
    expect(armIdx).toBeGreaterThanOrEqual(0);
    const dailyArm = sliceBlock(claim, armIdx);
    expect(dailyArm).toContain('stampDailyDunning(');
  });
});
