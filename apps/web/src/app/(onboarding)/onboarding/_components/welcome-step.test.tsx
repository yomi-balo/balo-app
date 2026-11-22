import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { WelcomeStep } from './welcome-step';

describe('WelcomeStep', () => {
  it('greets by name and shows the signed-off welcome copy', () => {
    render(<WelcomeStep firstName="Dana" onContinue={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Welcome to Balo, Dana!' })).toBeInTheDocument();
    expect(
      screen.getByText('Fast, affordable engagements, delivered by vetted, high-quality experts.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/gateway to expert/i)).not.toBeInTheDocument();
  });
});
