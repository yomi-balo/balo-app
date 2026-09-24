import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { TYPING_ANNOUNCE_HOLD_MS, TypingIndicator, typingIndicatorCopy } from './typing-indicator';

/**
 * The "typing…" line: copy, live region and motion.
 *
 * ⚠ THE LIVE REGION MUST EXIST WHILE NOBODY TYPES. A region inserted together with its first
 * text is routinely missed by screen readers, so the empty state is asserted as carefully as
 * the populated one.
 *
 * ⚠⚠ THE ANNOUNCED TEXT IS HELD ACROSS A PAUSE. The visible line follows the typist set exactly;
 * the live region keeps its text for `TYPING_ANNOUNCE_HOLD_MS`, so a pause-and-resume inside one
 * reply is announced once, not once per pause.
 *
 * ⚠ THE `motion-safe:` CHECK SCANS EVERY CLASS IN THE RENDERED DOM and pairs the predicate with
 * a count, so neither a new unguarded animation nor the deletion of the dots passes vacuously.
 */

describe('typingIndicatorCopy', () => {
  it('nobody typing → null', () => {
    expect(typingIndicatorCopy([])).toBeNull();
  });

  it('one known typist → "{name} is typing…"', () => {
    expect(typingIndicatorCopy(['Dana'])).toBe('Dana is typing…');
  });

  it('one unknown typist → "Someone is typing…"', () => {
    expect(typingIndicatorCopy([null])).toBe('Someone is typing…');
  });

  it('two known typists → "{a} and {b} are typing…"', () => {
    expect(typingIndicatorCopy(['Dana', 'Sam'])).toBe('Dana and Sam are typing…');
  });

  it('two typists, only the first known → "{known} and someone else are typing…"', () => {
    expect(typingIndicatorCopy(['Dana', null])).toBe('Dana and someone else are typing…');
  });

  it('two typists, only the second known → "{known} and someone else are typing…"', () => {
    expect(typingIndicatorCopy([null, 'Sam'])).toBe('Sam and someone else are typing…');
  });

  it('two unknown typists → "Two people are typing…"', () => {
    expect(typingIndicatorCopy([null, null])).toBe('Two people are typing…');
  });

  it('three or more typists → "Several people are typing…", known or not', () => {
    expect(typingIndicatorCopy(['Dana', 'Sam', 'Kai'])).toBe('Several people are typing…');
    expect(typingIndicatorCopy([null, null, null, null])).toBe('Several people are typing…');
  });

  it('uses the single-character ellipsis', () => {
    expect(typingIndicatorCopy(['Dana'])).toMatch(/…$/);
    expect(typingIndicatorCopy(['Dana'])).not.toContain('...');
  });
});

describe('<TypingIndicator>', () => {
  it('renders the copy inside the live region', () => {
    render(<TypingIndicator names={['Dana']} />);

    expect(screen.getByRole('status')).toHaveTextContent('Dana is typing…');
  });

  it('⚠⚠ keeps an EMPTY live region mounted while nobody types', () => {
    render(<TypingIndicator names={[]} />);

    const region = screen.getByRole('status');
    expect(region).toBeInTheDocument();
    expect(region.textContent).toBe('');
    expect(region.children).toHaveLength(0);
  });

  it('⚠ the live region is an <output aria-live="polite">, NOT role="status" (S6819)', () => {
    const { container } = render(<TypingIndicator names={['Dana']} />);

    const region = screen.getByRole('status');
    expect(region.tagName).toBe('OUTPUT');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('the live region holds TEXT only — the visible line sits beside it', () => {
    render(<TypingIndicator names={['Dana']} />);

    expect(screen.getByRole('status').children).toHaveLength(0);
  });

  it('hides the three dots AND the visible copy from assistive tech — the region speaks', () => {
    const { container } = render(<TypingIndicator names={['Dana']} />);

    const hidden = Array.from(container.querySelectorAll('[aria-hidden="true"]'));
    expect(hidden).toHaveLength(2);
    const [dots, copy] = hidden;
    expect(dots?.children).toHaveLength(3);
    expect(dots?.textContent).toBe('');
    expect(copy?.textContent).toBe('Dana is typing…');
  });

  it('⚠ every animation class in the rendered DOM is behind motion-safe:', () => {
    const { container } = render(<TypingIndicator names={['Dana', 'Sam']} />);

    const animationClasses = Array.from(container.querySelectorAll('*')).flatMap((el) =>
      Array.from(el.classList).filter((token) => token.includes('anim'))
    );
    expect(animationClasses.length).toBeGreaterThanOrEqual(3);
    expect(animationClasses.filter((token) => !token.startsWith('motion-safe:'))).toEqual([]);
  });

  it('reserves a fixed line height so the thread does not jump', () => {
    const { container } = render(<TypingIndicator names={[]} />);

    expect(container.firstElementChild?.className).toContain('min-h-5');
  });

  it('merges a caller className', () => {
    const { container } = render(<TypingIndicator names={[]} className="px-4" />);

    expect(container.firstElementChild?.className).toContain('px-4');
  });

  it('has no axe violations, empty or populated', async () => {
    const empty = render(<TypingIndicator names={[]} />);
    expect(await axe(empty.container)).toHaveNoViolations();
    empty.unmount();

    const populated = render(<TypingIndicator names={['Dana', null]} />);
    expect(await axe(populated.container)).toHaveNoViolations();
  });
});

describe('<TypingIndicator> — ⚠⚠ the announced text is held across a pause', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the announced copy for TYPING_ANNOUNCE_HOLD_MS after the line empties, then clears it', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<TypingIndicator names={['Dana']} />);

    rerender(<TypingIndicator names={[]} />);
    // The VISIBLE line clears at once (AC1)…
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(0);
    // …the announced text does not.
    expect(screen.getByRole('status')).toHaveTextContent('Dana is typing…');

    act(() => {
      vi.advanceTimersByTime(TYPING_ANNOUNCE_HOLD_MS - 1);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Dana is typing…');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('⚠⚠ a pause-and-resume inside the hold leaves the live region UNTOUCHED — no re-announcement', () => {
    vi.useFakeTimers();
    const { rerender } = render(<TypingIndicator names={['Dana']} />);
    const region = screen.getByRole('status');
    const announcedNode = region.firstChild;
    expect(announcedNode?.textContent).toBe('Dana is typing…');

    rerender(<TypingIndicator names={[]} />);
    act(() => {
      vi.advanceTimersByTime(TYPING_ANNOUNCE_HOLD_MS / 2);
    });
    rerender(<TypingIndicator names={['Dana']} />);
    act(() => {
      vi.advanceTimersByTime(TYPING_ANNOUNCE_HOLD_MS);
    });

    // The very same text node, never emptied or replaced: nothing for AT to announce.
    expect(region.firstChild).toBe(announcedNode);
    expect(region.textContent).toBe('Dana is typing…');
  });

  it('announces a DIFFERENT copy at once', () => {
    const { rerender } = render(<TypingIndicator names={['Dana']} />);

    rerender(<TypingIndicator names={['Dana', 'Sam']} />);

    expect(screen.getByRole('status')).toHaveTextContent('Dana and Sam are typing…');
  });
});

describe('<TypingIndicator announce={false}> — visual only', () => {
  it('renders NO live region, and the line is ordinary readable text', () => {
    const { container } = render(<TypingIndicator names={['Dana']} announce={false} />);

    expect(screen.queryByRole('status')).toBeNull();
    expect(container.querySelector('output')).toBeNull();
    expect(container.querySelector('[aria-live]')).toBeNull();
    expect(screen.getByText('Dana is typing…')).not.toHaveAttribute('aria-hidden');
  });

  it('still reserves its line and animates only behind motion-safe:', () => {
    const { container } = render(<TypingIndicator names={['Dana']} announce={false} />);

    expect(container.firstElementChild?.className).toContain('min-h-5');
    const animationClasses = Array.from(container.querySelectorAll('*')).flatMap((el) =>
      Array.from(el.classList).filter((token) => token.includes('anim'))
    );
    expect(animationClasses.length).toBeGreaterThanOrEqual(3);
    expect(animationClasses.filter((token) => !token.startsWith('motion-safe:'))).toEqual([]);
  });
});
