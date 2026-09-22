import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import {
  OnboardingProgress,
  OnboardingProgressSkeleton,
  onboardingStepLabel,
} from './onboarding-progress';

function segmentClasses(progressbar: HTMLElement): string[] {
  return Array.from(progressbar.children).map((segment) => segment.className);
}

describe('OnboardingProgress', () => {
  it('exposes the step position as a labelled progressbar', () => {
    render(<OnboardingProgress current={3} total={4} />);
    const progressbar = screen.getByRole('progressbar', { name: 'Onboarding progress' });
    expect(progressbar).toHaveAttribute('aria-valuenow', '3');
    expect(progressbar).toHaveAttribute('aria-valuemin', '1');
    expect(progressbar).toHaveAttribute('aria-valuemax', '4');
    expect(progressbar).toHaveAttribute('aria-valuetext', 'Step 3 of 4');
  });

  it('renders one segment per step: completed, current, then upcoming', () => {
    render(<OnboardingProgress current={3} total={5} />);
    const classes = segmentClasses(screen.getByRole('progressbar'));
    expect(classes).toHaveLength(5);
    expect(classes.map((c) => c.split(' ').find((token) => token.startsWith('bg-')))).toEqual([
      'bg-primary/40',
      'bg-primary/40',
      'bg-primary',
      'bg-border',
      'bg-border',
    ]);
  });

  it('captions the bar with the step count, hidden from assistive tech', () => {
    render(<OnboardingProgress current={1} total={4} />);
    const caption = screen.getByText('Step 1 of 4');
    expect(caption).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('onboardingStepLabel', () => {
  it('formats the step count', () => {
    expect(onboardingStepLabel(2, 5)).toBe('Step 2 of 5');
  });
});

describe('OnboardingProgressSkeleton', () => {
  it('renders a non-semantic placeholder', () => {
    const { container } = render(<OnboardingProgressSkeleton />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(2);
  });
});
