import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { FlowStepper, type FlowStep } from './stepper';

const STEPS: FlowStep[] = [
  { key: 'choose', label: 'Choose a time' },
  { key: 'review', label: 'Review & confirm' },
  { key: 'done', label: 'Done' },
];

describe('FlowStepper', () => {
  it('renders every step label', () => {
    render(<FlowStepper steps={STEPS} current="review" />);
    expect(screen.getByText('Choose a time')).toBeInTheDocument();
    expect(screen.getByText('Review & confirm')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('marks the active step with aria-current when non-interactive', () => {
    render(<FlowStepper steps={STEPS} current="review" />);
    const active = screen.getByText('Review & confirm').closest('[aria-current]');
    expect(active).toHaveAttribute('aria-current', 'step');
  });

  it('renders completed steps as clickable buttons that call onJump', async () => {
    const onJump = vi.fn();
    const user = userEvent.setup();
    render(<FlowStepper steps={STEPS} current="review" onJump={onJump} />);

    const completed = screen.getByRole('button', { name: /Choose a time/ });
    await user.click(completed);
    expect(onJump).toHaveBeenCalledWith('choose');
  });

  it('does not make the active or future steps clickable', () => {
    render(<FlowStepper steps={STEPS} current="review" onJump={vi.fn()} />);
    // only the single completed step ("Choose a time") is a button
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Review & confirm/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Done/ })).not.toBeInTheDocument();
  });

  it('is fully non-interactive when no onJump is provided', () => {
    render(<FlowStepper steps={STEPS} current="review" />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<FlowStepper steps={STEPS} current="review" onJump={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
