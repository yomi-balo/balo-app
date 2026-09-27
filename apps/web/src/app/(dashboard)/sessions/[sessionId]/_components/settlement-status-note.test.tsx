import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { SettlementStatusNote } from './settlement-status-note';

const HELD = {
  processing: "The part of this consultation your balance didn't cover is still settling.",
  failed: "The part of this consultation your balance didn't cover couldn't be charged to a card.",
  requires_action:
    "The part of this consultation your balance didn't cover needed an extra card confirmation when we tried to charge it.",
} as const;

const NO_SHOW = {
  processing:
    "This booking was billed at its minimum charge, and the part your balance didn't cover is still settling.",
  failed:
    "This booking was billed at its minimum charge, and the part your balance didn't cover couldn't be charged to a card.",
  requires_action:
    "This booking was billed at its minimum charge, and the part your balance didn't cover needed an extra card confirmation when we tried to charge it.",
} as const;

describe('SettlementStatusNote', () => {
  it('renders nothing for `not_required` (the ordinary fully-funded session)', () => {
    const { container } = render(<SettlementStatusNote settlementStatus="not_required" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for `settled` (the total already says it was charged)', () => {
    const { container } = render(<SettlementStatusNote settlementStatus="settled" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the processing note WITHOUT a Manage billing link', () => {
    render(<SettlementStatusNote settlementStatus="processing" settlementShape="held" />);
    expect(screen.getByText(/still settling/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders the failed note WITH a Manage billing link to /settings/billing (`/billing` has no page)', () => {
    render(<SettlementStatusNote settlementStatus="failed" settlementShape="held" />);
    const link = screen.getByRole('link', { name: 'Manage billing' });
    expect(link).toHaveAttribute('href', '/settings/billing');
    expect(link).not.toHaveAttribute('href', '/billing');
  });

  it('renders the requires_action note WITH a Manage billing link to /settings/billing', () => {
    render(<SettlementStatusNote settlementStatus="requires_action" settlementShape="held" />);
    expect(screen.getByRole('link', { name: 'Manage billing' })).toHaveAttribute(
      'href',
      '/settings/billing'
    );
  });

  describe('shape-aware copy (copy v2.1 §7, verbatim)', () => {
    it.each(['processing', 'failed', 'requires_action'] as const)('held × %s', (status) => {
      const { container } = render(
        <SettlementStatusNote settlementStatus={status} settlementShape="held" />
      );
      expect(container.querySelector('p')?.textContent?.startsWith(HELD[status])).toBe(true);
    });

    it.each(['processing', 'failed', 'requires_action'] as const)(
      'no_show_client × %s says the booking was billed at its minimum',
      (status) => {
        const { container } = render(
          <SettlementStatusNote settlementStatus={status} settlementShape="no_show_client" />
        );
        expect(container.querySelector('p')?.textContent?.startsWith(NO_SHOW[status])).toBe(true);
      }
    );

    it('no_show_client + failed is the no-show string, NOT the held one (the defect this fixes)', () => {
      render(<SettlementStatusNote settlementStatus="failed" settlementShape="no_show_client" />);
      expect(screen.getByText(/billed at its minimum charge/)).toBeInTheDocument();
      expect(screen.queryByText(/The part of this consultation/)).not.toBeInTheDocument();
    });

    it.each(['missed_call', 'abandoned_wait'] as const)(
      'the %s shape reads as an ordinary consultation (only no_show_client is minimum-billed)',
      (shape) => {
        render(<SettlementStatusNote settlementStatus="failed" settlementShape={shape} />);
        expect(screen.getByText(/The part of this consultation/)).toBeInTheDocument();
      }
    );

    it('a pre-BAL-412 row (no shape at all) falls back to the held wording', () => {
      const { container } = render(<SettlementStatusNote settlementStatus="processing" />);
      expect(container.querySelector('p')?.textContent).toBe(HELD.processing);
    });
  });

  it('never uses "overdraft", "extra time", "the card on file" or "a little"', () => {
    for (const shape of ['held', 'no_show_client'] as const) {
      for (const status of ['processing', 'failed', 'requires_action']) {
        const { container, unmount } = render(
          <SettlementStatusNote settlementStatus={status} settlementShape={shape} />
        );
        const text = container.textContent?.toLowerCase() ?? '';
        expect(text.length).toBeGreaterThan(0);
        for (const banned of ['overdraft', 'extra time', 'card on file', 'a little', 'a small']) {
          expect(text).not.toContain(banned);
        }
        unmount();
      }
    }
  });

  it('never implies money was collected when it was not (requires_action says "when we tried to charge it")', () => {
    render(<SettlementStatusNote settlementStatus="requires_action" settlementShape="held" />);
    expect(screen.getByText(/when we tried to charge it/)).toBeInTheDocument();
  });
});
