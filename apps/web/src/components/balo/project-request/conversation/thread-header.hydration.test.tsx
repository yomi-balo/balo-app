import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { thread } from '@/test/fixtures/conversation';
import { MobileActionRail } from './mobile-action-rail';
import { ThreadHeader } from './thread-header';
import { deriveThreadActions } from './thread-actions';

/**
 * Time-dependent copy is derived from the VIEWER's clock, which does not exist on the server or
 * on the first client render. Under a non-UTC `TZ` (a viewer on the far side of the date line from
 * the server), anything computed from "now" at render time would differ between the server HTML
 * and the hydrating client — so neither surface may emit it until the clock effect has run.
 */
const CALLS = [
  {
    meetingId: 'meeting-1',
    scheduledStartIso: '2026-09-03T04:00:00.000Z',
    contextType: 'request_interaction',
  },
  {
    meetingId: 'meeting-2',
    scheduledStartIso: '2026-09-04T04:00:00.000Z',
    contextType: 'project_call',
  },
] as const;

const FORBIDDEN_BEFORE_CLOCK = /today|tomorrow|Join in|Join now/;

function Header(): React.JSX.Element {
  const t = thread({ upcomingCalls: [...CALLS] });
  return (
    <ThreadHeader
      thread={t}
      showYouSuffix={false}
      actions={deriveThreadActions({
        lens: 'client',
        requestStatus: 'eoi_submitted',
        thread: t,
        nudgeIsProposal: false,
      })}
      callPending={false}
      profileBookingHref={null}
      deliveryEngagementId="eng-1"
      joinPartyLabel={t.expertName}
      onCall={vi.fn()}
      onBookAnother={vi.fn()}
      onJoin={vi.fn()}
      onRequestProposal={null}
      onBuildProposal={null}
      onViewProposal={null}
      onDecline={null}
    />
  );
}

function Rail(): React.JSX.Element {
  return (
    <MobileActionRail
      visible
      callSlot={{ kind: 'upcoming', next: CALLS[0], more: 1, canBookAnother: true }}
      callPending={false}
      expertName="Priya Nair"
      expertFirstName="Priya"
      upcomingCalls={CALLS}
      profileBookingHref={null}
      deliveryEngagementId="eng-1"
      joinPartyLabel="Priya Nair"
      proposalCta={null}
      onCall={vi.fn()}
      onBookAnother={vi.fn()}
      onJoin={vi.fn()}
      onProposal={null}
      onBuildProposal={null}
      onViewProposal={null}
    />
  );
}

beforeEach(() => {
  vi.stubEnv('TZ', 'Pacific/Auckland');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe.each([
  ['desktop ThreadHeader', Header],
  ['mobile MobileActionRail', Rail],
] as const)('%s — hydration under a non-UTC TZ (AC9)', (_name, Surface) => {
  it('server HTML carries no clock-derived copy, hydrates without error, then fills in', async () => {
    const html = renderToString(<Surface />);
    expect(html).toContain('Next call');
    expect(html).not.toMatch(FORBIDDEN_BEFORE_CLOCK);

    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.append(container);

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onRecoverableError = vi.fn();
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, <Surface />, { onRecoverableError });
    });

    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();

    // After the clock effect, the viewer-zone labels appear (Auckland is UTC+12 in September).
    expect(container.textContent).toContain('Thu 3 Sep at 4:00 pm');
    expect(container.textContent).toContain('Join in 2 days');

    await act(async () => root?.unmount());
  });
});
