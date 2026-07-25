import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Loading from './loading';

describe('Platform config loading skeleton', () => {
  it('renders an accessible busy skeleton', () => {
    render(<Loading />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText(/loading platform config/i)).toBeInTheDocument();
  });
});
