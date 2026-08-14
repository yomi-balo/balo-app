import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MeetingSidePanel } from './meeting-side-panel';

/**
 * BAL-436 — the side-panel shell.
 *
 * ⚠⚠ THE ONE THING THAT MUST NOT REGRESS IS THAT **THIS PANEL IS NOT MODAL, AT ANY WIDTH.**
 *
 * An earlier version armed `role="dialog"` + `aria-modal="true"` + a focus trap below `lg`,
 * justified by "a keyboard user tabbing past it would land on controls they cannot see". That
 * was factually wrong about the layout: the panel is `absolute inset-0` inside the STAGE ROW,
 * and `MeetingToolbar` renders outside and below that row — so Mic, Camera, More and **Leave**
 * stay visible and clickable underneath it on a phone. The trap therefore locked keyboard and
 * screen-reader users away from Mute and Leave on a LIVE CALL, and `aria-modal` additionally
 * hid the frame's §16 live region (a sibling subtree) from AT.
 *
 * The tests below pin the ABSENCE of all three, at both widths, so it cannot come back quietly.
 */

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

/**
 * ⚠ STILL STUBBED, THOUGH THE COMPONENT NO LONGER READS IT. The point of keeping it is that
 * the assertions below run at BOTH simulated widths: if somebody reintroduces a `matchMedia`
 * branch, the narrow-width cases will exercise it and fail rather than silently pass because
 * `matchMedia` was undefined in JSDOM.
 */
function stubMatchMedia(matches: boolean): void {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
}

beforeEach(() => {
  stubMatchMedia(false);
});

describe('MeetingSidePanel — structure', () => {
  it('renders its title as an `<h2>`, never an `<h1>` — the frame owns the page heading', () => {
    render(
      <MeetingSidePanel title="People" onClose={vi.fn()}>
        <p>body</p>
      </MeetingSidePanel>
    );

    expect(screen.getByRole('heading', { level: 2, name: 'People' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('⚠ FOCUSES THE HEADING ON OPEN, so the person is told what appeared', () => {
    render(
      <MeetingSidePanel title="Files" onClose={vi.fn()}>
        <p>body</p>
      </MeetingSidePanel>
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Files' })).toHaveFocus();
  });

  it('renders a count pill when given one, and NOTHING when not — never a zero placeholder', () => {
    const { rerender } = render(
      <MeetingSidePanel title="People" count={4} onClose={vi.fn()}>
        <p>body</p>
      </MeetingSidePanel>
    );
    expect(screen.getByText('4')).toBeInTheDocument();

    rerender(
      <MeetingSidePanel title="People" onClose={vi.fn()}>
        <p>body</p>
      </MeetingSidePanel>
    );
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('renders a footer only when supplied', () => {
    const { rerender } = render(
      <MeetingSidePanel
        title="People"
        onClose={vi.fn()}
        footer={<button type="button">Add</button>}
      >
        <p>body</p>
      </MeetingSidePanel>
    );
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();

    rerender(
      <MeetingSidePanel title="People" onClose={vi.fn()}>
        <p>body</p>
      </MeetingSidePanel>
    );
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
  });

  it('⚠⚠ carries NO `aria-busy` anywhere — it suppresses live-region announcements', () => {
    const { container } = render(
      <MeetingSidePanel title="People" onClose={vi.fn()}>
        <p>body</p>
      </MeetingSidePanel>
    );

    expect(container.querySelector('[aria-busy]')).toBeNull();
  });
});

describe('MeetingSidePanel — closing', () => {
  it('closes on the X, whose accessible name names the panel', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <MeetingSidePanel title="People" onClose={onClose}>
        <p>body</p>
      </MeetingSidePanel>
    );

    await user.click(screen.getByRole('button', { name: 'Close people' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('⚠ ESCAPE CLOSES', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <MeetingSidePanel title="Files" onClose={onClose}>
        <button type="button">inside</button>
      </MeetingSidePanel>
    );

    await user.click(screen.getByRole('button', { name: 'inside' }));
    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('MeetingSidePanel — ⚠⚠ IT IS NOT MODAL, AT ANY WIDTH', () => {
  it.each([
    ['at `lg` and above, beside the stage', false],
    ['⚠⚠ BELOW `lg` TOO — the toolbar is outside the row it covers', true],
  ])('is NOT a dialog and carries NO `aria-modal` %s', (_label, isNarrow) => {
    stubMatchMedia(isNarrow);
    const { container } = render(
      <MeetingSidePanel title="People" onClose={vi.fn()}>
        <p>body</p>
      </MeetingSidePanel>
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(container.querySelector('[aria-modal]')).toBeNull();
  });

  /**
   * ⚠⚠ THE REGRESSION THAT ACTUALLY STRANDED PEOPLE. With the trap armed, Tab from the LAST
   * focusable element in the panel cycled back to the FIRST — so Mute and Leave, which sit
   * after the panel in the DOM and remain visible underneath it on a phone, were unreachable
   * by keyboard on a live call.
   */
  it.each([
    ['as a sidebar', false],
    ['as a narrow overlay', true],
  ])('⚠⚠ lets Tab LEAVE the panel and reach the toolbar %s', async (_label, isNarrow) => {
    stubMatchMedia(isNarrow);
    const user = userEvent.setup();
    render(
      <div>
        <MeetingSidePanel title="People" onClose={vi.fn()} footer={<p>footer</p>}>
          <button type="button">only row</button>
        </MeetingSidePanel>
        {/* Stands in for `MeetingToolbar`, which renders AFTER and OUTSIDE the panel's row. */}
        <button type="button">Leave</button>
      </div>
    );

    await user.click(screen.getByRole('button', { name: 'only row' }));
    await user.tab();

    expect(screen.getByRole('button', { name: 'Leave' })).toHaveFocus();
  });

  it('⚠ names itself as a LANDMARK from its own heading, so AT can jump in and out', () => {
    render(
      <MeetingSidePanel title="People" onClose={vi.fn()}>
        <p>body</p>
      </MeetingSidePanel>
    );

    // A `<section>` with an accessible name is a `region` landmark — the non-modal answer to
    // "let me get to this panel and back out of it" that a focus trap was reaching for.
    expect(screen.getByRole('region', { name: 'People' })).toBeInTheDocument();
  });
});

describe('MeetingSidePanel — accessibility', () => {
  it.each([
    ['as a sidebar', false],
    ['as a narrow overlay', true],
  ])('has no axe violations %s', async (_label, isNarrow) => {
    stubMatchMedia(isNarrow);
    const { container } = render(
      <MeetingSidePanel title="People" count={2} onClose={vi.fn()} footer={<p>footer</p>}>
        <ul>
          <li>a row</li>
        </ul>
      </MeetingSidePanel>
    );

    expect(await axe(container)).toHaveNoViolations();
  });
});
