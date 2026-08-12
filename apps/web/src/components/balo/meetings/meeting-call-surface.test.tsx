import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { MeetingCallSurface } from './meeting-call-surface';

const PROPS = {
  roomUrl: 'https://balo.daily.co/balo-0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d',
  token: 'daily.jwt.super.secret.value',
  isOwner: true,
  expiresAt: '2026-09-02T11:00:00.000Z',
  participantId: 'u0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d',
};

describe('MeetingCallSurface — the BAL-435 seam', () => {
  it('renders the Connecting state', () => {
    render(<MeetingCallSurface {...PROPS} />);

    expect(screen.getByText(/connecting/i)).toBeInTheDocument();
  });

  it('⚠⚠ NEVER renders the Daily JWT, the room URL or the participant id', () => {
    // The token is a LIVE credential to a private room. This is the assertion BAL-435 must
    // keep passing when it replaces the body with a real call mount.
    const { container } = render(<MeetingCallSurface {...PROPS} />);
    const text = container.textContent ?? '';

    expect(text).not.toContain(PROPS.token);
    expect(text).not.toContain(PROPS.roomUrl);
    expect(text).not.toContain(PROPS.participantId);
  });

  it('⚠ puts nothing sensitive in the MARKUP either — not just the visible text', () => {
    // A credential in a `data-` attribute or a hidden input is just as leaked as one in a
    // paragraph, and is exactly the shape a "helpful" debugging attribute takes.
    const { container } = render(<MeetingCallSurface {...PROPS} />);

    expect(container.innerHTML).not.toContain(PROPS.token);
    expect(container.innerHTML).not.toContain(PROPS.roomUrl);
  });

  it('⚠ renders IDENTICALLY for an owner and a non-owner — this build gates nothing', () => {
    // Stated so BAL-435 knows the host controls do not exist yet. When they land they must
    // gate on `isOwner` (the server's `host_meetings` verdict), never on a lens.
    const owner = render(<MeetingCallSurface {...PROPS} isOwner />).container.innerHTML;
    const guest = render(<MeetingCallSurface {...PROPS} isOwner={false} />).container.innerHTML;

    expect(owner).toBe(guest);
  });

  it('announces itself to assistive tech via <output>, not role="status"', () => {
    // ⚠ `<output>`, not `role="status"` — SonarCloud S6819 flags the ARIA role where a native
    // element exists.
    const { container } = render(<MeetingCallSurface {...PROPS} />);

    const region = container.querySelector('output');
    expect(region).not.toBeNull();
    expect(region?.textContent ?? '').toMatch(/you.?re in/i);
  });

  it('⚠⚠ carries NO aria-busy on the live region — it would SUPPRESS its own announcement', () => {
    // A hardcoded `aria-busy="true"` that never cleared told assistive tech to suppress this
    // region's announcements — so a screen-reader user was admitted to a call and heard
    // NOTHING. The decorative spinner wrapper is where a busy signal belongs.
    const { container } = render(<MeetingCallSurface {...PROPS} />);

    expect(container.querySelector('output')?.getAttribute('aria-busy')).toBeNull();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<MeetingCallSurface {...PROPS} />);

    expect(await axe(container)).toHaveNoViolations();
  });
});
