import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import MarketingAnonLayout from './layout';

vi.mock('@/components/marketing/marketing-header', () => ({
  MarketingHeader: ({ viewer }: { viewer: unknown }) => (
    <div data-testid="marketing-header">{viewer === null ? 'null' : 'non-null'}</div>
  ),
}));

describe('MarketingAnonLayout', () => {
  it('renders MarketingHeader with viewer null, then its children', () => {
    render(
      <MarketingAnonLayout>
        <p>Body</p>
      </MarketingAnonLayout>
    );

    expect(screen.getByTestId('marketing-header')).toHaveTextContent('null');
    expect(screen.getByText('Body')).toBeInTheDocument();
  });
});
