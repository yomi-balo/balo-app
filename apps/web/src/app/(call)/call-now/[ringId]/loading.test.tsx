import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from '@/test/axe';
import CallNowLoading from './loading';

describe('CallNowLoading', () => {
  it('tells the viewer the call is opening', () => {
    render(<CallNowLoading />);

    expect(screen.getByText('Opening your call…')).toBeInTheDocument();
  });

  it('uses <output>, not role="status"', () => {
    const { container } = render(<CallNowLoading />);

    expect(container.querySelector('output')).not.toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(<CallNowLoading />);

    expect(await axe(container)).toHaveNoViolations();
  });
});
