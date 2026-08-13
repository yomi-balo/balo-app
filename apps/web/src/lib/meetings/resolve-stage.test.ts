import { describe, expect, it } from 'vitest';
import { isVideoLayout, resolveStageKind, type ResolveStageInput } from './resolve-stage';

const BASE: ResolveStageInput = {
  hasJoined: true,
  remoteCount: 0,
  isAnyoneScreenSharing: false,
  override: null,
};

describe('resolveStageKind', () => {
  it('shows prejoin until the viewer has joined — whatever else is true', () => {
    expect(resolveStageKind({ ...BASE, hasJoined: false })).toBe('prejoin');
    expect(
      resolveStageKind({
        ...BASE,
        hasJoined: false,
        remoteCount: 5,
        isAnyoneScreenSharing: true,
        override: 'gallery',
      })
    ).toBe('prejoin');
  });

  it('⚠ screen share beats the manual override — it is the strongest signal in the room', () => {
    expect(
      resolveStageKind({
        ...BASE,
        remoteCount: 3,
        isAnyoneScreenSharing: true,
        override: 'spotlight',
      })
    ).toBe('screenshare');
  });

  it('⚠ the override SURVIVES a screenshare start→stop round trip', () => {
    const chose: ResolveStageInput = { ...BASE, remoteCount: 4, override: 'spotlight' };
    expect(resolveStageKind(chose)).toBe('spotlight');
    expect(resolveStageKind({ ...chose, isAnyoneScreenSharing: true })).toBe('screenshare');
    expect(resolveStageKind({ ...chose, isAnyoneScreenSharing: false })).toBe('spotlight');
  });

  it('shows the waiting (empty) stage when nobody else is here', () => {
    expect(resolveStageKind({ ...BASE, remoteCount: 0 })).toBe('waiting');
    // ⚠ Even with an override set — there is nothing to lay out.
    expect(resolveStageKind({ ...BASE, remoteCount: 0, override: 'gallery' })).toBe('waiting');
  });

  it('⚠ the override beats the headcount once somebody else is here', () => {
    expect(resolveStageKind({ ...BASE, remoteCount: 1, override: 'gallery' })).toBe('gallery');
    expect(resolveStageKind({ ...BASE, remoteCount: 6, override: 'spotlight' })).toBe('spotlight');
  });

  it('auto-selects spotlight at one remote and gallery from two upward', () => {
    expect(resolveStageKind({ ...BASE, remoteCount: 1 })).toBe('spotlight');
    for (let remoteCount = 2; remoteCount <= 9; remoteCount += 1) {
      expect(resolveStageKind({ ...BASE, remoteCount })).toBe('gallery');
    }
  });

  it('stays on gallery above the soft participant cap', () => {
    expect(resolveStageKind({ ...BASE, remoteCount: 14 })).toBe('gallery');
  });
});

describe('isVideoLayout', () => {
  it('is true only for the two layouts a layout toggle can switch between', () => {
    expect(isVideoLayout('spotlight')).toBe(true);
    expect(isVideoLayout('gallery')).toBe(true);
    expect(isVideoLayout('prejoin')).toBe(false);
    expect(isVideoLayout('waiting')).toBe(false);
    expect(isVideoLayout('screenshare')).toBe(false);
  });
});
