import { describe, it, expect } from 'vitest';
import { render } from '@/test/utils';
import ProposalComposerLoading from './loading';

describe('ProposalComposerLoading', () => {
  it('renders the composer skeleton (animated placeholders)', () => {
    const { container } = render(<ProposalComposerLoading />);
    // The skeleton is pure markup — assert the animate-pulse placeholders mount.
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });
});
