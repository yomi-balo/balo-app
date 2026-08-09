import { describe, expect, it } from 'vitest';
import { vendorBusyProvider } from './vendor-busy.js';

/**
 * BAL-129 — the vendor free/busy PORT.
 *
 * The value of this module is not its body (it returns `[]`); it is that ONE body answers
 * BOTH the advertise read (`resolve-and-cache.ts`) and the accept read
 * (`window-availability.ts`). The tests that matter for that property live in those two
 * files — each asserts it calls THIS provider rather than inlining its own `[]`, so wiring
 * Cronofy here cannot reach one path and miss the other.
 */
describe('vendorBusyProvider', () => {
  it('answers [] for any expert and any range — no vendor is wired yet (BAL-194/195)', async () => {
    await expect(
      vendorBusyProvider.listBusyBlocks(
        '66666666-6666-4666-8666-666666666666',
        new Date('2026-09-07T00:00:00.000Z'),
        new Date('2026-09-21T00:00:00.000Z')
      )
    ).resolves.toEqual([]);
  });

  it('returns a FRESH array each call — no shared mutable placeholder', async () => {
    // The two reads fold this into `[...busyBlocks, ...overrideBlocks]`. A single frozen or
    // shared array would work today, but a returned singleton is exactly the kind of thing a
    // future caller mutates in place; a fresh array makes that impossible to get wrong.
    const from = new Date('2026-09-07T00:00:00.000Z');
    const to = new Date('2026-09-08T00:00:00.000Z');

    const first = await vendorBusyProvider.listBusyBlocks('expert-a', from, to);
    const second = await vendorBusyProvider.listBusyBlocks('expert-a', from, to);

    expect(first).not.toBe(second);
  });
});
