import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';

import { GhostClientsCard } from './ghost-clients-card';

describe('GhostClientsCard', () => {
  it('carries the shared dashboard card chrome and grows as the last side card', () => {
    render(<GhostClientsCard />);
    const card = screen.getByText('Top Clients').closest('.rounded-2xl');
    expect(card).toHaveClass('rounded-2xl', 'shadow-sm', 'lg:flex-1');
  });
});
