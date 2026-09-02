import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { StatementPageShell, StatementCard } from './statement-page-shell';

describe('StatementPageShell / StatementCard', () => {
  it('renders children inside the shared container width', () => {
    render(
      <StatementPageShell>
        <StatementCard>
          <p>Hello</p>
        </StatementCard>
      </StatementPageShell>
    );
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('the shell uses the shared max-w-2xl container', () => {
    const { container } = render(<StatementPageShell>content</StatementPageShell>);
    expect(container.querySelector('.max-w-2xl')).not.toBeNull();
  });
});
