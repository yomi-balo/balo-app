import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { StatementRateLimited } from './statement-rate-limited';

const SESSION_ID = 'a0000000-0000-4000-8000-000000000001';

describe('StatementRateLimited (BAL-519)', () => {
  it('states the calm, shared cause', () => {
    render(<StatementRateLimited lens="client" sessionId={SESSION_ID} />);
    expect(screen.getByRole('heading', { name: 'Hold tight' })).toBeInTheDocument();
    expect(screen.getByText(/loading this a little quickly/)).toBeInTheDocument();
  });

  it('renders the SAME copy on both lenses (D4)', () => {
    const { container: client } = render(
      <StatementRateLimited lens="client" sessionId={SESSION_ID} />
    );
    const clientText = client.textContent;
    const { container: expert } = render(
      <StatementRateLimited lens="expert" sessionId={SESSION_ID} />
    );
    expect(expert.textContent).toBe(clientText);
  });

  it('never blames the reader and never says the receipt is missing', () => {
    const { container } = render(<StatementRateLimited lens="expert" sessionId={SESSION_ID} />);
    const text = container.textContent ?? '';
    expect(text.toLowerCase()).not.toMatch(/slow down|too many|abuse|blocked|error|couldn/);
    expect(text).not.toMatch(/find that (receipt|payout)/);
  });

  // D4: no countdown. The component takes no cooldown prop, so this is a belt-and-braces pin on
  // the rendered surface. The retry link's `href` carries the sessionId, but an href is an
  // attribute, not text content, so this still holds.
  it('shows NO countdown — no digits anywhere', () => {
    const { container } = render(<StatementRateLimited lens="client" sessionId={SESSION_ID} />);
    expect(container.textContent ?? '').not.toMatch(/[0-9]/);
  });

  // UX1 (fix round 1) — the retry action must actually retry: it links back to the SAME
  // statement the reader was trying to read, per lens, not away to `/dashboard`.
  it('retries the CLIENT statement, not the dashboard', () => {
    render(<StatementRateLimited lens="client" sessionId={SESSION_ID} />);
    const link = screen.getByRole('link', { name: 'Try again' });
    expect(link).toHaveAttribute('href', `/sessions/${SESSION_ID}/receipt`);
  });

  it('retries the EXPERT statement, not the dashboard', () => {
    render(<StatementRateLimited lens="expert" sessionId={SESSION_ID} />);
    const link = screen.getByRole('link', { name: 'Try again' });
    expect(link).toHaveAttribute('href', `/sessions/${SESSION_ID}/payout`);
  });
});
