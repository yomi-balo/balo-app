import { vi, type Mock } from 'vitest';

/**
 * BAL-435 — **THE SHARED `@daily-co/daily-react` TEST DOUBLE.**
 *
 * ⚠⚠ IMPORTED **PER TEST FILE**, NEVER FROM `setup.ts`. Most of the web suite has no business
 * loading a video-call vendor's hook surface, and a global `vi.mock` of it would make every
 * unrelated test pay for — and silently depend on — this module.
 *
 * Usage, in a test file that renders anything at or below `meeting-frame-impl.tsx`:
 *
 * ```ts
 * vi.mock('@daily-co/daily-react', async () => {
 *   const { dailyReactModuleMock } = await import('@/test/mocks/daily');
 *   return dailyReactModuleMock();
 * });
 * ```
 *
 * The factory and the test file resolve to the SAME module instance (vitest caches the registry),
 * so `dailyState` and `dailySpies` imported at the top of a test drive the hooks the component
 * under test calls.
 *
 * ── ⚠ THE THREE JSDOM GAPS THIS MODULE ALSO CLOSES ──────────────────────────────────────────
 *
 * `setup.ts` already stubs `ResizeObserver` and `IntersectionObserver` (which Radix `Popover` and
 * `Dialog` need). It does NOT stub these three, and every one of them is reachable from this
 * feature — so they are stubbed HERE, on demand, rather than globally:
 *
 *   · `navigator.mediaDevices` — absent in jsdom. Without it `DeviceSettingsSheet`'s four states
 *     are unreachable.
 *   · `MediaStream` — absent in jsdom. `ParticipantTile` and `PreJoin` both construct one in a
 *     ref effect to attach a track, and an unstubbed constructor throws inside `useEffect`.
 *   · `HTMLMediaElement.prototype.play` — jsdom throws "Not implemented". A REJECTED variant is
 *     also provided, because §12.14's autoplay-blocked pill is only reachable when it rejects.
 *
 * ⚠ `matchMedia` IS NOT STUBBED HERE. The repo's established convention for anything touching
 * `useIsMobile` is a per-file module mock (seven existing call sites do exactly this):
 * `vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))`. Stubbing `matchMedia`
 * instead would make the breakpoint depend on a jsdom default nobody set deliberately.
 */

/** One media track's state, as `useMediaTrack` / `useVideoTrack` report it. */
export interface MockTrackState {
  isOff: boolean;
  persistentTrack: MediaStreamTrack | null;
}

/** A participant, as `useParticipantProperty` reads it. */
export interface MockParticipant {
  user_name: string | null;
  /** ⚠ DAILY'S OWN OWNER FLAG on that participant — the only input to the Host pill. */
  owner: boolean;
}

/** A device, in the `{ device }` wrapper `useDevices` returns. */
export interface MockDevice {
  device: { deviceId: string; label: string; kind: string };
}

export type MockDeviceState = 'idle' | 'pending' | 'granted' | 'blocked' | 'not-found';

export interface DailyMockState {
  localSessionId: string;
  /** ⚠ Already `joined_at`-sorted, exactly as Daily returns it with `{ sort: 'joined_at' }`. */
  participantIds: string[];
  participants: Record<string, MockParticipant>;
  tracks: Record<string, Partial<Record<'video' | 'audio' | 'screenVideo', MockTrackState>>>;
  meetingState: string;
  networkState: string;
  activeSpeakerId: string | null;
  isSharingScreen: boolean;
  screens: Array<{ session_id: string }>;
  camState: MockDeviceState;
  micState: MockDeviceState;
  cameras: MockDevice[];
  microphones: MockDevice[];
  speakers: MockDevice[];
  currentCam: MockDevice | null;
  currentMic: MockDevice | null;
  currentSpeaker: MockDevice | null;
  /** ⚠ `true` ⇒ `join()` rejects, which is how the fatal-error branch is reached. */
  joinRejects: boolean;
}

const OFF_TRACK: MockTrackState = { isOff: true, persistentTrack: null };

function makeDevice(deviceId: string, label: string, kind: string): MockDevice {
  return { device: { deviceId, label, kind } };
}

function defaultState(): DailyMockState {
  return {
    localSessionId: 'local-session',
    participantIds: ['local-session'],
    participants: { 'local-session': { user_name: 'You', owner: false } },
    tracks: {},
    meetingState: 'joined-meeting',
    networkState: 'good',
    activeSpeakerId: null,
    isSharingScreen: false,
    screens: [],
    camState: 'granted',
    micState: 'granted',
    cameras: [makeDevice('cam-1', 'FaceTime HD Camera', 'videoinput')],
    microphones: [makeDevice('mic-1', 'MacBook Pro Microphone', 'audioinput')],
    speakers: [makeDevice('spk-1', 'MacBook Pro Speakers', 'audiooutput')],
    currentCam: makeDevice('cam-1', 'FaceTime HD Camera', 'videoinput'),
    currentMic: makeDevice('mic-1', 'MacBook Pro Microphone', 'audioinput'),
    currentSpeaker: makeDevice('spk-1', 'MacBook Pro Speakers', 'audiooutput'),
    joinRejects: false,
  };
}

/**
 * The mutable room. ⚠ Mutate it BEFORE `render()`; the hooks read it at call time, so a change
 * after mount needs a re-render (or an event) to be observed — which is honest, because that is
 * how the real hooks behave too.
 */
export const dailyState: DailyMockState = defaultState();

/**
 * Every method a component calls on the call object, so a test can assert the vendor call.
 *
 * ⚠ THE TYPE IS WRITTEN OUT RATHER THAN INFERRED. Inference names `@vitest/spy`'s internal
 * `MockInstance`, which lives at a pnpm-hashed path `tsc` refuses to emit (TS2742) — so the
 * annotation is load-bearing, not decoration.
 */
export interface DailySpies {
  readonly join: Mock;
  readonly leave: Mock;
  /** ⚠ SYNCHRONOUS in daily-js — it returns the call object, not a promise. */
  readonly updateParticipants: Mock;
  readonly setLocalAudio: Mock;
  readonly setLocalVideo: Mock;
  readonly startCamera: Mock;
  readonly startScreenShare: Mock;
  readonly stopScreenShare: Mock;
  readonly setCamera: Mock;
  readonly setMicrophone: Mock;
  readonly setSpeaker: Mock;
  readonly refreshDevices: Mock;
}

export const dailySpies: DailySpies = {
  join: vi.fn(),
  leave: vi.fn(),
  updateParticipants: vi.fn(),
  setLocalAudio: vi.fn(),
  setLocalVideo: vi.fn(),
  startCamera: vi.fn(),
  startScreenShare: vi.fn(),
  stopScreenShare: vi.fn(),
  setCamera: vi.fn(),
  setMicrophone: vi.fn(),
  setSpeaker: vi.fn(),
  refreshDevices: vi.fn(),
};

/** `useDailyEvent` registrations, so a test can fire `network-connection` or `left-meeting`. */
const eventHandlers = new Map<string, Array<(payload: unknown) => void>>();

/** Fire every handler registered for `event`. Wrap the call in `act()` at the call site. */
export function emitDailyEvent(event: string, payload: unknown): void {
  for (const handler of eventHandlers.get(event) ?? []) handler(payload);
}

/** Reset the room AND every spy. ⚠ Call in `beforeEach` — the state module is shared per file. */
export function resetDailyMock(): void {
  Object.assign(dailyState, defaultState());
  eventHandlers.clear();
  for (const spy of Object.values(dailySpies)) spy.mockReset();
  dailySpies.join.mockImplementation(() =>
    dailyState.joinRejects ? Promise.reject(new Error('join failed')) : Promise.resolve({})
  );
  dailySpies.leave.mockResolvedValue(undefined);
  dailySpies.startCamera.mockResolvedValue(undefined);
  dailySpies.refreshDevices.mockResolvedValue(undefined);
  dailySpies.setCamera.mockResolvedValue(undefined);
  dailySpies.setMicrophone.mockResolvedValue(undefined);
  dailySpies.setSpeaker.mockResolvedValue(undefined);
  dailySpies.updateParticipants.mockReturnValue(undefined);
}

resetDailyMock();

function trackOf(sessionId: string, kind: 'video' | 'audio' | 'screenVideo'): MockTrackState {
  return dailyState.tracks[sessionId]?.[kind] ?? OFF_TRACK;
}

/**
 * The module shape `vi.mock('@daily-co/daily-react', …)` returns.
 *
 * ⚠ `DailyProvider` IS A PASS-THROUGH. The real one owns a jotai store the components under test
 * never read directly — every read goes through a hook, and every hook is stubbed here.
 */
export function dailyReactModuleMock(): Record<string, unknown> {
  return {
    DailyProvider: ({ children }: { children?: React.ReactNode }) => children,
    useCallObject: () => dailySpies,
    useDaily: () => dailySpies,
    useLocalSessionId: () => dailyState.localSessionId,
    useParticipantIds: () => dailyState.participantIds,
    useActiveSpeakerId: () => dailyState.activeSpeakerId,
    useMeetingState: () => dailyState.meetingState,
    useNetwork: () => ({ networkState: dailyState.networkState }),
    useScreenShare: () => ({
      isSharingScreen: dailyState.isSharingScreen,
      screens: dailyState.screens,
      startScreenShare: dailySpies.startScreenShare,
      stopScreenShare: dailySpies.stopScreenShare,
    }),
    useMediaTrack: (sessionId: string, kind: 'video' | 'audio' | 'screenVideo' = 'video') =>
      trackOf(sessionId, kind),
    useVideoTrack: (sessionId: string) => trackOf(sessionId, 'video'),
    useParticipantProperty: (sessionId: string, property: keyof MockParticipant) =>
      dailyState.participants[sessionId]?.[property] ?? null,
    useAudioLevelObserver: () => undefined,
    useDailyEvent: (event: string, handler: (payload: unknown) => void) => {
      const existing = eventHandlers.get(event) ?? [];
      if (!existing.includes(handler)) existing.push(handler);
      eventHandlers.set(event, existing);
    },
    useDevices: () => ({
      cameras: dailyState.cameras,
      microphones: dailyState.microphones,
      speakers: dailyState.speakers,
      currentCam: dailyState.currentCam,
      currentMic: dailyState.currentMic,
      currentSpeaker: dailyState.currentSpeaker,
      camState: dailyState.camState,
      micState: dailyState.micState,
      setCamera: dailySpies.setCamera,
      setMicrophone: dailySpies.setMicrophone,
      setSpeaker: dailySpies.setSpeaker,
      refreshDevices: dailySpies.refreshDevices,
    }),
  };
}

/**
 * Close the three jsdom gaps. Idempotent, so calling it from several `beforeEach` blocks in one
 * file is harmless.
 *
 * ⚠ `globalThis`, never a bare `window` (SonarCloud S7764) — and that applies in test files too.
 */
export function installMediaStubs(): void {
  class MediaStreamStub {
    private readonly tracks: readonly MediaStreamTrack[];
    constructor(tracks: readonly MediaStreamTrack[] = []) {
      this.tracks = tracks;
    }
    getTracks(): readonly MediaStreamTrack[] {
      return this.tracks;
    }
  }
  if (!('MediaStream' in globalThis)) {
    globalThis.MediaStream = MediaStreamStub as unknown as typeof MediaStream;
  }

  if (globalThis.navigator.mediaDevices === undefined) {
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([]),
        getUserMedia: vi.fn().mockResolvedValue(new MediaStreamStub()),
      },
    });
  }

  stubMediaPlay('resolved');
}

/**
 * `HTMLMediaElement.prototype.play`.
 *
 * ⚠ jsdom's own implementation THROWS "Not implemented", so every `<video autoPlay>` in this
 * feature needs this. `'rejected'` is the §12.14 autoplay-blocked case — the browser refusing to
 * start audio without a qualifying gesture — and it must reject with a `NotAllowedError`-shaped
 * failure rather than throw synchronously.
 */
export function stubMediaPlay(outcome: 'resolved' | 'rejected'): void {
  HTMLMediaElement.prototype.play = vi
    .fn()
    .mockImplementation(() =>
      outcome === 'resolved'
        ? Promise.resolve()
        : Promise.reject(Object.assign(new Error('play() failed'), { name: 'NotAllowedError' }))
    );
}
