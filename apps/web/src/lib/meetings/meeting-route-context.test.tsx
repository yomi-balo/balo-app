import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MeetingRouteContextProvider, useMeetingRoute } from './meeting-route-context';

/**
 * BAL-435 — route-scoped ambient data for the call frame.
 *
 * ⚠⚠ N5 (fix-round-2) — CORRECTING A NOW-FALSE CLAIM. This used to say "the absence of a
 * provider IS the guest case" — true of BAL-435, false since BAL-445 §7 (fix-round-1,
 * CRITICAL-3) made both `join-control.tsx` and `lobby-client.tsx` mount
 * `MeetingRouteContextProvider` too, with a real `MeetingGuestPanelRegistration` as `panels`
 * and every OTHER field passed explicitly at its empty value (`title={null}`, `backTo={null}`,
 * `waiting={null}`, …). The describe block below is therefore the GENUINELY unregistered
 * fallback — no provider ancestor at all, a defensive/structural answer, not a real mount
 * shape — and is named that way. `meeting-route-context.guest-mount.test.tsx` covers the REAL
 * guest mounts (G-NEW-2).
 */

function Probe(): React.JSX.Element {
  const route = useMeetingRoute();
  return (
    <div
      data-testid="probe"
      data-meeting-id={route.meetingId ?? ''}
      data-viewer-name={route.viewerName ?? ''}
      data-title={route.title ?? ''}
      data-back={route.backTo?.href ?? ''}
      data-noun={route.contextNoun}
      data-absent={route.waiting?.absentParty ?? ''}
      data-has-exit={route.onExit === undefined ? 'no' : 'yes'}
    >
      <button type="button" onClick={() => route.onExit?.('self')}>
        exit
      </button>
    </div>
  );
}

describe('useMeetingRoute — with NO provider at all (the defensive fallback, NOT a real mount shape)', () => {
  it('⚠ never throws, and answers null for everything route-scoped', () => {
    render(<Probe />);

    const probe = screen.getByTestId('probe');
    expect(probe).toHaveAttribute('data-meeting-id', '');
    expect(probe).toHaveAttribute('data-viewer-name', '');
    expect(probe).toHaveAttribute('data-title', '');
    expect(probe).toHaveAttribute('data-back', '');
    expect(probe).toHaveAttribute('data-absent', '');
  });

  it("⚠ falls back to the noun 'call' — true of every context, and never the wrong one", () => {
    render(<Probe />);

    // "…all stay with the call" is true whatever this meeting is attached to; naming the wrong
    // context on a DESTRUCTIVE confirm is not.
    expect(screen.getByTestId('probe')).toHaveAttribute('data-noun', 'call');
  });

  it('⚠⚠ has NO exit — matches a real guest mount, which never passes one either', () => {
    render(<Probe />);

    expect(screen.getByTestId('probe')).toHaveAttribute('data-has-exit', 'no');
  });
});

describe('MeetingRouteContextProvider — the MEMBER mount', () => {
  it('supplies every field, including the R10 waiting subject', () => {
    render(
      <MeetingRouteContextProvider
        meetingId="m-1"
        viewerName="Dana Okoro"
        title="Salesforce flow review"
        backTo={{ label: 'Back to the case', href: '/consultations' }}
        contextNoun="case"
        waiting={{
          absentParty: 'client',
          counterpartyFirstName: 'Northwind Industrial',
          scheduledStartLabel: '10:00 am',
        }}
      >
        <Probe />
      </MeetingRouteContextProvider>
    );

    const probe = screen.getByTestId('probe');
    expect(probe).toHaveAttribute('data-meeting-id', 'm-1');
    expect(probe).toHaveAttribute('data-viewer-name', 'Dana Okoro');
    expect(probe).toHaveAttribute('data-title', 'Salesforce flow review');
    expect(probe).toHaveAttribute('data-back', '/consultations');
    expect(probe).toHaveAttribute('data-noun', 'case');
    expect(probe).toHaveAttribute('data-absent', 'client');
  });

  it('raises the exit with its reason', async () => {
    const onExit = vi.fn();
    const user = userEvent.setup();
    render(
      <MeetingRouteContextProvider
        meetingId="m-1"
        viewerName={null}
        title={null}
        backTo={null}
        contextNoun="call"
        waiting={null}
        onExit={onExit}
      >
        <Probe />
      </MeetingRouteContextProvider>
    );

    await user.click(screen.getByRole('button', { name: 'exit' }));

    expect(onExit).toHaveBeenCalledWith('self');
  });
});
