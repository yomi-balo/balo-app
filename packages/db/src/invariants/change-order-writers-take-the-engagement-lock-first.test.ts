import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripComments } from '@balo/shared/testing';

/**
 * ⚠⚠ INVARIANT (BAL-622) — EVERY CHANGE-ORDER WRITE OPENS WITH THE ENGAGEMENT LOCK.
 *
 * A change order reads and writes the engagement's milestones and effective price, and its
 * guards (one open order, active project only, milestones locked while a change is sent) are
 * only sound if no other delivery write on the same engagement can interleave. The single-writer
 * gate for an engagement is `lockActiveEngagement` (`_shared/engagement-lock.ts`), which every
 * milestone, action-item and project transition already takes first. This file fences the same
 * rule over `engagement-change-orders.ts`: every `db.transaction(` body's first statement is
 * `lockActiveEngagement(` or the order-keyed `lockChangeOrderTx(`, and `lockChangeOrderTx`
 * itself takes `lockActiveEngagement(` before its first row lock.
 *
 * Change orders never take the per-request advisory lock, so they are deliberately NOT in
 * `request-domain-writers-take-the-lock-first.test.ts`; adding them there would assert nothing.
 *
 * ⚠ AN UNFILTERED DISCOVERY. Every `db.transaction(` call site in the file is recorded, not just
 * the expected ones, and each must open with one of the two helpers. Comments are stripped first
 * (`@balo/shared/testing`'s `stripComments`), because the repository's docblocks name the helpers
 * in prose.
 */

const FILE = 'engagement-change-orders.ts';
const LOCK_CALL_NAMES: readonly string[] = ['lockActiveEngagement', 'lockChangeOrderTx'];

const SOURCE = stripComments(
  readFileSync(fileURLToPath(new URL(`../repositories/${FILE}`, import.meta.url)), 'utf8')
);

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
 * The helper the transaction body's first statement awaits — `await <name>(` or
 * `const <binding> = await <name>(` — or `undefined`.
 */
function firstLockCall(stripped: string, transactionIndex: number): string | undefined {
  const arrowIndex = stripped.indexOf('=>', transactionIndex);
  if (arrowIndex === -1) throw new Error(`No "=>" after db.transaction( at ${transactionIndex}.`);
  const body = stripped.slice(arrowIndex + 2).trimStart();
  const statement = (body.startsWith('{') ? body.slice(1) : body).trimStart();
  const binding = /^const\s+[A-Za-z_$][\w$]*\s*=\s*/.exec(statement);
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

/** The body of `async function <name>(`, up to the next top-level `async function`. */
function helperBody(stripped: string, name: string): string {
  const start = stripped.indexOf(`async function ${name}(`);
  if (start === -1) throw new Error(`helper ${name} not found`);
  const next = stripped.indexOf('async function ', start + 1);
  return stripped.slice(start, next === -1 ? stripped.length : next);
}

/** Transactions whose purpose is a read and need no lock. */
const READ_ONLY_TRANSACTIONS: readonly string[] = ['settlementTermsFor'];

describe('INVARIANT: change-order writers take the engagement lock first (BAL-622)', () => {
  const records = discoverWriters(SOURCE);
  const writers = records.filter((r) => !READ_ONLY_TRANSACTIONS.includes(r.method));

  it('⚠ POSITIVE CONTROL — the scan finds every transaction (at least eight writers)', () => {
    expect(writers.length).toBeGreaterThanOrEqual(8);
  });

  it('⚠ POSITIVE CONTROL — a transaction that opens with anything else is detected', () => {
    const fixture =
      'const r = { async x() { return db.transaction(async (tx) => { await tx.select(); }); } };';
    expect(discoverWriters(fixture)).toEqual([{ method: 'x', lockCall: undefined }]);
    const locked =
      'const r = { async y() { return db.transaction(async (tx) => { await lockChangeOrderTx(tx, a, b); }); } };';
    expect(discoverWriters(locked)).toEqual([{ method: 'y', lockCall: 'lockChangeOrderTx' }]);
  });

  it('every write transaction opens with lockActiveEngagement or lockChangeOrderTx', () => {
    const offenders = writers.filter((r) => r.lockCall === undefined).map((r) => r.method);
    expect(offenders).toEqual([]);
  });

  it('the read-only exemption covers exactly the transactions that write nothing', () => {
    const exempt = records.filter((r) => READ_ONLY_TRANSACTIONS.includes(r.method));
    expect(exempt.map((r) => r.method)).toEqual([...READ_ONLY_TRANSACTIONS]);
    const body = SOURCE.slice(SOURCE.indexOf('async settlementTermsFor('));
    const end = body.indexOf('async listStaleSentForAlerts(');
    const settlement = body.slice(0, end);
    expect(settlement).not.toMatch(/\.(?:insert|update|delete)\(/);
  });

  it('lockChangeOrderTx takes lockActiveEngagement before its first row lock', () => {
    const body = helperBody(SOURCE, 'lockChangeOrderTx');
    const lockAt = body.indexOf('lockActiveEngagement(');
    const forUpdateAt = body.indexOf(".for('update')");
    expect(lockAt).toBeGreaterThan(-1);
    expect(forUpdateAt).toBeGreaterThan(lockAt);
  });
});
