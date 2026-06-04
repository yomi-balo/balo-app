import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { Package } from 'lucide-react';
import { BarSegment } from './bar-segment';

describe('BarSegment', () => {
  it('shows the summary when present', () => {
    render(
      <BarSegment
        icon={Package}
        label="Product"
        summary="Agentforce +2"
        placeholder="Any"
        active={false}
        onClick={vi.fn()}
      />
    );
    expect(screen.getByText('Agentforce +2')).toBeInTheDocument();
    expect(screen.queryByText('Any')).not.toBeInTheDocument();
  });

  it('falls back to the placeholder when there is no summary', () => {
    render(
      <BarSegment
        icon={Package}
        label="Product"
        summary={null}
        placeholder="Any"
        active={false}
        onClick={vi.fn()}
      />
    );
    expect(screen.getByText('Any')).toBeInTheDocument();
  });

  it('reflects the open state via aria-expanded and fires onClick', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <BarSegment
        icon={Package}
        label="Product"
        summary={null}
        placeholder="Any"
        active
        onClick={onClick}
      />
    );
    const button = screen.getByRole('button', { name: /Product/ });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await user.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
