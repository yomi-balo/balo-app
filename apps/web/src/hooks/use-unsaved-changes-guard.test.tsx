import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useUnsavedChangesGuard } from './use-unsaved-changes-guard';

function clickAnchor(
  attrs: Readonly<Record<string, string>> = {},
  eventInit: Readonly<MouseEventInit> = {}
): MouseEvent {
  const anchor = document.createElement('a');
  anchor.href = attrs.href ?? '/admin/applications';
  for (const [key, value] of Object.entries(attrs)) {
    if (key !== 'href') anchor.setAttribute(key, value);
  }
  document.body.appendChild(anchor);
  const event = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...eventInit,
  });
  anchor.dispatchEvent(event);
  anchor.remove();
  return event;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useUnsavedChangesGuard', () => {
  it('intercepts a same-origin internal anchor click while active', () => {
    const onAttemptLeave = vi.fn();
    renderHook(() => useUnsavedChangesGuard(true, onAttemptLeave));

    const event = clickAnchor({ href: '/admin/applications' });

    expect(event.defaultPrevented).toBe(true);
    expect(onAttemptLeave).toHaveBeenCalledWith('/admin/applications');
  });

  it('ignores an external-origin anchor', () => {
    const onAttemptLeave = vi.fn();
    renderHook(() => useUnsavedChangesGuard(true, onAttemptLeave));

    const event = clickAnchor({ href: 'https://example.com/elsewhere' });

    expect(event.defaultPrevented).toBe(false);
    expect(onAttemptLeave).not.toHaveBeenCalled();
  });

  it('ignores a target="_blank" anchor', () => {
    const onAttemptLeave = vi.fn();
    renderHook(() => useUnsavedChangesGuard(true, onAttemptLeave));

    const event = clickAnchor({ href: '/admin/applications', target: '_blank' });

    expect(event.defaultPrevented).toBe(false);
    expect(onAttemptLeave).not.toHaveBeenCalled();
  });

  it('ignores a download anchor', () => {
    const onAttemptLeave = vi.fn();
    renderHook(() => useUnsavedChangesGuard(true, onAttemptLeave));

    const event = clickAnchor({ href: '/admin/applications', download: '' });

    expect(event.defaultPrevented).toBe(false);
    expect(onAttemptLeave).not.toHaveBeenCalled();
  });

  it('ignores a modified (meta) click', () => {
    const onAttemptLeave = vi.fn();
    renderHook(() => useUnsavedChangesGuard(true, onAttemptLeave));

    const event = clickAnchor({ href: '/admin/applications' }, { metaKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(onAttemptLeave).not.toHaveBeenCalled();
  });

  it('ignores a same-path hash link', () => {
    const onAttemptLeave = vi.fn();
    const originalPathname = globalThis.location.pathname;
    renderHook(() => useUnsavedChangesGuard(true, onAttemptLeave));

    const event = clickAnchor({ href: `${originalPathname}#section` });

    expect(event.defaultPrevented).toBe(false);
    expect(onAttemptLeave).not.toHaveBeenCalled();
  });

  it('installs no listeners when inactive', () => {
    const onAttemptLeave = vi.fn();
    renderHook(() => useUnsavedChangesGuard(false, onAttemptLeave));

    const event = clickAnchor({ href: '/admin/applications' });

    expect(event.defaultPrevented).toBe(false);
    expect(onAttemptLeave).not.toHaveBeenCalled();
  });

  it('removes its listeners on unmount', () => {
    const onAttemptLeave = vi.fn();
    const { unmount } = renderHook(() => useUnsavedChangesGuard(true, onAttemptLeave));
    unmount();

    const event = clickAnchor({ href: '/admin/applications' });

    expect(event.defaultPrevented).toBe(false);
    expect(onAttemptLeave).not.toHaveBeenCalled();
  });

  it('shows the native confirm prompt via beforeunload while active', () => {
    const onAttemptLeave = vi.fn();
    renderHook(() => useUnsavedChangesGuard(true, onAttemptLeave));

    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    globalThis.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });
});
