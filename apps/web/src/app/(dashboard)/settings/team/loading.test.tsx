import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Loading from './loading';

describe('Members & access loading skeleton', () => {
  it('renders skeleton cards for all three sections', () => {
    render(<Loading />);
    expect(screen.getByRole('heading', { name: 'Domains' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Join mode' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Join requests' })).toBeInTheDocument();
    expect(screen.getAllByRole('status', { name: /loading/i })).toHaveLength(3);
  });
});
