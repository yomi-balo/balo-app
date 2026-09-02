import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { SettlementStatusNote } from './settlement-status-note';

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
    render(<SettlementStatusNote settlementStatus="processing" />);
    expect(screen.getByText(/still settling/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders the failed note WITH a Manage billing link to /billing', () => {
    render(<SettlementStatusNote settlementStatus="failed" />);
    const link = screen.getByRole('link', { name: 'Manage billing' });
    expect(link).toHaveAttribute('href', '/billing');
  });

  it('renders the requires_action note WITH a Manage billing link', () => {
    render(<SettlementStatusNote settlementStatus="requires_action" />);
    expect(screen.getByRole('link', { name: 'Manage billing' })).toBeInTheDocument();
  });

  it('never uses the word "overdraft"', () => {
    for (const status of ['processing', 'failed', 'requires_action']) {
      const { container, unmount } = render(<SettlementStatusNote settlementStatus={status} />);
      expect(container.textContent?.toLowerCase()).not.toContain('overdraft');
      unmount();
    }
  });
});
