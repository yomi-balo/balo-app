import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axe } from 'jest-axe';
import { render, screen, fireEvent } from '@/test/utils';
import { CalendarViewSwitcher, calendarViewPillMotionProps } from './calendar-view-switcher';

/**
 * BAL-498 fix round 3, A3. The switcher shipped with `role="tablist"` / `role="tab"` /
 * `aria-selected` but NO `aria-controls`, NO `role="tabpanel"` anywhere in the tree, no roving
 * `tabIndex` and no Arrow-key handling — a screen-reader user was told "tab, selected" and
 * pointed at a panel that does not exist. Week/Agenda is a choice between two renderings of ONE
 * region, so the pattern it actually matches is a radio group. This file is also the co-located
 * test (with an axe pass) the component previously lacked entirely.
 */

/**
 * ⚠ THE SHARED STUB HARD-CODES `useReducedMotion: () => false`, so it cannot express the reduced
 * arm. Overridden here off a mutable flag — the same shape `step-assessment.test.tsx` already
 * uses — rather than by editing the shared stub, which every other consumer depends on.
 */
const motionState = { reduce: false };
vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return { ...createMotionStub(), useReducedMotion: () => motionState.reduce };
});

beforeEach(() => {
  motionState.reduce = false;
});

describe('CalendarViewSwitcher — radio-group semantics (A3)', () => {
  it('exposes a named radiogroup with one radio per view, and marks the active one checked', () => {
    render(<CalendarViewSwitcher view="week" onChange={vi.fn()} />);

    expect(screen.getByRole('radiogroup', { name: 'Calendar view' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: /week/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /agenda/i })).toHaveAttribute('aria-checked', 'false');
  });

  it('is NOT an incomplete tabs pattern — no tab, tablist or dangling aria-controls survives', () => {
    const { container } = render(<CalendarViewSwitcher view="week" onChange={vi.fn()} />);

    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryAllByRole('tablist')).toHaveLength(0);
    expect(container.querySelector('[aria-controls]')).toBeNull();
  });

  it('roving tabIndex: exactly ONE stop in the group, and it is the checked option', () => {
    render(<CalendarViewSwitcher view="agenda" onChange={vi.fn()} />);

    expect(screen.getByRole('radio', { name: /agenda/i })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: /week/i })).toHaveAttribute('tabindex', '-1');
  });

  it('clicking an option reports it', () => {
    const onChange = vi.fn();
    render(<CalendarViewSwitcher view="week" onChange={onChange} />);

    fireEvent.click(screen.getByRole('radio', { name: /agenda/i }));

    expect(onChange).toHaveBeenCalledWith('agenda');
  });

  /**
   * ⚠ THE KEY EVENT IS DISPATCHED ON THE CHECKED RADIO, NOT ON THE GROUP (BAL-498 fix round 6,
   * item 1). The handler moved off the `role="radiogroup"` container and onto each `role="radio"`
   * button, so that the element owning an interactive role no longer owns a keyboard handler while
   * being unfocusable (SonarCloud "radiogroup must be focusable"). The checked radio is the group's
   * ONE tab stop — the roving `tabIndex` above pins that — so it is exactly where a real
   * keystroke lands. Dispatching on the container was always the LESS faithful simulation: the
   * container is not focusable and could only ever have seen the event by bubbling.
   */
  const pressKeyOnFocusedRadio = (key: string): void => {
    fireEvent.keyDown(screen.getByRole('radio', { checked: true }), { key });
  };

  it.each([
    ['ArrowRight', 'week', 'agenda'],
    ['ArrowDown', 'week', 'agenda'],
    ['ArrowLeft', 'agenda', 'week'],
    ['ArrowUp', 'agenda', 'week'],
  ] as const)('%s from %s moves and selects %s (APG radiogroup)', (key, from, expected) => {
    const onChange = vi.fn();
    render(<CalendarViewSwitcher view={from} onChange={onChange} />);

    pressKeyOnFocusedRadio(key);

    expect(onChange).toHaveBeenCalledWith(expected);
  });

  it('Home selects the first option and End the last', () => {
    const onChange = vi.fn();
    render(<CalendarViewSwitcher view="agenda" onChange={onChange} />);

    pressKeyOnFocusedRadio('Home');
    expect(onChange).toHaveBeenLastCalledWith('week');

    pressKeyOnFocusedRadio('End');
    expect(onChange).toHaveBeenLastCalledWith('agenda');
  });

  it('an unrelated key is ignored (no selection change, no preventDefault side effect)', () => {
    const onChange = vi.fn();
    render(<CalendarViewSwitcher view="week" onChange={onChange} />);

    pressKeyOnFocusedRadio('a');

    expect(onChange).not.toHaveBeenCalled();
  });

  it('the radiogroup container itself carries NO keyboard handler and NO tabIndex — the radios do', () => {
    const onChange = vi.fn();
    render(<CalendarViewSwitcher view="week" onChange={onChange} />);

    // The rule this guards ("elements with the radiogroup interactive role must be focusable")
    // fires when an interactive-role element owns a keyboard handler while unfocusable. The fix
    // is to own no handler — NOT to add `tabIndex={-1}` and put the group in reach of
    // programmatic focus for no user-visible reason. Both halves matter: re-adding a container
    // handler makes the second assertion fail, and "fixing" it with `tabIndex` fails the first.
    const group = screen.getByRole('radiogroup', { name: 'Calendar view' });
    expect(group).not.toHaveAttribute('tabindex');
    // A keystroke landing on the container (which no user can focus) reaches no handler.
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(onChange).not.toHaveBeenCalled();
    // ...while the same keystroke on the real tab stop still works.
    pressKeyOnFocusedRadio('ArrowRight');
    expect(onChange).toHaveBeenCalledWith('agenda');
  });

  it('both options meet the 44px minimum tap target (min-h-11)', () => {
    render(<CalendarViewSwitcher view="week" onChange={vi.fn()} />);

    for (const option of screen.getAllByRole('radio')) {
      expect(option.className).toContain('min-h-11');
    }
  });

  it('has no axe violations', async () => {
    const { container } = render(<CalendarViewSwitcher view="week" onChange={vi.fn()} />);

    expect(await axe(container)).toHaveNoViolations();
  });
});

/**
 * BAL-498 fix round 5, B3. The sliding pill STAYS — balo-ui
 * `references/motion-patterns.md:28` puts a tab switch in the "State change" band and
 * explicitly sanctions animating it. Two defects inside it did not:
 *
 *   1. `{ type: 'spring', duration: 0.35, bounce: 0.15 }` — copied verbatim from
 *      `settings-tabs.tsx` — is off-spec on BOTH axes of that same table: 350ms is outside the
 *      200–300ms band, and the file's anti-pattern list bans "bounce/spring easings on business
 *      UI".
 *   2. The file had NO `prefers-reduced-motion` handling at all, while the rest of the PR does
 *      (the Join affordance carries a `motion-reduce:` fallback).
 *
 * The transition and `layoutId` are asserted through the exported pure function, NOT the DOM:
 * `@/test/motion-stub` lists both in `MOTION_PROPS` and strips them before they reach the
 * element, so a render-only assertion would pass no matter what the component passed.
 */
describe('CalendarViewSwitcher — the sliding pill (B3)', () => {
  it('animates a view switch inside balo-ui’s 200–300ms easeOut "State change" band, never a spring', () => {
    const props = calendarViewPillMotionProps(false);

    expect(props.transition.ease).toBe('easeOut');
    expect(props.transition.duration).toBeGreaterThanOrEqual(0.2);
    expect(props.transition.duration).toBeLessThanOrEqual(0.3);
    // The exact regression: reverting to the source pattern's spring puts `type: 'spring'`,
    // `bounce: 0.15` and a 0.35 duration back, failing all three assertions above.
    expect(props.transition).not.toHaveProperty('type');
    expect(props.transition).not.toHaveProperty('bounce');
  });

  it('SLIDES between options by default — the shared layoutId is what produces the movement', () => {
    expect(calendarViewPillMotionProps(false).layoutId).toBe('calendar-view-pill');
  });

  it('under prefers-reduced-motion it JUMPS: no shared layoutId, no duration', () => {
    const props = calendarViewPillMotionProps(true);

    // Dropping `layoutId` (rather than only zeroing the duration) is what removes the layout
    // projection entirely — the pill simply mounts already in its final position.
    expect(props.layoutId).toBeUndefined();
    expect(props.transition.duration).toBe(0);
  });

  it.each([
    ['motion allowed', false],
    ['reduced motion', true],
  ] as const)(
    'the active pill still RENDERS under %s — reduced motion removes the movement, never the affordance',
    (_label, reduce) => {
      motionState.reduce = reduce;
      render(<CalendarViewSwitcher view="agenda" onChange={vi.fn()} />);

      const pills = screen.getAllByTestId('calendar-view-pill');
      expect(pills).toHaveLength(1);
      // ...and it is inside the CHECKED option, so "which view am I on" survives the preference.
      expect(screen.getByRole('radio', { name: /agenda/i })).toContainElement(pills[0] ?? null);
      expect(screen.getByRole('radio', { name: /week/i })).not.toContainElement(pills[0] ?? null);
    }
  );

  it('has no axe violations under reduced motion either', async () => {
    motionState.reduce = true;
    const { container } = render(<CalendarViewSwitcher view="week" onChange={vi.fn()} />);

    expect(await axe(container)).toHaveNoViolations();
  });
});
