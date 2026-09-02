import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { StatementNotFound } from './statement-not-found';

describe('StatementNotFound', () => {
  it('uses ONE copy that does not distinguish missing from forbidden (client)', () => {
    render(<StatementNotFound lens="client" />);
    expect(
      screen.getByRole('heading', { name: "We couldn't find that receipt" })
    ).toBeInTheDocument();
    const body = screen.getByText(/moved, or you may not have access/);
    expect(body.textContent).not.toMatch(/permission|participant|forbidden|member|tenant/i);
  });

  it('renders the payout-scoped heading on the expert lens', () => {
    render(<StatementNotFound lens="expert" />);
    expect(
      screen.getByRole('heading', { name: "We couldn't find that payout" })
    ).toBeInTheDocument();
  });

  it('does NOT inherit the sibling copy — receipt heading absent on the expert render', () => {
    render(<StatementNotFound lens="expert" />);
    expect(screen.queryByText("We couldn't find that receipt")).not.toBeInTheDocument();
  });

  it('offers a way out', () => {
    render(<StatementNotFound lens="client" />);
    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toBeInTheDocument();
  });
});
