import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { useReducedMotion } from 'motion/react';
import type { SlotDurationMinutes } from '@balo/shared/availability';
import { render, screen } from '@/test/utils';
import { LengthControl } from './availability-length-control';

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  const stub = createMotionStub();
  return { ...stub, useReducedMotion: vi.fn(() => false) };
});

function setup(
  value: SlotDurationMinutes,
  available: readonly SlotDurationMinutes[]
): {
  onChange: ReturnType<typeof vi.fn>;
} {
  const onChange = vi.fn();
  render(
    <LengthControl
      value={value}
      onChange={onChange}
      isAvailable={(d) => available.includes(d)}
      days={14}
    />
  );
  return { onChange };
}

describe('LengthControl', () => {
  beforeEach(() => {
    vi.mocked(useReducedMotion).mockReturnValue(false);
  });

  it('is a labelled radiogroup with the checked item the only tab stop', () => {
    setup(60, [15, 30, 45, 60]);

    const group = screen.getByRole('radiogroup', { name: 'How long do you need?' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '60 min' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: '30 min' })).toHaveAttribute('tabindex', '-1');
  });

  it('renders exactly one indicator, inside the checked item', () => {
    const { container } = render(
      <LengthControl value={45} onChange={vi.fn()} isAvailable={() => true} days={14} />
    );

    const indicators = container.querySelectorAll('[data-motion]');
    expect(indicators).toHaveLength(1);
    expect(screen.getByRole('radio', { name: '45 min' })).toContainElement(
      indicators[0] as HTMLElement
    );
  });

  it('slides the indicator by default and snaps under reduced motion', () => {
    const { container, unmount } = render(
      <LengthControl value={60} onChange={vi.fn()} isAvailable={() => true} days={14} />
    );
    expect(container.querySelector('[data-motion]')).toHaveAttribute('data-motion', 'slide');
    unmount();

    vi.mocked(useReducedMotion).mockReturnValue(true);
    const reduced = render(
      <LengthControl value={60} onChange={vi.fn()} isAvailable={() => true} days={14} />
    );
    expect(reduced.container.querySelector('[data-motion]')).toHaveAttribute(
      'data-motion',
      'instant'
    );
  });

  it('treats an unresolved preference (null, on the server) as sliding', () => {
    vi.mocked(useReducedMotion).mockReturnValue(null);
    const { container } = render(
      <LengthControl value={60} onChange={vi.fn()} isAvailable={() => true} days={14} />
    );

    expect(container.querySelector('[data-motion]')).toHaveAttribute('data-motion', 'slide');
  });

  it('disables an unavailable length with an explanatory title', () => {
    setup(30, [15, 30]);

    const disabled = screen.getByRole('radio', { name: '45 min' });
    expect(disabled).toBeDisabled();
    expect(disabled).toHaveAttribute('title', 'No 45-minute times in the next 14 days');
    expect(screen.getByRole('radio', { name: '30 min' })).not.toHaveAttribute('title');
  });

  it('clicking a length reports it', async () => {
    const { onChange } = setup(60, [15, 30, 45, 60]);

    await userEvent.setup().click(screen.getByRole('radio', { name: '30 min' }));

    expect(onChange).toHaveBeenCalledWith(30);
  });

  it('arrow keys skip a disabled length, wrap at the ends, and move focus', async () => {
    const { onChange } = setup(30, [15, 30, 60]);
    const user = userEvent.setup();
    screen.getByRole('radio', { name: '30 min' }).focus();

    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith(60);
    expect(screen.getByRole('radio', { name: '60 min' })).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith(15);
    expect(screen.getByRole('radio', { name: '15 min' })).toHaveFocus();

    await user.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenLastCalledWith(60);
  });

  it('ignores keys that are not arrows', async () => {
    const { onChange } = setup(30, [15, 30, 60]);
    screen.getByRole('radio', { name: '30 min' }).focus();

    await userEvent.setup().keyboard('a');

    expect(onChange).not.toHaveBeenCalled();
  });

  it('Home and End jump to the first and last enabled length', async () => {
    const { onChange } = setup(30, [30, 45, 60]);
    const user = userEvent.setup();
    screen.getByRole('radio', { name: '30 min' }).focus();

    await user.keyboard('{End}');
    expect(onChange).toHaveBeenLastCalledWith(60);
    expect(screen.getByRole('radio', { name: '60 min' })).toHaveFocus();

    await user.keyboard('{Home}');
    expect(onChange).toHaveBeenLastCalledWith(30);
    expect(screen.getByRole('radio', { name: '30 min' })).toHaveFocus();
  });

  it('keeps one tab stop when the checked length is disabled, and arrows still move', async () => {
    const { onChange } = setup(45, [15, 30]);

    expect(screen.getByRole('radio', { name: '15 min' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: '30 min' })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('radio', { name: '45 min' })).toHaveAttribute('tabindex', '-1');

    screen.getByRole('radio', { name: '15 min' }).focus();
    await userEvent.setup().keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith(30);
  });

  it('paints the checked segment with a solid primary indicator', () => {
    const { container } = render(
      <LengthControl value={60} onChange={vi.fn()} isAvailable={() => true} days={14} />
    );

    expect(container.querySelector('[data-motion]')).toHaveClass('bg-primary');
    expect(screen.getByText('60 min')).toHaveClass('text-primary-foreground');
  });
});
