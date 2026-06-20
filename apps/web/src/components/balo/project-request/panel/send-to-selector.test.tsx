import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { SendToSelector } from './send-to-selector';

const BASE = {
  expertName: 'Priya Sharma',
  expertInitials: 'PS',
  expertAvatarKey: null,
} as const;

describe('SendToSelector', () => {
  it('renders a radiogroup with both options', () => {
    render(<SendToSelector value="direct" onChange={vi.fn()} {...BASE} />);
    expect(screen.getByRole('radiogroup', { name: /send request to/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /send to priya sharma/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /find me an expert/i })).toBeInTheDocument();
  });

  it('marks the Direct card checked by default', () => {
    render(<SendToSelector value="direct" onChange={vi.fn()} {...BASE} />);
    expect(screen.getByRole('radio', { name: /send to priya sharma/i })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('radio', { name: /find me an expert/i })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  it('reflects the Match selection', () => {
    render(<SendToSelector value="match" onChange={vi.fn()} {...BASE} />);
    expect(screen.getByRole('radio', { name: /find me an expert/i })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('fires onChange with the chosen routing', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SendToSelector value="direct" onChange={onChange} {...BASE} />);

    await user.click(screen.getByRole('radio', { name: /find me an expert/i }));
    expect(onChange).toHaveBeenCalledWith('match');

    await user.click(screen.getByRole('radio', { name: /send to priya sharma/i }));
    expect(onChange).toHaveBeenCalledWith('direct');
  });

  it('shows initials when there is no avatar', () => {
    render(<SendToSelector value="direct" onChange={vi.fn()} {...BASE} />);
    expect(screen.getByText('PS')).toBeInTheDocument();
  });

  it('renders a neutral Direct card with no expert (context-free)', () => {
    render(<SendToSelector value="match" onChange={vi.fn()} />);
    // Neutral label instead of an expert name; the Match card is the default.
    expect(screen.getByRole('radio', { name: /send to an expert/i })).toBeInTheDocument();
    expect(screen.queryByText('PS')).not.toBeInTheDocument();
  });

  it('still fires onChange to direct from the neutral context-free card', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SendToSelector value="match" onChange={onChange} />);
    await user.click(screen.getByRole('radio', { name: /send to an expert/i }));
    expect(onChange).toHaveBeenCalledWith('direct');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<SendToSelector value="direct" onChange={vi.fn()} {...BASE} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no accessibility violations in context-free mode', async () => {
    const { container } = render(<SendToSelector value="match" onChange={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
