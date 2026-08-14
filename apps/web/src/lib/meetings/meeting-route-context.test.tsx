import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MeetingRouteContextProvider, useMeetingRoute } from './meeting-route-context';

/**
 * BAL-435 — route-scoped ambient data for the call frame.
 *
 * ⚠⚠ THE ABSENCE OF A PROVIDER **IS** THE GUEST CASE, AND EVERY FALLBACK BELOW IS A LIVE PATH.
 * `MeetingCallSurface`'s prop contract is frozen and this ticket adds nothing to it, so data that
 * one of three mounts has and the other two structurally do not is a Context, not a prop. Both
 * guest surfaces therefore read `null` for the title, the destination and the waiting subject —
 * without a single lens check anywhere.
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

describe('useMeetingRoute — with no provider (both GUEST mounts)', () => {
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

  it('⚠⚠ has NO exit — a guest has no Balo destination, so the frame handles it itself', () => {
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
