import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ViewControls, type ViewControlsProps } from './view-controls';

/**
 * BAL-435 — the stage's ViewControls, and ⚠⚠ **THE PROTOTYPE FULLSCREEN BUG, PINNED SHUT.**
 *
 * The prototype kept its OWN boolean, flipped by a `keydown Escape` listener, plus a
 * `position: fixed` fallback — so pressing Esc, or leaving fullscreen from the browser's own
 * chrome, left the UI claiming the opposite of what the window was doing.
 *
 * Here `fullscreenchange` is the SINGLE SOURCE OF TRUTH and the Esc listener is DELETED (Esc is
 * handled natively for free). Two assertions hold that: the icon follows
 * `document.fullscreenElement` even when the change came from outside this component, and NO
 * `keydown` listener is registered at all.
 *
 * ⚠ jsdom implements neither `fullscreenElement` nor `fullscreenEnabled` usefully, so both are
 * defined here — which is also what makes "the icon follows the DOCUMENT" testable at all.
 */

// jsdom has no `matchMedia`; the repo's convention (7 existing call sites) is to mock the hook.
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

let frameElement: HTMLElement;
let addEventListenerSpy: ReturnType<typeof vi.spyOn>;

/** Point `document.fullscreenElement` at `element` and fire the event the browser would fire. */
function enterFullscreen(element: Element | null): void {
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    value: element,
  });
  act(() => {
    document.dispatchEvent(new Event('fullscreenchange'));
  });
}

beforeEach(() => {
  frameElement = document.createElement('div');
  document.body.append(frameElement);
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
  // jsdom implements neither; both are called through `typeof … === 'function'` guards.
  Object.defineProperty(document, 'exitFullscreen', {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  Object.defineProperty(Element.prototype, 'requestFullscreen', {
    configurable: true,
    writable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  addEventListenerSpy = vi.spyOn(document, 'addEventListener');
});

afterEach(() => {
  frameElement.remove();
  vi.restoreAllMocks();
});

function renderControls(overrides: Partial<ViewControlsProps> = {}): HTMLElement {
  const props: ViewControlsProps = {
    frameElement,
    showLayoutToggle: true,
    isGallery: false,
    onToggleLayout: vi.fn(),
    ...overrides,
  };
  return render(
    <TooltipProvider>
      <ViewControls {...props} />
    </TooltipProvider>
  ).container;
}

describe('ViewControls — ⚠⚠ fullscreenchange is the single source of truth', () => {
  it('⚠⚠ registers NO keydown listener — Esc is the browser’s job, not ours', () => {
    renderControls();

    const events = addEventListenerSpy.mock.calls.map(([event]: readonly unknown[]) => event);
    expect(events).not.toContain('keydown');
    // What it DOES register, on both the standard and the Safari-prefixed name.
    expect(events).toContain('fullscreenchange');
    expect(events).toContain('webkitfullscreenchange');
  });

  it('starts out of fullscreen', async () => {
    renderControls();

    expect(await screen.findByRole('button', { name: 'Fullscreen' })).toBeInTheDocument();
  });

  it('follows the DOCUMENT into fullscreen, even when nothing here asked for it', async () => {
    renderControls();
    await screen.findByRole('button', { name: 'Fullscreen' });

    enterFullscreen(frameElement);

    expect(screen.getByRole('button', { name: 'Exit fullscreen' })).toBeInTheDocument();
  });

  it('⚠ ignores a FOREIGN fullscreen element — someone else’s video is not our frame', async () => {
    const foreign = document.createElement('video');
    document.body.append(foreign);
    renderControls();
    await screen.findByRole('button', { name: 'Fullscreen' });

    enterFullscreen(foreign);

    expect(screen.getByRole('button', { name: 'Fullscreen' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Exit fullscreen' })).toBeNull();
    foreign.remove();
  });

  it('follows the document back OUT again — the desync the prototype could not express', async () => {
    renderControls();
    await screen.findByRole('button', { name: 'Fullscreen' });
    enterFullscreen(frameElement);
    expect(screen.getByRole('button', { name: 'Exit fullscreen' })).toBeInTheDocument();

    enterFullscreen(null);

    expect(screen.getByRole('button', { name: 'Fullscreen' })).toBeInTheDocument();
  });

  it('asks the FRAME to go fullscreen, not the document body', async () => {
    const user = userEvent.setup();
    renderControls();

    await user.click(await screen.findByRole('button', { name: 'Fullscreen' }));

    expect(frameElement.requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it('exits via the document when something is already fullscreen', async () => {
    const user = userEvent.setup();
    renderControls();
    await screen.findByRole('button', { name: 'Fullscreen' });
    enterFullscreen(frameElement);

    await user.click(screen.getByRole('button', { name: 'Exit fullscreen' }));

    expect(document.exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it('⚠ renders no fullscreen control where the API is absent — a button that lies is worse', async () => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false });
    renderControls({ showLayoutToggle: true });

    await screen.findByRole('button', { name: 'Gallery view' });
    expect(screen.queryByRole('button', { name: /fullscreen/i })).toBeNull();
  });

  it('renders nothing at all when there is neither a layout to toggle nor fullscreen', () => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false });
    const container = renderControls({ showLayoutToggle: false });

    expect(container).toBeEmptyDOMElement();
  });
});

describe('ViewControls — the layout toggle', () => {
  it('names the view it will switch TO, and reports its own pressed state', () => {
    renderControls({ isGallery: false });

    const toggle = screen.getByRole('button', { name: 'Gallery view' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('flips both when the layout flips', () => {
    renderControls({ isGallery: true });

    expect(screen.getByRole('button', { name: 'Speaker view' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('raises the handler on click', async () => {
    const user = userEvent.setup();
    const onToggleLayout = vi.fn();
    renderControls({ onToggleLayout });

    await user.click(screen.getByRole('button', { name: 'Gallery view' }));

    expect(onToggleLayout).toHaveBeenCalledTimes(1);
  });

  it('⚠ is hidden while there is no video layout — during a share or PreJoin', async () => {
    renderControls({ showLayoutToggle: false });

    await screen.findByRole('button', { name: 'Fullscreen' });
    expect(screen.queryByRole('button', { name: /gallery view|speaker view/i })).toBeNull();
  });

  it('has no accessibility violations', async () => {
    const container = renderControls();

    await screen.findByRole('button', { name: 'Fullscreen' });
    expect(await axe(container)).toHaveNoViolations();
  });
});
