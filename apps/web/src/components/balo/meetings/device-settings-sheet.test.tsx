import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { dailyState, installMediaStubs, resetDailyMock } from '@/test/mocks/daily';
import {
  DEVICES_BLOCKED_BODY,
  DEVICES_EMPTY_BODY,
  DeviceSettingsSheet,
} from './device-settings-sheet';
import { MeetingFrameElementProvider } from './meeting-frame-element';

/**
 * BAL-435 — camera / microphone / speaker selection, ⚠⚠ **the §8.3 portal rule** and all four
 * states.
 *
 * ⚠⚠ THE PORTAL ASSERTION IS DOM ANCESTRY, NOT A CLASS CHECK. In fullscreen the browser renders
 * only the fullscreen element's subtree, so a dialog portaled to `<body>` is INVISIBLE — and
 * `className="dark"` on the portal would fix the colour problem while leaving that one intact.
 *
 * ⚠ THE **SPEAKER** SELECT IS HIDDEN WHERE OUTPUT SELECTION IS UNSUPPORTED (Safari, iOS) rather
 * than rendered dead. A control that cannot do anything is worse than an absent one.
 */

vi.mock('@daily-co/daily-react', async () => {
  const { dailyReactModuleMock } = await import('@/test/mocks/daily');
  return dailyReactModuleMock();
});

let frameElement: HTMLElement;

beforeEach(() => {
  resetDailyMock();
  installMediaStubs();
  frameElement = document.createElement('div');
  document.body.append(frameElement);
});

afterEach(() => {
  frameElement.remove();
});

function renderSheet(open = true): HTMLElement {
  return render(
    <MeetingFrameElementProvider element={frameElement}>
      <DeviceSettingsSheet open={open} onOpenChange={vi.fn()} />
    </MeetingFrameElementProvider>
  ).container;
}

describe('DeviceSettingsSheet — ⚠⚠ the portal renders INSIDE the frame', () => {
  it('puts the open dialog in the frame element, not in document.body', async () => {
    renderSheet();

    const dialog = await screen.findByRole('dialog');
    expect(frameElement.contains(dialog)).toBe(true);
  });

  it('⚠ and NOT under any other child of <body> — which is what fullscreen would hide', async () => {
    renderSheet();

    const dialog = await screen.findByRole('dialog');
    for (const child of document.body.children) {
      if (child === frameElement) continue;
      expect(child.contains(dialog)).toBe(false);
    }
  });
});

describe('DeviceSettingsSheet — the four states', () => {
  it('LOADING: renders skeleton rows inside an <output>, never role="status"', async () => {
    dailyState.camState = 'pending';
    renderSheet();

    // ⚠ `<output>` rather than `role="status"` — SonarCloud S6819 flags the ARIA role where a
    // native element exists.
    const loading = await screen.findByLabelText('Loading your devices');
    expect(loading.tagName).toBe('OUTPUT');
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('ERROR: permission denied says the BROWSER is refusing, and offers the way to fix it', async () => {
    dailyState.micState = 'blocked';
    renderSheet();

    // ⚠ NOT the empty-state copy. The devices exist; the browser is refusing them, and telling
    // somebody their hardware is missing sends them to the wrong place to fix it.
    expect(await screen.findByText(DEVICES_BLOCKED_BODY)).toBeInTheDocument();
    expect(screen.queryByText(DEVICES_EMPTY_BODY)).toBeNull();
    expect(screen.getByRole('link', { name: 'How to allow it' })).toBeInTheDocument();
  });

  it('⚠ EMPTY: no devices at all says so, and still says "You can still join and listen"', async () => {
    dailyState.cameras = [];
    dailyState.microphones = [];
    renderSheet();

    expect(await screen.findByText(DEVICES_EMPTY_BODY)).toBeInTheDocument();
    expect(screen.queryByText(DEVICES_BLOCKED_BODY)).toBeNull();
    // ⚠ "How to allow it" is meaningless advice when there is nothing to allow.
    expect(screen.queryByRole('link', { name: 'How to allow it' })).toBeNull();
  });

  it('SUCCESS: renders a labelled select per device kind', async () => {
    renderSheet();

    await screen.findByRole('dialog');
    for (const label of ['Camera', 'Microphone', 'Speaker']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});

describe('DeviceSettingsSheet — the speaker select', () => {
  it('⚠ is HIDDEN, not disabled, where output selection is unsupported (Safari / iOS)', async () => {
    dailyState.speakers = [];
    renderSheet();

    await screen.findByRole('dialog');
    expect(screen.queryByText('Speaker')).toBeNull();
    // ⚠ ABSENT, not present-and-dead: a control that cannot do anything is worse than none.
    expect(frameElement.querySelectorAll('[disabled]')).toHaveLength(0);
  });
});

describe('DeviceSettingsSheet — labelling and refresh', () => {
  it('associates every label with its control via htmlFor / id', async () => {
    renderSheet();

    await screen.findByRole('dialog');
    // ⚠ Typed as a tuple array, not `string[][]`: `noUncheckedIndexedAccess` makes a destructure
    // of the latter `string | undefined`, which is not a valid Testing Library matcher.
    const ROWS: ReadonlyArray<readonly [label: string, id: string]> = [
      ['Camera', 'meeting-camera'],
      ['Microphone', 'meeting-microphone'],
      ['Speaker', 'meeting-speaker'],
    ];
    for (const [label, id] of ROWS) {
      expect(screen.getByText(label)).toHaveAttribute('for', id);
      expect(frameElement.querySelector(`#${id}`)).not.toBeNull();
    }
  });

  it('refreshes the device list when it opens, and not before', async () => {
    const { rerender } = render(
      <MeetingFrameElementProvider element={frameElement}>
        <DeviceSettingsSheet open={false} onOpenChange={vi.fn()} />
      </MeetingFrameElementProvider>
    );
    expect(dailyState.cameras.length).toBeGreaterThan(0);
    const { refreshDevices } = await import('@/test/mocks/daily').then((m) => m.dailySpies);
    expect(refreshDevices).not.toHaveBeenCalled();

    rerender(
      <MeetingFrameElementProvider element={frameElement}>
        <DeviceSettingsSheet open onOpenChange={vi.fn()} />
      </MeetingFrameElementProvider>
    );

    expect(refreshDevices).toHaveBeenCalled();
  });

  it('⚠ a failed refresh leaves the last known list — the right degradation', async () => {
    const { dailySpies } = await import('@/test/mocks/daily');
    dailySpies.refreshDevices.mockRejectedValueOnce(new Error('device enumeration failed'));
    renderSheet();

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Camera')).toBeInTheDocument();
  });

  it('renders nothing while closed', () => {
    renderSheet(false);

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('has no accessibility violations, open', async () => {
    renderSheet();

    await screen.findByRole('dialog');
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
