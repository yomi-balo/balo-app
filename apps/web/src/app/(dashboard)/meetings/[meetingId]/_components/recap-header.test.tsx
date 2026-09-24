import { describe, it, expect } from 'vitest';
import { render } from '@/test/utils';
import type {
  RecapHeaderView,
  RecapMoneyView,
  SessionMoneyBlock,
} from '@/lib/meetings/recap-view-types';
import { RecapHeader } from './recap-header';

const HEADER: RecapHeaderView = {
  eyebrow: 'Consultation',
  caseHref: null,
  title: 'Flow interview stuck on a loop',
  status: { label: 'Not held', tone: 'neutral', icon: 'ban' },
  closedNote: null,
  occurredAtIso: '2026-07-29T04:00:00.000Z',
  durationMinutes: null,
  openActionItemCount: 0,
  totalActionItemCount: 0,
};

const CLIENT_MISSED_CALL: SessionMoneyBlock = {
  lens: 'client',
  state: 'finalized',
  sessionId: 'session_1',
  durationMinutes: 0,
  amountAudMinor: 0,
  ratePerMinuteMinor: 333,
  settlementStatus: 'not_required',
  finalizationPath: 'presence',
  actualMinutes: 0,
  billingFloorApplied: false,
  billingFloorMinutes: 15,
  settlementShape: 'missed_call',
};

function sessionMoney(clientSideEverPresent: boolean | null): RecapMoneyView {
  return { kind: 'session', block: CLIENT_MISSED_CALL, elapsedMinutes: 0, clientSideEverPresent };
}

describe('RecapHeader — the money line carries client-side presence to the fragment', () => {
  it('names NOBODY when the money view says nobody client-side joined', () => {
    const { container } = render(<RecapHeader header={HEADER} money={sessionMoney(false)} />);
    expect(container.textContent).toContain('Not charged — nobody joined this time');
    expect(container.textContent).not.toContain('your consultant');
  });

  it.each([true, null] as const)(
    'keeps the line naming the consultant when clientSideEverPresent=%s',
    (clientSideEverPresent) => {
      const { container } = render(
        <RecapHeader header={HEADER} money={sessionMoney(clientSideEverPresent)} />
      );
      expect(container.textContent).toContain(
        "Not charged — your consultant didn't join this time"
      );
      expect(container.textContent).not.toContain('nobody joined');
    }
  );
});
