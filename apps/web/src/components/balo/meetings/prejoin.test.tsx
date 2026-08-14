import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  dailyState,
  installMediaStubs,
  resetDailyMock,
  type MockDeviceState,
} from '@/test/mocks/daily';
import { PreJoin, SKIP_PREJOIN_STORAGE_KEY, type PreJoinProps } from './prejoin';

/**
 * BAL-435 — PreJoin. **Optional, skippable, never blocking.**
 *
 * ⚠⚠ THE TWO ASSERTIONS THIS FILE EXISTS FOR:
 *
 *   1. **A BLOCKED CAMERA — OR NO DEVICES AT ALL — DOES NOT DISABLE JOIN.** Audio-only is a valid
 *      call and so is listen-only. Disabling the primary CTA because a permission is off would
 *      lock a paying participant out of a call they are entitled to attend.
 *   2. **THERE IS NO MANUAL NAME ENTRY ANYWHERE.** The grant already binds identity, and a
 *      free-text name on a `privacy: 'private'` room is an impersonation surface.
 */

vi.mock('@daily-co/daily-react', async () => {
  const { dailyReactModuleMock } = await import('@/test/mocks/daily');
  return dailyReactModuleMock();
});

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

// jsdom has no `matchMedia`; the repo's convention (7 existing call sites) is to mock the hook.
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

function renderPreJoin(overrides: Partial<PreJoinProps> = {}): HTMLElement {
  const props: PreJoinProps = {
    displayName: 'Dana Okafor',
    isJoining: false,
    micOn: true,
    cameraOn: true,
    onToggleMic: vi.fn(),
    onToggleCamera: vi.fn(),
    onOpenSettings: vi.fn(),
    onJoin: vi.fn(),
    ...overrides,
  };
  return render(
    <TooltipProvider>
      <PreJoin {...props} />
    </TooltipProvider>
  ).container;
}

beforeEach(() => {
  resetDailyMock();
  installMediaStubs();
  globalThis.localStorage.clear();
  vi.restoreAllMocks();
});

describe('PreJoin — joining is never blocked', () => {
  const BLOCKING_STATES: readonly MockDeviceState[] = ['blocked', 'not-found'];

  for (const camState of BLOCKING_STATES) {
    it(`⚠⚠ keeps "Join now" ENABLED when the camera is ${camState}`, async () => {
      dailyState.camState = camState;
      const user = userEvent.setup();
      const onJoin = vi.fn();
      renderPreJoin({ onJoin });

      const join = screen.getByRole('button', { name: 'Join now' });
      expect(join).toBeEnabled();
      await user.click(join);
      expect(onJoin).toHaveBeenCalledTimes(1);
    });
  }

  it('says the browser blocked the camera, and offers a way to fix it', () => {
    dailyState.camState = 'blocked';
    renderPreJoin();

    expect(screen.getByText('Camera blocked in your browser')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'How to allow it' })).toBeInTheDocument();
  });

  it('shows "Camera off" — not the blocked copy — when the person simply turned it off', () => {
    renderPreJoin({ cameraOn: false });

    expect(screen.getByText('Camera off')).toBeInTheDocument();
    expect(screen.queryByText('Camera blocked in your browser')).toBeNull();
  });

  it('shows a pending label while the join runs, and dims it only to 80%', () => {
    renderPreJoin({ isJoining: true });

    const join = screen.getByRole('button', { name: /joining/i });
    expect(join).toBeDisabled();
    // ⚠ 80, NOT 60 — a 60% wash on `bg-primary` drops the label under 4.5:1 at the exact moment
    // the person is most anxious the click registered.
    expect(join.className).toContain('disabled:opacity-80');
  });
});

describe('PreJoin — identity is bound by the grant, never typed', () => {
  it('⚠⚠ renders NO text input anywhere on the screen', () => {
    const container = renderPreJoin();

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(container.querySelectorAll('input[type="text"]')).toHaveLength(0);
    // The only input on this surface is the skip preference.
    const inputs = [...container.querySelectorAll('input')];
    expect(inputs.map((input) => input.type)).toEqual(['checkbox']);
  });

  it('names the person from the session when there is one', () => {
    renderPreJoin({ displayName: 'Dana Okafor' });

    expect(screen.getByText(/Joining as Dana Okafor/)).toBeInTheDocument();
  });

  it('⚠ omits the identity line entirely for a guest, rather than guessing', () => {
    const container = renderPreJoin({ displayName: null });

    expect(container.textContent ?? '').not.toMatch(/joining as/i);
  });
});

describe('PreJoin — the skip preference', () => {
  it('is off by default, and the label is associated with the control', () => {
    renderPreJoin();

    const checkbox = screen.getByRole('checkbox', { name: 'Skip this next time' });
    expect(checkbox).not.toBeChecked();
  });

  it('⚠ writes localStorage — a PREFERENCE persists; only the lobby TOKEN dies with the tab', async () => {
    const user = userEvent.setup();
    renderPreJoin();

    await user.click(screen.getByRole('checkbox', { name: 'Skip this next time' }));

    expect(globalThis.localStorage.getItem(SKIP_PREJOIN_STORAGE_KEY)).toBe('1');
  });

  it('clears the key when unticked, rather than storing a falsy value', async () => {
    globalThis.localStorage.setItem(SKIP_PREJOIN_STORAGE_KEY, '1');
    const user = userEvent.setup();
    renderPreJoin();

    const checkbox = await screen.findByRole('checkbox', { name: 'Skip this next time' });
    expect(checkbox).toBeChecked();
    await user.click(checkbox);

    expect(globalThis.localStorage.getItem(SKIP_PREJOIN_STORAGE_KEY)).toBeNull();
  });

  it('reflects an already-stored preference on mount', async () => {
    globalThis.localStorage.setItem(SKIP_PREJOIN_STORAGE_KEY, '1');
    renderPreJoin();

    expect(await screen.findByRole('checkbox', { name: 'Skip this next time' })).toBeChecked();
  });

  describe('⚠⚠ a locked-down profile, where storage THROWS rather than returning null', () => {
    it('still renders, and the preference simply degrades to "always show"', () => {
      vi.spyOn(globalThis.localStorage, 'getItem').mockImplementation(() => {
        throw new Error('The operation is insecure.');
      });

      renderPreJoin();

      expect(screen.getByRole('checkbox', { name: 'Skip this next time' })).not.toBeChecked();
    });

    it('⚠ NEVER BREAKS THE JOIN — the preference is not persisted and that is all', async () => {
      vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation(() => {
        throw new Error('The operation is insecure.');
      });
      const user = userEvent.setup();
      const onJoin = vi.fn();
      renderPreJoin({ onJoin });

      await user.click(screen.getByRole('checkbox', { name: 'Skip this next time' }));
      await user.click(screen.getByRole('button', { name: 'Join now' }));

      expect(onJoin).toHaveBeenCalledTimes(1);
    });
  });
});

describe('PreJoin — the inline controls and the heading', () => {
  it('offers mic, camera and settings, each at least 44px and each named', () => {
    renderPreJoin();

    for (const name of ['Mute', 'Stop video', 'Camera and sound']) {
      const button = screen.getByRole('button', { name });
      // 46px full-round — above the 44px minimum, on the overlaid controls too.
      expect(button.className).toContain('h-[46px]');
    }
  });

  it('renders exactly one <h1>, and it asks the question the screen is for', () => {
    const container = renderPreJoin();

    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Ready to join?');
  });

  it('⚠ mirrors the self-view preview — and only the self-view', () => {
    dailyState.tracks = { 'local-session': { video: { isOff: false, persistentTrack: null } } };
    renderPreJoin();

    const preview = screen.getByTestId('prejoin-preview');
    expect(preview.className).toContain('scale-x-[-1]');
    expect(preview).toHaveAttribute('playsinline');
  });

  it('has no accessibility violations', async () => {
    const container = renderPreJoin();

    expect(await axe(container)).toHaveNoViolations();
  });
});
