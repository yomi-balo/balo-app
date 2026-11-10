import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { axe } from '@/test/axe';
import {
  PROFICIENCY_RAMP_CLASSES,
  SegmentedSlider,
  valueFromKey,
  valueFromPointer,
} from './segmented-slider';

describe('valueFromPointer', () => {
  it('returns 0 at and left of the first segment', () => {
    expect(valueFromPointer(0, 100)).toBe(0);
    expect(valueFromPointer(-5, 100)).toBe(0);
  });

  it('rounds up inside a segment', () => {
    expect(valueFromPointer(1, 100)).toBe(1);
    expect(valueFromPointer(25, 100)).toBe(3);
    expect(valueFromPointer(55, 100)).toBe(6);
  });

  it('caps at 10 at the right edge and beyond', () => {
    expect(valueFromPointer(100, 100)).toBe(10);
    expect(valueFromPointer(140, 100)).toBe(10);
  });

  it('returns 0 for a zero-width track', () => {
    expect(valueFromPointer(10, 0)).toBe(0);
  });
});

describe('valueFromKey', () => {
  it.each([
    ['ArrowRight', 5, 6],
    ['ArrowUp', 5, 6],
    ['ArrowLeft', 5, 4],
    ['ArrowDown', 5, 4],
    ['PageUp', 5, 7],
    ['PageDown', 5, 3],
    ['Home', 5, 0],
    ['End', 5, 10],
  ])('%s from %i gives %i', (key, from, expected) => {
    expect(valueFromKey(key, from)).toBe(expected);
  });

  it('clamps at both ends', () => {
    expect(valueFromKey('ArrowRight', 10)).toBe(10);
    expect(valueFromKey('PageUp', 9)).toBe(10);
    expect(valueFromKey('ArrowLeft', 0)).toBe(0);
    expect(valueFromKey('PageDown', 1)).toBe(0);
  });

  it('returns null for an unhandled key', () => {
    expect(valueFromKey('a', 5)).toBeNull();
  });
});

describe('SegmentedSlider', () => {
  const onValueChange = vi.fn();

  beforeEach(() => {
    onValueChange.mockClear();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      width: 100,
      right: 100,
      top: 0,
      bottom: 4,
      height: 4,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
  });

  function setup(value = 3, disabled = false): HTMLElement {
    render(
      <SegmentedSlider
        value={value}
        onValueChange={onValueChange}
        aria-label="Apex"
        aria-valuetext={`${value}`}
        disabled={disabled}
      />
    );
    return screen.getByRole('slider', { name: 'Apex' });
  }

  it('exposes slider semantics', () => {
    const slider = setup(4);
    expect(slider).toHaveAttribute('aria-valuemin', '0');
    expect(slider).toHaveAttribute('aria-valuemax', '10');
    expect(slider).toHaveAttribute('aria-valuenow', '4');
  });

  it('sets the value from a press and rounds up', () => {
    const slider = setup();
    fireEvent.pointerDown(slider, { clientX: 55, pointerId: 1 });
    expect(onValueChange).toHaveBeenLastCalledWith(6);
  });

  it('sets 0 when pressed left of the track', () => {
    const slider = setup();
    fireEvent.pointerDown(slider, { clientX: -5, pointerId: 1 });
    expect(onValueChange).toHaveBeenLastCalledWith(0);
  });

  it('follows a drag past the left edge to 0', () => {
    const slider = setup();
    fireEvent.pointerDown(slider, { clientX: 55, pointerId: 1 });
    fireEvent.pointerMove(slider, { clientX: -10, pointerId: 1 });
    expect(onValueChange).toHaveBeenLastCalledWith(0);
  });

  it('ignores moves after the pointer is released', () => {
    const slider = setup();
    fireEvent.pointerDown(slider, { clientX: 55, pointerId: 1 });
    fireEvent.pointerUp(slider, { pointerId: 1 });
    onValueChange.mockClear();
    fireEvent.pointerMove(slider, { clientX: 90, pointerId: 1 });
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('handles Home, End and PageUp from the keyboard', () => {
    const slider = setup(9);
    fireEvent.keyDown(slider, { key: 'End' });
    expect(onValueChange).toHaveBeenLastCalledWith(10);
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(onValueChange).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(slider, { key: 'PageUp' });
    expect(onValueChange).toHaveBeenLastCalledWith(10);
  });

  it('does not call back when the value is unchanged', () => {
    const slider = setup(10);
    fireEvent.keyDown(slider, { key: 'End' });
    fireEvent.pointerDown(slider, { clientX: 100, pointerId: 1 });
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('ignores unhandled keys', () => {
    const slider = setup();
    fireEvent.keyDown(slider, { key: 'a' });
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('is inert when disabled', () => {
    const slider = setup(3, true);
    expect(slider).toHaveAttribute('aria-disabled', 'true');
    expect(slider).toHaveAttribute('data-disabled');
    fireEvent.keyDown(slider, { key: 'End' });
    fireEvent.pointerDown(slider, { clientX: 55, pointerId: 1 });
    fireEvent.pointerMove(slider, { clientX: 80, pointerId: 1 });
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('colours segments up to the value with their ramp class', () => {
    const { container } = render(
      <SegmentedSlider
        value={3}
        onValueChange={onValueChange}
        aria-label="Flow"
        aria-valuetext="3"
      />
    );
    for (let k = 1; k <= 10; k += 1) {
      const segment = container.querySelector(`[data-segment="${k}"]`);
      if (k <= 3) {
        expect(segment?.className).toContain(PROFICIENCY_RAMP_CLASSES[k]);
      } else {
        expect(segment?.className).toContain('bg-border');
      }
    }
  });

  it('renders the track overlay', () => {
    render(
      <SegmentedSlider
        value={3}
        onValueChange={onValueChange}
        aria-label="Flow"
        aria-valuetext="3"
        trackOverlay={<span data-testid="overlay" />}
      />
    );
    expect(screen.getByTestId('overlay')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <SegmentedSlider
        value={3}
        onValueChange={onValueChange}
        aria-label="Flow"
        aria-valuetext="3"
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
