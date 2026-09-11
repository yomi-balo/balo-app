import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { HealthErrorState } from './health-error-state';

describe('HealthErrorState', () => {
  it('renders the caught-failure copy', () => {
    render(<HealthErrorState />);
    expect(screen.getByText('Could not load capture health')).toBeInTheDocument();
  });
});
