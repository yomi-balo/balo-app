import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { RATING_LABELS, type Rating } from '@balo/shared/reviews';
import { RatingInput } from './rating-input';

const LABEL = 'How was working with Amara?';

/** A minimal controlled host — the component is controlled, so the tests need state. */
function Harness({
  initial = null,
  onChange,
  size,
}: Readonly<{ initial?: Rating | null; onChange?: (r: Rating) => void; size?: number }>) {
  const [value, setValue] = useState<Rating | null>(initial);
  return (
    <RatingInput
      value={value}
      onChange={(rating) => {
        setValue(rating);
        onChange?.(rating);
      }}
      label={LABEL}
      {...(size === undefined ? {} : { size })}
    />
  );
}

function stars(): HTMLElement[] {
  return screen.getAllByRole('radio');
}

beforeEach(() => vi.clearAllMocks());

describe('RatingInput', () => {
  it('renders a named radiogroup of five radios', () => {
    render(<Harness />);

    expect(screen.getByRole('radiogroup', { name: LABEL })).toBeInTheDocument();
    expect(stars()).toHaveLength(5);
  });

  it('labels every star with its number AND its word, so colour is never the only channel', () => {
    render(<Harness />);

    for (const star of [1, 2, 3, 4, 5] as const) {
      expect(
        screen.getByRole('radio', { name: `${star} out of 5 — ${RATING_LABELS[star]}` })
      ).toBeInTheDocument();
    }
  });

  it('is ONE tab stop — roving tabindex, not five stops', () => {
    render(<Harness initial={3} />);
    const tabbable = stars().filter((star) => star.getAttribute('tabindex') === '0');

    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toHaveAccessibleName(`3 out of 5 — ${RATING_LABELS[3]}`);
  });

  it('parks the single tab stop on star 1 when nothing is chosen yet', () => {
    render(<Harness />);

    expect(stars()[0]).toHaveAttribute('tabindex', '0');
    expect(stars()[4]).toHaveAttribute('tabindex', '-1');
  });

  it('selects on click and reports the value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole('radio', { name: `4 out of 5 — ${RATING_LABELS[4]}` }));

    expect(onChange).toHaveBeenCalledWith(4);
    expect(screen.getByRole('radio', { name: /^4 out of 5/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('moves AND selects with ArrowRight / ArrowUp', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={2} onChange={onChange} />);

    stars()[1]?.focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith(3);
    expect(stars()[2]).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    expect(onChange).toHaveBeenLastCalledWith(4);
    expect(stars()[3]).toHaveFocus();
  });

  it('moves AND selects with ArrowLeft / ArrowDown', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={4} onChange={onChange} />);

    stars()[3]?.focus();
    await user.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenLastCalledWith(3);

    await user.keyboard('{ArrowDown}');
    expect(onChange).toHaveBeenLastCalledWith(2);
  });

  it('CLAMPS at both ends — a stray keypress never flips 5 round to 1', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={5} onChange={onChange} />);

    stars()[4]?.focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith(5);
    expect(stars()[4]).toHaveAttribute('aria-checked', 'true');

    stars()[0]?.focus();
    await user.keyboard('{ArrowLeft}');
    // Focus moved to star 1 first, so the clamp lands on 1 — never on 5.
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it('jumps to 1 on Home and 5 on End', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={3} onChange={onChange} />);

    stars()[2]?.focus();
    await user.keyboard('{End}');
    expect(onChange).toHaveBeenLastCalledWith(5);
    expect(stars()[4]).toHaveFocus();

    await user.keyboard('{Home}');
    expect(onChange).toHaveBeenLastCalledWith(1);
    expect(stars()[0]).toHaveFocus();
  });

  it('selects with Enter and with Space (native button activation)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    stars()[2]?.focus();
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(3);

    stars()[1]?.focus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenLastCalledWith(2);
  });

  it('shows the live word label for the chosen value', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    expect(screen.getByText('Tap a star to rate')).toBeInTheDocument();

    await user.click(stars()[3] as HTMLElement);

    expect(screen.getByText(`4 — ${RATING_LABELS[4]}`)).toBeInTheDocument();
  });

  it('previews on hover and REVERTS on mouseleave — hover never commits', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={2} onChange={onChange} />);

    await user.hover(stars()[4] as HTMLElement);
    expect(screen.getByText(`5 — ${RATING_LABELS[5]}`)).toBeInTheDocument();

    await user.unhover(stars()[4] as HTMLElement);
    expect(screen.getByText(`2 — ${RATING_LABELS[2]}`)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('never renders a tap target below the 40px mobile floor', () => {
    render(<Harness size={12} />);

    for (const star of stars()) {
      expect(star.style.width).toBe('40px');
      expect(star.style.height).toBe('40px');
    }
  });

  it('honours a larger size — 48px on the landing form', () => {
    render(<Harness size={48} />);

    expect(stars()[0]?.style.width).toBe('48px');
  });

  it('has no axe violations', async () => {
    const { container } = render(<Harness initial={4} />);

    expect(await axe(container)).toHaveNoViolations();
  });

  it('ignores keys it does not own, so the form can still be submitted from a star', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={3} onChange={onChange} />);

    stars()[2]?.focus();
    await user.keyboard('{Escape}');

    expect(onChange).not.toHaveBeenCalled();
  });
});
