import { describe, it, expect, vi } from 'vitest';
import { axe } from 'jest-axe';
import { render, screen, fireEvent } from '@/test/utils';
import { CalendarViewSwitcher } from './calendar-view-switcher';

/**
 * BAL-498 fix round 3, A3. The switcher shipped with `role="tablist"` / `role="tab"` /
 * `aria-selected` but NO `aria-controls`, NO `role="tabpanel"` anywhere in the tree, no roving
 * `tabIndex` and no Arrow-key handling — a screen-reader user was told "tab, selected" and
 * pointed at a panel that does not exist. Week/Agenda is a choice between two renderings of ONE
 * region, so the pattern it actually matches is a radio group. This file is also the co-located
 * test (with an axe pass) the component previously lacked entirely.
 */

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
 * BAL-511 / ADR-1053. The design reference's motion spec reads:
 *   `tabs  deliberately static — no underline slide, no panel fade, no press scale,
 *          uniform font-weight (animated tabs read as jitter here)`
 * BAL-498 shipped a sliding pill here by copying `settings-tabs.tsx` under a "don't invent a
 * fourth tab style" rule — the right instinct, the wrong precedent. The spec is the precedent.
 *
 * ⚠ THE DOM HALF BELOW IS WEAK EVIDENCE ON ITS OWN. `@/test/motion-stub`'s MOTION_PROPS
 * includes `layoutId`, which is exactly why BAL-498 had to pin the pill through an exported
 * pure function rather than the DOM. `src/invariants/tabs-are-static.test.ts` is what actually
 * enforces the invariant; this pins the user-visible half (BAL-511 D13).
 */
describe('CalendarViewSwitcher — deliberately static (ADR-1053)', () => {
  it('renders no sliding pill element at all', () => {
    render(<CalendarViewSwitcher view="agenda" onChange={vi.fn()} />);
    expect(screen.queryByTestId('calendar-view-pill')).toBeNull();
  });

  it('carries ONE font weight, present and identical on the checked and unchecked options', () => {
    render(<CalendarViewSwitcher view="week" onChange={vi.fn()} />);
    const fontClassesOf = (el: HTMLElement): string[] =>
      el.className.split(' ').filter((token) => token.startsWith('font-'));

    const checked = screen.getByRole('radio', { name: /week/i });
    const unchecked = screen.getByRole('radio', { name: /agenda/i });
    // Non-vacuity: a REAL token must be present on both. Simply deleting `font-medium` from the
    // active arm leaves `[] === []` — true, and still true if a weight is later re-added to one
    // arm only (BAL-511 D11).
    expect(fontClassesOf(checked)).toEqual(['font-medium']);
    expect(fontClassesOf(unchecked)).toEqual(fontClassesOf(checked));
  });

  it('differentiates the checked option by background and colour only', () => {
    render(<CalendarViewSwitcher view="week" onChange={vi.fn()} />);
    const checked = screen.getByRole('radio', { name: /week/i });
    const unchecked = screen.getByRole('radio', { name: /agenda/i });
    expect(checked.className).toContain('bg-card');
    expect(checked.className).toContain('shadow-sm');
    expect(unchecked.className).not.toContain('bg-card');
    expect(unchecked.className).not.toContain('shadow-sm');
  });
});
