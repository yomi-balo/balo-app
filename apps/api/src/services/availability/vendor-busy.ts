/**
 * BAL-129 — VENDOR FREE/BUSY, RESOLVED IN EXACTLY ONE PLACE FOR BOTH READS.
 *
 * ⚠⚠ THIS MODULE EXISTS TO MAKE ONE SPECIFIC DIVERGENCE UNREPRESENTABLE, and it is the ONLY
 * resolver input that was not already shared. `./resolver-inputs.ts` extracted the three
 * ROW projections (rules, consultations, overrides) so the two reads cannot interpret the
 * same rows differently. Vendor free/busy is not a row projection — it is a fetch — so it
 * escaped that extraction and each read defaulted it to `[]` independently:
 *
 *   · `resolve-and-cache.ts` → what every surface ADVERTISES.
 *   · `window-availability.ts` → what a booking is ACCEPTED against.
 *
 * `apps/api/src/jobs/availability-cache.ts` records that BAL-194/195 will wire Cronofy
 * free/busy "through this same call site" — the ADVERTISE one. Had the accept path kept its
 * own `[]`, that wiring would have silently stopped the booking gate honouring an expert's
 * real external commitments, and NOTHING would have failed: not a type, not a test, not a
 * helper. A shared literal would only have been a grep target. A shared PORT is a compile
 * dependency: there is one implementation, both paths call it, and BAL-194/195 replaces it
 * once for both.
 *
 * ⚠ SO DO NOT RE-INLINE `[]` AT EITHER CALL SITE, and do not give this a second
 * implementation keyed on which caller is asking. If advertise and accept ever SHOULD read
 * different vendor busy (they should not), that is a product ruling that belongs in one
 * documented branch here, never in two files that drifted apart.
 *
 * ⚠ THE ONE PLACE A CALLER MAY STILL SUPPLY ITS OWN IS `ResolveAndCacheOptions.busyBlocks`,
 * and that override is SEED/TEST-ONLY — see its docblock in `./resolve-and-cache.ts` for the
 * divergence it deliberately accepts.
 */
import type { BusyBlock } from './types.js';

/**
 * The seam a calendar vendor plugs into. Mirrors the injectable-port precedent already in
 * this codebase (`RoomProvisioner` in `services/daily/rooms.ts`, `LlmClient` in
 * `services/transcript/llm/`): an interface plus one live object, so a future vendor lands
 * in a single file and every consumer picks it up at once.
 *
 * `[from, to)` is the range the caller needs answered — the advertise path asks about its
 * whole horizon, the accept path about one padded window. A vendor implementation MUST NOT
 * assume either shape.
 */
export interface VendorBusyProvider {
  listBusyBlocks(expertProfileId: string, from: Date, to: Date): Promise<BusyBlock[]>;
}

/**
 * THE LIVE IMPLEMENTATION — `[]` until BAL-194/195 wires Cronofy.
 *
 * ⚠ IT DECLARES NO PARAMETERS ON PURPOSE. TypeScript lets an implementation ignore trailing
 * parameters it does not use, so the port can carry the full `(expertProfileId, from, to)`
 * contract BAL-194/195 needs WITHOUT this placeholder carrying three unused bindings. The
 * call sites already pass all three, so wiring a real vendor here is a body change and
 * nothing else.
 */
export const vendorBusyProvider: VendorBusyProvider = {
  listBusyBlocks(): Promise<BusyBlock[]> {
    return Promise.resolve([]);
  },
};
