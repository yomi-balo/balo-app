import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ExpertCardSkeleton } from './expert-card-skeleton';

describe('ExpertCardSkeleton', () => {
  it('renders the grid skeleton by default with a loading status role', () => {
    render(<ExpertCardSkeleton />);
    const status = screen.getByRole('status', { name: 'Loading expert card' });
    expect(status).toBeInTheDocument();
    // Grid variant uses an aspect-ratio photo box that the list variant does not.
    expect(status.querySelector('.aspect-\\[5\\/4\\]')).not.toBeNull();
  });

  it('renders the grid skeleton when variant="grid"', () => {
    render(<ExpertCardSkeleton variant="grid" />);
    const status = screen.getByRole('status', { name: 'Loading expert card' });
    expect(status.querySelector('.aspect-\\[5\\/4\\]')).not.toBeNull();
  });

  it('renders the list skeleton when variant="list"', () => {
    render(<ExpertCardSkeleton variant="list" />);
    const status = screen.getByRole('status', { name: 'Loading expert card' });
    // List variant has a fixed-width photo panel (w-60) and no aspect-ratio box.
    expect(status.querySelector('.w-60')).not.toBeNull();
    expect(status.querySelector('.aspect-\\[5\\/4\\]')).toBeNull();
  });
});
