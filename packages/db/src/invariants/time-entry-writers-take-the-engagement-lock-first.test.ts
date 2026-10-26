import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripComments } from '@balo/shared/testing';

/**
 * ⚠⚠ INVARIANT — EVERY TIME-ENTRY WRITE OPENS WITH THE ENGAGEMENT LOCK.
 *
 * A time write reads a milestone's logged total to detect an estimate crossing, and a change
 * order's `send` / `approve` read the engagement's logged total for `cap_below_logged`. Both
 * are only sound if no other delivery write on the engagement can interleave. The single-writer
 * gate is the engagement lock, taken here through `lockEngagementAndMilestone`
 * (`_shared/engagement-lock.ts`), which locks the engagement and then the milestone. This file
 * fences `engagement-time-entries.ts`: every `db.transaction(` body's first statement is
 * `lockEngagementAndMilestone(`, and that helper takes `lockActiveEngagement(` before its
 * milestone row lock.
 *
 * ⚠ AN UNFILTERED DISCOVERY. Every `db.transaction(` call site in the file is recorded, and
 * each must open with the helper. Comments are stripped first, because the repository's
 * docblocks name the helper in prose.
 */

const LOCK_CALL_NAMES: readonly string[] = ['lockEngagementAndMilestone'];

function source(relative: string): string {
  return stripComments(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'));
}

const SOURCE = source('../repositories/engagement-time-entries.ts');
const LOCK_SOURCE = source('../repositories/_shared/engagement-lock.ts');

function enclosingMethodName(stripped: string, beforeIndex: number): string {
  const pattern = /\basync\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let best: string | undefined;
  let match = pattern.exec(stripped);
  while (match !== null && match.index < beforeIndex) {
    best = match[1];
    match = pattern.exec(stripped);
  }
  if (best === undefined) {
    throw new Error(`No enclosing "async <name>(" header before index ${beforeIndex}.`);
  }
  return best;
}

/**
 * The helper the transaction body's first statement awaits — `await <name>(`,
 * `const <binding> = await <name>(` or `const { … } = await <name>(` — or `undefined`.
 */
function firstLockCall(stripped: string, transactionIndex: number): string | undefined {
  const arrowIndex = stripped.indexOf('=>', transactionIndex);
  if (arrowIndex === -1) throw new Error(`No "=>" after db.transaction( at ${transactionIndex}.`);
  const body = stripped.slice(arrowIndex + 2).trimStart();
  const statement = (body.startsWith('{') ? body.slice(1) : body).trimStart();
  const binding = /^const\s+(?:[A-Za-z_$][\w$]*|\{[^}]*\})\s*=\s*/.exec(statement);
  const expression = binding === null ? statement : statement.slice(binding[0].length);
  const call = expression.startsWith('await ') ? expression.slice('await '.length) : expression;
  return LOCK_CALL_NAMES.find((name) => call.startsWith(`${name}(`));
}

interface WriterRecord {
  method: string;
  lockCall: string | undefined;
}

function discoverWriters(stripped: string): WriterRecord[] {
  const records: WriterRecord[] = [];
  let from = 0;
  for (;;) {
    const idx = stripped.indexOf('db.transaction(', from);
    if (idx === -1) break;
    records.push({
      method: enclosingMethodName(stripped, idx),
      lockCall: firstLockCall(stripped, idx),
    });
    from = idx + 'db.transaction('.length;
  }
  return records;
}

describe('INVARIANT: time-entry writers take the engagement lock first', () => {
  const writers = discoverWriters(SOURCE);

  it('⚠ POSITIVE CONTROL — the scan finds every write transaction (log, update, remove)', () => {
    expect(writers.map((w) => w.method)).toEqual(['log', 'update', 'remove']);
  });

  it('⚠ POSITIVE CONTROL — a transaction that opens with anything else is detected', () => {
    const fixture =
      'const r = { async x() { return db.transaction(async (tx) => { await tx.select(); }); } };';
    expect(discoverWriters(fixture)).toEqual([{ method: 'x', lockCall: undefined }]);
    const locked =
      'const r = { async y() { return db.transaction(async (tx) => { const { milestone } = await lockEngagementAndMilestone(tx, a); }); } };';
    expect(discoverWriters(locked)).toEqual([
      { method: 'y', lockCall: 'lockEngagementAndMilestone' },
    ]);
  });

  it('every write transaction opens with lockEngagementAndMilestone', () => {
    const offenders = writers.filter((r) => r.lockCall === undefined).map((r) => r.method);
    expect(offenders).toEqual([]);
  });

  it('lockEngagementAndMilestone takes lockActiveEngagement before its milestone row lock', () => {
    const start = LOCK_SOURCE.indexOf('export async function lockEngagementAndMilestone(');
    expect(start).toBeGreaterThan(-1);
    const body = LOCK_SOURCE.slice(start);
    const lockAt = body.indexOf('lockActiveEngagement(');
    const forUpdateAt = body.indexOf(".for('update')");
    expect(lockAt).toBeGreaterThan(-1);
    expect(forUpdateAt).toBeGreaterThan(lockAt);
  });
});
