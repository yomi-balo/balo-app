import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePageFileDrop } from './use-page-file-drop';

function dragEvent(type: string, init: { types?: string[]; files?: File[] } = {}): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: init.types ?? ['Files'], files: init.files ?? [] },
  });
  return event;
}

function fire(event: Event): void {
  act(() => {
    globalThis.dispatchEvent(event);
  });
}

describe('usePageFileDrop', () => {
  it('turns dragActive on when a file drag enters and off when it leaves', () => {
    const { result } = renderHook(() => usePageFileDrop({ enabled: true, onFiles: vi.fn() }));
    expect(result.current.dragActive).toBe(false);
    fire(dragEvent('dragenter'));
    expect(result.current.dragActive).toBe(true);
    fire(dragEvent('dragleave'));
    expect(result.current.dragActive).toBe(false);
  });

  it('stays active while the pointer crosses nested elements', () => {
    const { result } = renderHook(() => usePageFileDrop({ enabled: true, onFiles: vi.fn() }));
    fire(dragEvent('dragenter'));
    fire(dragEvent('dragenter'));
    fire(dragEvent('dragleave'));
    expect(result.current.dragActive).toBe(true);
    fire(dragEvent('dragleave'));
    expect(result.current.dragActive).toBe(false);
  });

  it('hands dropped files to onFiles and consumes the drop', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => usePageFileDrop({ enabled: true, onFiles }));
    const file = new File(['x'], 'brief.pdf', { type: 'application/pdf' });
    fire(dragEvent('dragenter'));
    const drop = dragEvent('drop', { files: [file] });
    fire(drop);
    expect(onFiles).toHaveBeenCalledWith([file]);
    expect(drop.defaultPrevented).toBe(true);
    expect(result.current.dragActive).toBe(false);
  });

  it('prevents default on dragover so the page accepts the drop', () => {
    renderHook(() => usePageFileDrop({ enabled: true, onFiles: vi.fn() }));
    const over = dragEvent('dragover');
    fire(over);
    expect(over.defaultPrevented).toBe(true);
  });

  it('ignores drags that carry no files', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => usePageFileDrop({ enabled: true, onFiles }));
    fire(dragEvent('dragenter', { types: ['text/plain'] }));
    expect(result.current.dragActive).toBe(false);
    const over = dragEvent('dragover', { types: ['text/plain'] });
    fire(over);
    expect(over.defaultPrevented).toBe(false);
    fire(dragEvent('dragleave', { types: ['text/plain'] }));
    const drop = dragEvent('drop', { types: ['text/plain'] });
    fire(drop);
    expect(onFiles).not.toHaveBeenCalled();
    expect(drop.defaultPrevented).toBe(false);
  });

  it('does not call onFiles for a file drop that holds no files', () => {
    const onFiles = vi.fn();
    renderHook(() => usePageFileDrop({ enabled: true, onFiles }));
    fire(dragEvent('drop', { files: [] }));
    expect(onFiles).not.toHaveBeenCalled();
  });

  it('is a no-op while disabled', () => {
    const onFiles = vi.fn();
    const { result } = renderHook(() => usePageFileDrop({ enabled: false, onFiles }));
    fire(dragEvent('dragenter'));
    fire(dragEvent('drop', { files: [new File(['x'], 'a.pdf')] }));
    expect(result.current.dragActive).toBe(false);
    expect(onFiles).not.toHaveBeenCalled();
  });

  it('stops listening and clears the overlay when disabled mid-drag', () => {
    const onFiles = vi.fn();
    const { result, rerender } = renderHook(
      ({ enabled }) => usePageFileDrop({ enabled, onFiles }),
      { initialProps: { enabled: true } }
    );
    fire(dragEvent('dragenter'));
    expect(result.current.dragActive).toBe(true);
    rerender({ enabled: false });
    expect(result.current.dragActive).toBe(false);
    fire(dragEvent('drop', { files: [new File(['x'], 'a.pdf')] }));
    expect(onFiles).not.toHaveBeenCalled();
  });

  it('uses the latest onFiles without re-attaching listeners', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => usePageFileDrop({ enabled: true, onFiles: cb }), {
      initialProps: { cb: first },
    });
    rerender({ cb: second });
    const file = new File(['x'], 'a.pdf');
    fire(dragEvent('drop', { files: [file] }));
    expect(second).toHaveBeenCalledWith([file]);
    expect(first).not.toHaveBeenCalled();
  });
});
