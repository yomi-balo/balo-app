'use client';

import { useEffect, useRef } from 'react';
import { useAudioLevelObserver, useDevices, useLocalSessionId } from '@daily-co/daily-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { MeetingDialog } from './meeting-overlay';

/**
 * BAL-435 — camera / microphone / speaker selection, with all four states.
 *
 * ⚠⚠ THE **SPEAKER** SELECT IS HIDDEN WHERE OUTPUT SELECTION IS UNSUPPORTED (Safari, iOS)
 * RATHER THAN RENDERED DEAD. A control that cannot do anything is worse than an absent one.
 *
 * ⚠⚠ THE LIVE MIC METER WRITES TO **REFS AND THE DOM**, NEVER TO STATE. An audio-level callback
 * fires many times a second; `setState` per frame would re-render the whole dialog — and, in the
 * frame, everything under it. (`rerender-use-ref-transient-values`.)
 *
 * ⚠ FOUR STATES: loading = skeleton rows; **empty = no devices found**, with joining still
 * possible; error = permission denied, with the help line; success = populated selects.
 */

const METER_BAR_KEYS = ['a', 'b', 'c', 'd', 'e'] as const;

/**
 * ⚠⚠ TWO DIFFERENT FACTS, TWO DIFFERENT SENTENCES. "We can't find a camera or microphone" is
 * FALSE for a permission denial — the devices are right there and the BROWSER is refusing them —
 * and telling somebody their hardware is missing when it is not sends them to the wrong place to
 * fix it. The file's own docblock always claimed four states; the two were collapsed into one.
 */
export const DEVICES_EMPTY_BODY =
  "We can't find a camera or microphone. You can still join and listen.";

export const DEVICES_BLOCKED_BODY =
  'Your browser is blocking the camera and microphone. You can still join and listen.';

function MicMeter(): React.JSX.Element {
  const localSessionId = useLocalSessionId();
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);

  useAudioLevelObserver(
    localSessionId,
    // ⚠ DIRECT DOM MUTATION, ON PURPOSE. See the docblock.
    (volume) => {
      for (const [index, bar] of barsRef.current.entries()) {
        if (bar === null) continue;
        const threshold = (index + 1) / METER_BAR_KEYS.length;
        bar.style.opacity = volume >= threshold ? '1' : '0.25';
      }
    }
  );

  return (
    <span className="mt-2 flex items-center gap-1" aria-hidden="true">
      {METER_BAR_KEYS.map((key, index) => (
        <span
          key={key}
          ref={(node) => {
            barsRef.current[index] = node;
          }}
          className="bg-primary h-2 w-6 rounded-full opacity-25 transition-opacity"
        />
      ))}
    </span>
  );
}

function DeviceRow({
  id,
  label,
  value,
  options,
  onChange,
  children,
}: Readonly<{
  id: string;
  label: string;
  value: string | undefined;
  options: ReadonlyArray<{ deviceId: string; label: string }>;
  onChange: (deviceId: string) => void;
  children?: React.ReactNode;
}>): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      {/* ⚠ `htmlFor` matched to the trigger's `id` — every control needs an accessible name. */}
      <label htmlFor={id} className="text-foreground block text-[13px] font-medium">
        {label}
      </label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="System default" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.deviceId} value={option.deviceId}>
              {option.label.length === 0 ? 'Unnamed device' : option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {children}
    </div>
  );
}

const SKELETON_KEYS = ['camera', 'microphone', 'speaker'] as const;

export function DeviceSettingsSheet({
  open,
  onOpenChange,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void }>): React.JSX.Element {
  const {
    cameras,
    microphones,
    speakers,
    currentCam,
    currentMic,
    currentSpeaker,
    camState,
    micState,
    setCamera,
    setMicrophone,
    setSpeaker,
    refreshDevices,
  } = useDevices();

  useEffect(() => {
    if (!open) return;
    // ⚠ NOT `void`-PREFIXED (S3735). A refresh that fails leaves the last known list, which is
    // exactly the right degradation.
    refreshDevices().catch(() => {});
  }, [open, refreshDevices]);

  const isPending = camState === 'pending' || micState === 'pending';
  const isBlocked = camState === 'blocked' || micState === 'blocked';
  const isEmpty = !isPending && cameras.length === 0 && microphones.length === 0;

  const toOptions = (
    devices: ReadonlyArray<{ device: MediaDeviceInfo }>
  ): ReadonlyArray<{ deviceId: string; label: string }> =>
    devices.map(({ device }) => ({ deviceId: device.deviceId, label: device.label }));

  return (
    <MeetingDialog open={open} onOpenChange={onOpenChange} title="Camera and sound">
      <DeviceSettingsBody
        isPending={isPending}
        isBlocked={isBlocked}
        isEmpty={isEmpty}
        cameras={toOptions(cameras)}
        microphones={toOptions(microphones)}
        speakers={toOptions(speakers)}
        currentCamId={currentCam?.device.deviceId}
        currentMicId={currentMic?.device.deviceId}
        currentSpeakerId={currentSpeaker?.device.deviceId}
        onSetCamera={setCamera}
        onSetMicrophone={setMicrophone}
        onSetSpeaker={setSpeaker}
      />
    </MeetingDialog>
  );
}

interface DeviceSettingsBodyProps {
  readonly isPending: boolean;
  readonly isBlocked: boolean;
  readonly isEmpty: boolean;
  readonly cameras: ReadonlyArray<{ deviceId: string; label: string }>;
  readonly microphones: ReadonlyArray<{ deviceId: string; label: string }>;
  readonly speakers: ReadonlyArray<{ deviceId: string; label: string }>;
  readonly currentCamId: string | undefined;
  readonly currentMicId: string | undefined;
  readonly currentSpeakerId: string | undefined;
  readonly onSetCamera: (deviceId: string) => Promise<void>;
  readonly onSetMicrophone: (deviceId: string) => Promise<void>;
  readonly onSetSpeaker: (deviceId: string) => Promise<void>;
}

/**
 * ⚠ EXTRACTED so `DeviceSettingsSheet` stays under the cognitive-complexity threshold — the same
 * "state resolution above, appearance below" split the rest of this feature uses.
 */
function DeviceSettingsBody({
  isPending,
  isBlocked,
  isEmpty,
  cameras,
  microphones,
  speakers,
  currentCamId,
  currentMicId,
  currentSpeakerId,
  onSetCamera,
  onSetMicrophone,
  onSetSpeaker,
}: Readonly<DeviceSettingsBodyProps>): React.JSX.Element {
  if (isPending) {
    return (
      <output aria-label="Loading your devices" className="block space-y-4">
        {SKELETON_KEYS.map((key) => (
          <span key={key} className="bg-muted/60 block h-10 w-full animate-pulse rounded-lg" />
        ))}
        <span className="sr-only">Loading…</span>
      </output>
    );
  }

  if (isBlocked) {
    return (
      <div className="space-y-2">
        <p className="text-muted-foreground text-[13px] leading-relaxed">{DEVICES_BLOCKED_BODY}</p>
        {/* ⚠ THE HELP LINK BELONGS TO THIS BRANCH ONLY. "How to allow it" is meaningless advice
            when there is nothing to allow. */}
        <a
          href="https://support.google.com/chrome/answer/2693767"
          target="_blank"
          rel="noreferrer noopener"
          className="text-primary inline-flex min-h-11 items-center text-[13px] font-medium"
        >
          How to allow it
        </a>
      </div>
    );
  }

  if (isEmpty) {
    return (
      <p className="text-muted-foreground text-[13px] leading-relaxed">{DEVICES_EMPTY_BODY}</p>
    );
  }

  return (
    <div className="space-y-4">
      <DeviceRow
        id="meeting-camera"
        label="Camera"
        value={currentCamId}
        options={cameras}
        onChange={(deviceId) => {
          onSetCamera(deviceId).catch(() => {});
        }}
      />
      <DeviceRow
        id="meeting-microphone"
        label="Microphone"
        value={currentMicId}
        options={microphones}
        onChange={(deviceId) => {
          onSetMicrophone(deviceId).catch(() => {});
        }}
      >
        {/* ⚠ "Is this thing on?" answered without anybody having to speak. */}
        <MicMeter />
      </DeviceRow>
      {/* ⚠ HIDDEN, NOT DISABLED, where output selection is unsupported (Safari / iOS). */}
      {speakers.length === 0 ? null : (
        <DeviceRow
          id="meeting-speaker"
          label="Speaker"
          value={currentSpeakerId}
          options={speakers}
          onChange={(deviceId) => {
            onSetSpeaker(deviceId).catch(() => {});
          }}
        />
      )}
    </div>
  );
}
