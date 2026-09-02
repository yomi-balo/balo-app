// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { SessionStatementView } from '@/app/(dashboard)/sessions/[sessionId]/_lib/session-statement-view';
import {
  SessionStatementPdfDocument,
  renderSessionStatementPdfToBuffer,
} from './session-statement-pdf-document';

const CLIENT_MONEY: SessionStatementView = {
  lens: 'client',
  sessionId: 'session_1',
  mode: { kind: 'money' },
  occurredAtIso: '2026-08-12T10:00:00.000Z',
  title: 'Static analysis walkthrough',
  counterparty: { name: 'Priya Sharma', orgLabel: 'CloudPeak Consulting' },
  meetingId: 'meeting_1',
  block: {
    lens: 'client',
    state: 'finalized',
    sessionId: 'session_1',
    durationMinutes: 45,
    amountAudMinor: 15_750,
    ratePerMinuteMinor: 350,
    settlementStatus: 'not_required',
    actualMinutes: 45,
    billingFloorApplied: false,
    billingFloorMinutes: 0,
  },
};

const EXPERT_MONEY: SessionStatementView = {
  lens: 'expert',
  sessionId: 'session_1',
  mode: { kind: 'money' },
  occurredAtIso: '2026-08-12T10:00:00.000Z',
  title: 'Static analysis walkthrough',
  counterparty: { name: 'Northwind Industrial', orgLabel: null },
  meetingId: 'meeting_1',
  payout: {
    reference: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    recordedAtIso: '2026-08-12T11:00:00.000Z',
  },
  block: {
    lens: 'expert',
    state: 'finalized',
    sessionId: 'session_1',
    durationMinutes: 45,
    earningsAudMinor: 11_250,
    payoutStatus: 'recorded',
    actualMinutes: 45,
    billingFloorApplied: false,
    billingFloorMinutes: 0,
  },
};

/** Recursively collect all rendered text — mirrors `proposal-pdf-document.test.tsx`'s helper. */
function collectText(node: React.ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (typeof node === 'object' && node !== null && 'type' in node && 'props' in node) {
    const el = node as { type: unknown; props: { children?: React.ReactNode } };
    if (typeof el.type === 'function') {
      const renderComponent = el.type as (props: unknown) => React.ReactNode;
      return collectText(renderComponent(el.props));
    }
    return collectText(el.props.children);
  }
  return '';
}

describe('SessionStatementPdfDocument — render smoke', () => {
  it('renders a client receipt to a non-empty PDF buffer (Geist embedded)', async () => {
    const buffer = await renderSessionStatementPdfToBuffer({ view: CLIENT_MONEY });
    expect(buffer.byteLength).toBeGreaterThan(1000);
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('renders an expert payout statement to a non-empty PDF buffer', async () => {
    const buffer = await renderSessionStatementPdfToBuffer({ view: EXPERT_MONEY });
    expect(buffer.byteLength).toBeGreaterThan(1000);
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  // D-C: the zero-money and cancelled shapes get NO PDF — there is nothing to forward for a call
  // that was never billed. This used to assert a RENDER of that document, i.e. it covered a path
  // both Route Handlers 404 and that must not exist. It now pins the refusal instead.
  it.each(['zero', 'cancelled'])('REFUSES to render a %s-mode statement (D-C)', (kind) => {
    const view = { ...CLIENT_MONEY, mode: { kind } } as SessionStatementView;
    expect(() => SessionStatementPdfDocument({ view })).toThrow(/Refusing to render/);
  });
});

describe('SessionStatementPdfDocument — fee safety (structural, per plan §10)', () => {
  it("the CLIENT render's text carries no expert-earnings figure and no payout row", () => {
    const text = collectText(SessionStatementPdfDocument({ view: CLIENT_MONEY }));
    expect(text).toContain('A$157.50'); // the client's own all-in charge
    expect(text).not.toContain('A$112.50'); // the expert's earnings — never on the client PDF
    expect(text).not.toContain('Reference');
    expect(text).not.toContain('Recorded');
  });

  it("the EXPERT render's text carries no client charge and no rate row", () => {
    const text = collectText(SessionStatementPdfDocument({ view: EXPERT_MONEY }));
    expect(text).toContain('A$112.50'); // the expert's own earnings
    expect(text).not.toContain('A$157.50'); // the client's charge — never on the expert PDF
    expect(text).not.toContain('Rate per minute');
  });

  it('the expert render DOES carry the payout reference + recorded date once booked', () => {
    const text = collectText(SessionStatementPdfDocument({ view: EXPERT_MONEY }));
    expect(text).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(text).toContain('12 Aug 2026');
  });

  it('renders the counterparty COMPANY on the expert lens, the expert PERSON on the client lens', () => {
    const clientText = collectText(SessionStatementPdfDocument({ view: CLIENT_MONEY }));
    expect(clientText).toContain('Priya Sharma');
    expect(clientText).toContain('CloudPeak Consulting');

    const expertText = collectText(SessionStatementPdfDocument({ view: EXPERT_MONEY }));
    expect(expertText).toContain('Northwind Industrial');
  });
});
