import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/utils';
import { resolveRouteDir } from '@/invariants/_source-scan';
import { JoinMeetingButton } from './join-meeting-button';

/**
 * BAL-511 / ADR-1053 — the Join live cue: a ping ring, `ambient  live-call ping ring 1.8s`,
 * replacing the whole-button `motion-safe:animate-pulse`. This is the FIRST direct test for this
 * component — until now it was only exercised indirectly through `meeting-block.test.tsx` and
 * `agenda-list.test.tsx`.
 */

/** S1 idiom, copied from `meeting-block.test.tsx` — jsdom's `Location.assign` is a
 *  non-configurable own property, so the whole `location` object is swapped and restored. */
const realLocation = globalThis.location;
let mockAssign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockAssign = vi.fn();
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { href: realLocation.href, origin: realLocation.origin, assign: mockAssign },
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, 'location', { configurable: true, value: realLocation });
});

describe('JoinMeetingButton — the DOM', () => {
  it('renders a <button> (never a link), calls onJoin then navigates to joinUrl', () => {
    const onJoin = vi.fn();
    render(
      <JoinMeetingButton
        joinUrl="https://balo.expert/join/m/m-1"
        ariaLabel="Join now"
        onJoin={onJoin}
      >
        Join
      </JoinMeetingButton>
    );

    const button = screen.getByRole('button', { name: 'Join now' });
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(onJoin).toHaveBeenCalledTimes(1);
    expect(mockAssign).toHaveBeenCalledWith('https://balo.expert/join/m/m-1');
  });

  it('carries the live ping-ring cue and its reduced-motion fallback, never the old animate-pulse', () => {
    render(
      <JoinMeetingButton
        joinUrl="https://balo.expert/join/m/m-1"
        ariaLabel="Join now"
        onJoin={vi.fn()}
      >
        Join
      </JoinMeetingButton>
    );

    const button = screen.getByRole('button', { name: 'Join now' });
    for (const token of [
      'relative',
      'after:absolute',
      "after:content-['']",
      'motion-safe:before:animate-ping-slow',
      'motion-safe:before:ring-primary',
      'motion-safe:before:pointer-events-none',
      'motion-reduce:ring-2',
      'motion-reduce:ring-primary',
    ]) {
      expect(button.className).toContain(token);
    }
    // ⚠ NO ALPHA MODIFIER. `toContain('motion-reduce:ring-primary')` alone also matches
    // `motion-reduce:ring-primary/40` — the pre-existing value that measures 1.47:1 in light
    // mode, below WCAG 1.4.11's 3:1 floor. This pins FULL opacity so re-adding an alpha fails.
    expect(button.className).not.toContain('motion-reduce:ring-primary/');
    expect(button.className).not.toContain('animate-pulse');
  });

  it('D6 — a call-site className="absolute …" still wins over the baked-in relative', () => {
    render(
      <JoinMeetingButton
        joinUrl="https://balo.expert/join/m/m-1"
        ariaLabel="Join now"
        onJoin={vi.fn()}
        className="absolute top-0.5"
      >
        Join
      </JoinMeetingButton>
    );

    const button = screen.getByRole('button', { name: 'Join now' });
    const classes = button.className.split(' ');
    expect(classes).toContain('absolute');
    // ⚠ `split(' ')` not `toContain` on the raw string — the substring 'relative' never appears
    // elsewhere here, but `.toContain` on a raw string is the fragile form (BAL-511 D6).
    expect(classes).not.toContain('relative');
  });
});

describe('JoinMeetingButton — the @theme token (guards §0.3)', () => {
  const GLOBALS_CSS = resolveRouteDir(['src/app/globals.css', 'apps/web/src/app/globals.css']);

  it('guards the guard: globals.css resolves and genuinely defines the @theme block', () => {
    expect(GLOBALS_CSS).not.toBe('');
    expect(readFileSync(GLOBALS_CSS, 'utf8')).toContain('@theme inline');
  });

  it('defines --animate-ping-slow at the spec’s 1.8s ambient tempo, with its own keyframes', () => {
    const css = readFileSync(GLOBALS_CSS, 'utf8');
    expect(css).toContain('--animate-ping-slow:');
    expect(css).toContain('pingSlow 1.8s');
    expect(css).toContain('@keyframes pingSlow');
  });

  it('never redefines --animate-ping — expert-card.tsx:141 uses the stock class', () => {
    const css = readFileSync(GLOBALS_CSS, 'utf8');
    expect(css).not.toContain('--animate-ping:');
  });
});
