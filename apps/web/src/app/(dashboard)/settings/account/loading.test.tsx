import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import Loading from './loading';

describe('Account settings loading', () => {
  it('renders the name card skeleton', () => {
    render(<Loading />);
    expect(screen.getByTestId('account-name-skeleton')).toBeInTheDocument();
  });
});
