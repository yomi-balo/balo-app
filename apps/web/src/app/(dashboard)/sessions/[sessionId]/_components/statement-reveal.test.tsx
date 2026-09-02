import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

import { StatementReveal } from './statement-reveal';

describe('StatementReveal', () => {
  it('renders its children through the reveal wrapper', () => {
    render(
      <StatementReveal>
        <p>Statement body</p>
      </StatementReveal>
    );
    expect(screen.getByText('Statement body')).toBeInTheDocument();
  });
});
