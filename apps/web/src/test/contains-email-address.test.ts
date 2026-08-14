import { describe, expect, it } from 'vitest';
import { containsEmailAddress } from './contains-email-address';

/**
 * BAL-436 — ⚠⚠ THE SWEEP THAT GUARDS THE SWEEPS.
 *
 * Four suites lean on `containsEmailAddress` to prove no address leaked into rendered output
 * or into a log payload. A silently-broken helper would make all four pass for the wrong
 * reason, so it gets its own tests: one set proving it FINDS real addresses, one set proving
 * it does NOT fire on the shapes that made the first version unusable.
 */

describe('containsEmailAddress — it finds a real address', () => {
  it.each([
    'dana@northwind.example',
    'contact me at sam.rivera+cal@cloudpeak.co.uk please',
    '{"recipientEmail":"stranger@somewhere.example"}',
    'TAYLOR@EXAMPLE.COM',
    'a@b.io',
  ])('%s', (text) => {
    expect(containsEmailAddress(text)).toBe(true);
  });
});

describe('containsEmailAddress — it does NOT fire on non-addresses', () => {
  it.each([
    ['a bare word', 'no addresses here at all'],
    ['a lone at-sign', 'at @ the start'],
    ['a scoped npm package', 'import x from @balo/shared'],
    // ⚠⚠ THE SHAPE THAT BROKE THE FIRST VERSION. A vitest stack trace is full of these, and a
    // sweep that fires on them fails on the harness rather than on a leak.
    ['a versioned pnpm path', '/node_modules/.pnpm/@vitest+runner@4.0.18/node_modules/x'],
    ['an at-sign with no domain dot', 'user@localhost'],
    ['a trailing dot', 'user@example.'],
    ['a one-character tld', 'user@example.c'],
    ['an empty string', ''],
  ])('%s', (_label, text) => {
    expect(containsEmailAddress(text)).toBe(false);
  });
});
