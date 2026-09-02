import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useRef } from 'react';
import { useContainerLayout, type TopUpLayout } from './use-container-layout';

/**
 * A controllable ResizeObserver stand-in. jsdom has none, and the real one never fires without
 * layout — so the observer arm would be dead code in tests without this.
 */
type ObserverCallback = (entries: { contentRect: { width: number } }[]) => void;
let callbacks: ObserverCallback[] = [];

class FakeResizeObserver {
  constructor(private readonly cb: ObserverCallback) {
    callbacks.push(cb);
  }
  observe(): void {
    // no-op — width changes are pushed via `emit()`
  }
  disconnect(): void {
    callbacks = callbacks.filter((c) => c !== this.cb);
  }
}

function emit(width: number): void {
  act(() => {
    for (const cb of [...callbacks]) cb([{ contentRect: { width } }]);
  });
}

/** Probe component: renders the resolved layout as text, with a stubbed measured width. */
function Probe({ hint, measured }: Readonly<{ hint: TopUpLayout; measured: number }>) {
  const ref = useRef<HTMLDivElement>(null);
  const layout = useContainerLayout(ref, hint);
  return (
    <div
      ref={(node) => {
        if (node) {
          node.getBoundingClientRect = () => ({ width: measured }) as DOMRect;
          ref.current = node;
        }
      }}
    >
      <span data-testid="layout">{layout}</span>
    </div>
  );
}

describe('useContainerLayout', () => {
  beforeEach(() => {
    callbacks = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('respects the caller hint before any measurement (no first-paint flash)', () => {
    // Measured 0 = not laid out yet (hidden dialog / first paint).
    render(<Probe hint="wide" measured={0} />);
    expect(screen.getByTestId('layout')).toHaveTextContent('wide');
  });

  it('honours a "stacked" hint even on a wide viewport (the dialog case)', () => {
    // THE reason the hook exists: the viewport says nothing about a ≤560px dialog.
    render(<Probe hint="stacked" measured={0} />);
    expect(screen.getByTestId('layout')).toHaveTextContent('stacked');
  });

  it('narrows to stacked when the CONTAINER measures below the breakpoint', () => {
    render(<Probe hint="wide" measured={520} />);
    expect(screen.getByTestId('layout')).toHaveTextContent('stacked');
  });

  it('keeps wide when the container measures at or above the breakpoint', () => {
    render(<Probe hint="wide" measured={960} />);
    expect(screen.getByTestId('layout')).toHaveTextContent('wide');
  });

  it('narrows and widens again as the container is resized', () => {
    render(<Probe hint="wide" measured={960} />);
    expect(screen.getByTestId('layout')).toHaveTextContent('wide');

    emit(600);
    expect(screen.getByTestId('layout')).toHaveTextContent('stacked');

    emit(1100);
    expect(screen.getByTestId('layout')).toHaveTextContent('wide');
  });

  it('IGNORES a zero width — an unlaid-out element must not falsely narrow the layout', () => {
    render(<Probe hint="wide" measured={960} />);
    emit(0);
    expect(screen.getByTestId('layout')).toHaveTextContent('wide');
  });

  it('falls back to the hint when ResizeObserver is unavailable', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    render(<Probe hint="wide" measured={100} />);
    expect(screen.getByTestId('layout')).toHaveTextContent('wide');
  });

  it('disconnects the observer on unmount', () => {
    const { unmount } = render(<Probe hint="wide" measured={960} />);
    expect(callbacks).toHaveLength(1);
    unmount();
    expect(callbacks).toHaveLength(0);
  });
});
