import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { ComposerSection } from './composer-section';

describe('ComposerSection', () => {
  it('renders a section labelled by its h2 heading', () => {
    render(
      <ComposerSection id="proposal-section-overview" title="Overview">
        <p>body</p>
      </ComposerSection>
    );
    const region = screen.getByRole('region', { name: 'Overview' });
    expect(region).toHaveAttribute('id', 'proposal-section-overview');
    expect(screen.getByRole('heading', { level: 2, name: 'Overview' })).toHaveAttribute(
      'id',
      'proposal-section-overview-heading'
    );
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('shows the Optional tag, help line and aside slot when provided', () => {
    render(
      <ComposerSection
        id="proposal-section-exclusions"
        title="Not included"
        optional
        help="Anything out of scope."
        aside={<button type="button">Clear</button>}
      >
        <span>child</span>
      </ComposerSection>
    );
    expect(screen.getByText('Optional')).toBeInTheDocument();
    expect(screen.getByText('Anything out of scope.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
  });

  it('omits the Optional tag, help and aside by default', () => {
    render(
      <ComposerSection id="proposal-section-milestones" title="Milestones">
        <span>child</span>
      </ComposerSection>
    );
    expect(screen.queryByText('Optional')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
