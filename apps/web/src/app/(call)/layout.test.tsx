import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import CallLayout from './layout';

/**
 * BAL-435 — the chrome-free shell.
 *
 * ⚠⚠ THE SESSION-DRIFT GATE IS **NOT** HERE, AND ITS ABSENCE IS ASSERTED ON PURPOSE. The version
 * that lived here read `headers().get('x-invoke-path')` — a header that does not exist in Next 16
 * — so `returnTo` was always `/dashboard` and a drifted member was bounced away from the call
 * they were entering. A layout cannot see a child segment's params, so the gate moved to the
 * PAGE, which knows the `meetingId` and can name the real destination. `page.test.tsx` pins it.
 */
describe('CallLayout', () => {
  it('renders its children with no app chrome at all', () => {
    render(
      <CallLayout>
        <p>the call</p>
      </CallLayout>
    );

    expect(screen.getByText('the call')).toBeInTheDocument();
    // No nav, no footer, no sidebar: the frame IS the page.
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('banner')).toBeNull();
    expect(screen.queryByRole('contentinfo')).toBeNull();
  });

  it('⚠ is h-dvh and overflow-hidden — never h-screen', () => {
    // Mobile browser chrome makes `100vh` taller than the visible viewport, which pushes the
    // toolbar (and the Leave button) off-screen.
    const { container } = render(
      <CallLayout>
        <p>the call</p>
      </CallLayout>
    );

    const shell = container.firstElementChild;
    expect(shell?.className).toContain('h-dvh');
    expect(shell?.className).toContain('overflow-hidden');
    expect(shell?.className).not.toContain('h-screen');
  });

  it('⚠ does NOT force the dark palette — the pre-frame notice cards stay in the viewer theme', () => {
    // The frame's own `.dark` lives on `meeting-frame-impl.tsx`. Forcing it here would render
    // the grant-unavailable and retry cards dark for a light-mode viewer before any call exists.
    const { container } = render(
      <CallLayout>
        <p>the call</p>
      </CallLayout>
    );

    expect(container.firstElementChild?.className).not.toContain('dark');
  });
});
