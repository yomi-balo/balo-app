import { describe, expect, it } from 'vitest';
import { axe } from 'jest-axe';
import { render, screen } from '@/test/utils';
import {
  ROOM_SETTING_UP_LABEL,
  ROOM_SETTING_UP_SHORT_LABEL,
} from '@/lib/meetings/room-setting-up-copy';
import { RoomSettingUpSlot } from './room-setting-up-slot';

/**
 * The non-interactive JOIN slot for a meeting whose call room is not ready. Never a `button`
 * or `a` — see the component docblock for why it deliberately carries no `role="status"`.
 */
describe('RoomSettingUpSlot', () => {
  it('button variant: renders the long label visibly by default', () => {
    render(<RoomSettingUpSlot variant="button" />);
    expect(screen.getByText(ROOM_SETTING_UP_LABEL)).toBeVisible();
  });

  it('button variant: renders the short label when label="short"', () => {
    render(<RoomSettingUpSlot variant="button" label="short" />);
    expect(screen.getByText(ROOM_SETTING_UP_SHORT_LABEL)).toBeVisible();
    expect(screen.queryByText(ROOM_SETTING_UP_LABEL)).not.toBeInTheDocument();
  });

  it('button variant: contains no button or link element', () => {
    const { container } = render(<RoomSettingUpSlot variant="button" />);
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
  });

  it('button variant: forwards the caller-supplied sizing classes', () => {
    const { container } = render(<RoomSettingUpSlot variant="button" className="min-h-11 px-4" />);
    const el = container.firstElementChild;
    expect(el?.className).toMatch(/min-h-11/);
    expect(el?.className).toMatch(/px-4/);
  });

  it('button variant: has no accessibility violations', async () => {
    const { container } = render(<RoomSettingUpSlot variant="button" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('chip variant: exposes the long label as sr-only text, not visibly', () => {
    render(<RoomSettingUpSlot variant="chip" />);
    const srText = screen.getByText(ROOM_SETTING_UP_LABEL);
    expect(srText).toHaveClass('sr-only');
  });

  it('chip variant: carries the label as a title for pointer users', () => {
    const { container } = render(<RoomSettingUpSlot variant="chip" />);
    expect(container.firstElementChild).toHaveAttribute('title', ROOM_SETTING_UP_LABEL);
  });

  it('chip variant: contains no button or link element', () => {
    const { container } = render(<RoomSettingUpSlot variant="chip" />);
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
  });

  it('chip variant: never has role="status" — it is page content, not an update', () => {
    const { container } = render(<RoomSettingUpSlot variant="chip" />);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('chip variant: has no accessibility violations', async () => {
    const { container } = render(<RoomSettingUpSlot variant="chip" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
