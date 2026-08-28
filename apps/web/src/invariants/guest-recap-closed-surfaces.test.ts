import { describe, expect, it } from 'vitest';
import { resolveRouteDir, scanRouteSources } from './_source-scan';

/**
 * BAL-439 §8.5 — the guest recap's NAMED FAIL-CLOSED SEAM, as a TEST rather than a docblock.
 *
 * R6 closes five surfaces to a guest — money, counterparty/roster, action items, transcripts and
 * recording playback — by ABSENCE OF FIELDS on `GuestRecapView` (§5.2), not by a runtime branch.
 * This invariant is the structural proof that stays true: it scans every source file under
 * `app/join/[token]/recap/` and fails if any of them so much as NAMES the closed surfaces, so a
 * future edit cannot silently re-open one by adding a field, an import or a call that this
 * ticket's own view-model was built to make impossible.
 *
 * ⚠ ALSO RESTATES R3 ON THIS TREE: `guestMayReadMeeting` must be reached ONLY through
 * `authorizeMeetingFileAccess`, never imported or called directly here — this is the recap's own
 * axis of that rule, alongside `resolve-recap-access.test.ts`'s pin on the member sibling.
 *
 * ⚠ ALSO PROVES THE MEMBER GATE IS UNREACHABLE FROM THIS TREE: no file under `recap/` may name
 * `resolveRecapAccess` or `loadRecap` — the guest recap has its own sibling gate and loader (R5)
 * and must never fall back onto the member ones.
 */

const RECAP_DIR = resolveRouteDir([
  'src/app/join/[token]/recap',
  'apps/web/src/app/join/[token]/recap',
]);

/**
 * The closed surfaces, named literally. Any occurrence anywhere in this tree — a component, the
 * loader, the gate, even a "we deliberately don't import X" comment that got clumsy — is a fail:
 * `codeLinesOf` strips comments before this scan runs, so a naming inside a real comment cannot
 * trip it, but a naming in CODE always can.
 */
const FORBIDDEN_TOKENS: readonly string[] = [
  'getMeetingRecordingPlayback',
  'RecordingBlock',
  'recording-block',
  'MoneyBlock',
  'SessionMoneyBlock',
  'fetchSessionMoneyBlock',
  'ActionItemsPanel',
  'PartyCard',
  'resolve-counterparty',
  'mapRecapRecordings',
  "'cleaned'",
  'meetingRecordingsRepository',
  'creditSessionsRepository',
  'usersRepository',
];

describe('invariant: the guest recap never reaches a closed surface (BAL-439)', () => {
  const scanned = scanRouteSources(RECAP_DIR, '', []);

  it('guards the guard: the recap tree resolves, has at least seven files, and the files card genuinely calls the shipped download action', () => {
    expect(RECAP_DIR).not.toBe('');
    expect(scanned.length).toBeGreaterThanOrEqual(7);
    const filesCard = scanned.find((file) => file.rel === '_components/guest-recap-files.tsx');
    expect(filesCard).toBeDefined();
    expect(filesCard?.code ?? '').toContain('getGuestMeetingFileDownloadAction');
  });

  it('no file under recap/ names a surface R6 closes to a guest', () => {
    const offenders: string[] = [];
    for (const file of scanned) {
      for (const token of FORBIDDEN_TOKENS) {
        if (file.code.includes(token)) offenders.push(`${file.rel} → ${token}`);
      }
    }
    expect(
      offenders,
      `These files under app/join/[token]/recap/ name a surface R6 closes to a guest — money, ` +
        `counterparty/roster, action items, transcripts or recording playback. The guest recap ` +
        `is a structural absence of these fields, never a runtime branch that hides them:\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });

  it('the MEMBER recap gate and loader are unreachable from this tree', () => {
    const offenders = scanned
      .filter((file) => file.code.includes('resolveRecapAccess') || file.code.includes('loadRecap'))
      .map((file) => file.rel);
    expect(
      offenders,
      `These files under recap/ name the MEMBER gate/loader. The guest recap has its own ` +
        `sibling gate (resolveGuestRecapAccess) and loader (loadGuestRecap) — R5 — and must ` +
        `never fall back onto the member ones:\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });

  it('⚠ R3 restated on the new axis: no file under recap/ names guestMayReadMeeting directly', () => {
    const offenders = scanned
      .filter((file) => file.code.includes('guestMayReadMeeting'))
      .map((file) => file.rel);
    expect(
      offenders,
      `These files under recap/ name guestMayReadMeeting directly. The predicate is reached ` +
        `ONLY through authorizeMeetingFileAccess, one module further in — "who may read this ` +
        `meeting" keeps exactly one definition:\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });
});
