import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveMeetingSettlement } from '@balo/shared/credit';
import { MAX_SESSION_MINUTES } from '@balo/shared/pricing';

/**
 * ⚠⚠ INVARIANT — NO SESSION'S NEW DRAW OR BILL EXCEEDS MAX_SESSION_MINUTES; MINUTES ALREADY DRAWN
 * ARE ALWAYS BILLABLE. ADR-1040 Amendment 7 §C step 6 / §K (BAL-585).
 *
 * A presence session on a room nobody ended once drew 4,233 minutes off the wall clock. Three
 * seams now hold it, and each claim below fails by name when its seam is removed:
 *
 *  1. The meter: `meterSessionToNow` clamps its target tick to `MAX_SESSION_MINUTES`.
 *  2. The settlement figure guards: `billableMinutes` may exceed the ceiling only by what the meter
 *     already drew, and the top-up never runs past the billed figure — each a typed
 *     `SettlementRefusedError('figure_exceeds_bound')`.
 *  3. The pure core: `ruleMinutes` is capped at the ceiling, while `billableMinutes` is never below
 *     what was already drawn (the append-only ledger has no refund primitive).
 *
 * The real-Postgres half (what is posted, what is refused, what is written) lives in the sibling
 * `presence-billing-is-capped-at-the-meter-ceiling.integration.test.ts`.
 */

const CREDIT_SESSIONS_DISPLAY_PATH = 'packages/db/src/repositories/credit-sessions.ts';
const CREDIT_SESSIONS_URL = new URL('../repositories/credit-sessions.ts', import.meta.url);

function readScannedSourceOrFail(displayPath: string, url: URL): string {
  const abs = fileURLToPath(url);
  try {
    return readFileSync(abs, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `BAL-585 invariant source scan: could not read "${displayPath}" (resolved to "${abs}"). ` +
        'This file has moved or been renamed — update the path in ' +
        'presence-billing-is-capped-at-the-meter-ceiling.test.ts rather than letting the scan ' +
        `silently pass with zero matches. Underlying error: ${reason}`
    );
  }
}

/** CODE ONLY — block and line comments removed, so a docblock quoting a guard cannot satisfy a scan. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[^]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

const SOURCE = codeOnly(readScannedSourceOrFail(CREDIT_SESSIONS_DISPLAY_PATH, CREDIT_SESSIONS_URL));

/** The text from `needle` to the end of the `if` block that follows it (first closing brace). */
function guardBlock(needle: string): string {
  const start = SOURCE.indexOf(needle);
  expect(start, `guard "${needle}" must exist in ${CREDIT_SESSIONS_DISPLAY_PATH}`).toBeGreaterThan(
    -1
  );
  return SOURCE.slice(start, SOURCE.indexOf('}', start) + 1);
}

describe('presence billing is capped at the meter ceiling (BAL-585)', () => {
  it('the meter clamps its target tick to MAX_SESSION_MINUTES and loops only up to that target', () => {
    expect(SOURCE).toMatch(
      /targetTickSeq\s*=\s*Math\.min\(\s*elapsedTickSeq\s*,\s*MAX_SESSION_MINUTES\s*\)/
    );
    expect(SOURCE).toMatch(/seq\s*<=\s*targetTickSeq/);
  });

  it('settlement refuses billableMinutes above max(MAX_SESSION_MINUTES, drawn) with the typed error', () => {
    const block = guardBlock(
      'input.billableMinutes > Math.max(MAX_SESSION_MINUTES, session.lastTickSeq)'
    );
    expect(block).toContain('new SettlementRefusedError(');
    expect(block).toContain("'figure_exceeds_bound'");
  });

  it('settlement refuses a top-up past billableMinutes with the typed error', () => {
    const block = guardBlock('input.topUpToTickSeq > input.billableMinutes');
    expect(block).toContain('new SettlementRefusedError(');
    expect(block).toContain("'figure_exceeds_bound'");
  });

  describe('the pure core', () => {
    const span = 480 * 60_000;
    const base = new Date('2027-01-01T00:00:00.000Z');
    const resolve = (minutesAlreadyDrawn: number): ReturnType<typeof resolveMeetingSettlement> =>
      resolveMeetingSettlement({
        clocks: {
          expertPresentMs: span,
          billableMs: span,
          expertFirstJoinedAt: base,
          billableStartedAt: base,
        },
        expertPresentFromStartMs: span,
        togetherBeforeStartMs: 0,
        scheduledStart: base,
        clientSideEverPresent: true,
        floorMs: 15 * 60_000,
        minutesAlreadyDrawn,
        maxBillableMinutes: MAX_SESSION_MINUTES,
      });

    it('caps ruleMinutes at the ceiling for a 480-minute span, recording the true actual', () => {
      const settled = resolve(0);
      expect(settled.uncappedRuleMinutes).toBe(480);
      expect(settled.ruleMinutes).toBe(MAX_SESSION_MINUTES);
      expect(settled.billableMinutes).toBe(MAX_SESSION_MINUTES);
      expect(settled.actualMinutes).toBe(480);
    });

    it('never bills below what was already drawn, even past the ceiling', () => {
      const settled = resolve(4233);
      expect(settled.ruleMinutes).toBe(MAX_SESSION_MINUTES);
      expect(settled.billableMinutes).toBe(4233);
      expect(settled.topUpToTickSeq).toBeLessThan(settled.topUpFromTickSeq);
    });
  });
});
