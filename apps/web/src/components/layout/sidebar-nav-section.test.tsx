import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SidebarNavSection } from './sidebar-nav-section';

/**
 * BAL-497 — `SidebarNavSection` in isolation: three plain `<a>` children, no `Sidebar`, no
 * registry. The mutable module-level `pathname` + `usePathname` mock is the
 * `mobile-tab-bar.test.tsx` precedent.
 */

let pathname = '/a';

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}));

const HREFS = ['/a', '/b', '/c'];

function renderSection(section: 'primary' | 'secondary' = 'primary'): ReturnType<typeof render> {
  return render(
    <SidebarNavSection section={section} hrefs={HREFS}>
      <a href="/a">A</a>
      <a href="/b">B</a>
      <a href="/c">C</a>
    </SidebarNavSection>
  );
}

describe('SidebarNavSection (BAL-497)', () => {
  it('the pill is mounted, aria-hidden, and outside the a11y tree', () => {
    renderSection();
    const pill = screen.getByTestId('sidebar-nav-pill-primary');
    expect(pill).toHaveAttribute('aria-hidden', 'true');
    expect(pill.tagName).toBe('SPAN');
    // Not a link, button, or any other interactive role — nothing for a screen reader to land on.
    expect(pill.getAttribute('role')).toBeNull();
  });

  it('the pill parks on the active index', () => {
    pathname = '/b';
    renderSection();
    const pill = screen.getByTestId('sidebar-nav-pill-primary');
    expect(pill.style.transform).toBe('translateY(48px)');
    expect(pill.className).toContain('opacity-100');
  });

  it('no active item ⇒ faded but STILL MOUNTED — unmounting would kill the transition (D5)', () => {
    pathname = '/zzz';
    renderSection();
    const pill = screen.getByTestId('sidebar-nav-pill-primary');
    expect(pill).toBeInTheDocument();
    expect(pill.className).toContain('opacity-0');
    expect(pill.style.transform).toBe('translateY(0px)');
  });

  it('pathname change moves the pill, and moves it back — the pure-function-of-usePathname guarantee', () => {
    // This is the browser back/forward guarantee: the pill is a pure function of
    // `usePathname()`, which Next 16's App Router updates on `popstate`. jsdom has no App
    // Router, so mutating the mocked pathname and re-rendering IS the observable — a real
    // `popstate` cannot be exercised here, and that is the honest maximum, not a gap.
    pathname = '/a';
    const { rerender } = renderSection();
    const pill = screen.getByTestId('sidebar-nav-pill-primary');
    expect(pill.style.transform).toBe('translateY(0px)');

    pathname = '/c';
    rerender(
      <SidebarNavSection section="primary" hrefs={HREFS}>
        <a href="/a">A</a>
        <a href="/b">B</a>
        <a href="/c">C</a>
      </SidebarNavSection>
    );
    expect(pill.style.transform).toBe('translateY(96px)');

    pathname = '/a';
    rerender(
      <SidebarNavSection section="primary" hrefs={HREFS}>
        <a href="/a">A</a>
        <a href="/b">B</a>
        <a href="/c">C</a>
      </SidebarNavSection>
    );
    expect(pill.style.transform).toBe('translateY(0px)');
  });

  it('THE PITCH PIN, class side: pill carries h-11, the row stack carries gap-1 and flex-col', () => {
    // Ties to `SIDEBAR_NAV_ROW_HEIGHT_PX` / `SIDEBAR_NAV_ROW_GAP_PX` in `sidebar-nav-pill.ts` —
    // changing one class without changing the constant desynchronises the pill silently.
    pathname = '/a';
    renderSection();
    const pill = screen.getByTestId('sidebar-nav-pill-primary');
    expect(pill.className).toContain('h-11');
    const rowStack = pill.nextElementSibling;
    expect(rowStack?.className).toContain('gap-1');
    expect(rowStack?.className).toContain('flex-col');
  });

  it('carries the full motion contract — the CLASS is the transition, jsdom computes none', () => {
    // `motion-reduce:` is the only reduced-motion mechanism here (D10); jsdom never runs a real
    // transition, so pinning the class string IS pinning the behaviour.
    renderSection();
    const pill = screen.getByTestId('sidebar-nav-pill-primary');
    expect(pill.className).toContain('transition-[transform,opacity]');
    expect(pill.className).toContain('[transition-duration:.26s,.15s]');
    expect(pill.className).toContain('[transition-timing-function:cubic-bezier(.4,0,.2,1),ease]');
    expect(pill.className).toContain('motion-reduce:transition-none');
  });

  it('the secondary section gets its own, distinct pill test id', () => {
    renderSection('secondary');
    expect(screen.getByTestId('sidebar-nav-pill-secondary')).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-nav-pill-primary')).not.toBeInTheDocument();
  });

  it('stacking order: the pill is the first child, absolute + pointer-events-none, rows are its next sibling', () => {
    renderSection();
    const pill = screen.getByTestId('sidebar-nav-pill-primary');
    expect(pill.parentElement?.firstElementChild).toBe(pill);
    expect(pill.className).toContain('absolute');
    expect(pill.className).toContain('pointer-events-none');
    expect(pill.nextElementSibling).not.toBeNull();
  });
});
