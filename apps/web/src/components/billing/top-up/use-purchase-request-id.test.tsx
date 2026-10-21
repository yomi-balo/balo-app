import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePurchaseRequestId } from './use-purchase-request-id';

describe('usePurchaseRequestId', () => {
  it('returns the same id across renders of the same signature', () => {
    const { result, rerender } = renderHook(({ sig }) => usePurchaseRequestId(sig), {
      initialProps: { sig: 'a' },
    });
    const first = result.current.clientRequestId;

    rerender({ sig: 'a' });

    expect(result.current.clientRequestId).toBe(first);
  });

  it('returns a new id when the signature changes', () => {
    const { result, rerender } = renderHook(({ sig }) => usePurchaseRequestId(sig), {
      initialProps: { sig: 'a' },
    });
    const first = result.current.clientRequestId;

    rerender({ sig: 'b' });

    expect(result.current.clientRequestId).not.toBe(first);
  });

  it('returns a new id after rotate, then holds it', () => {
    const { result, rerender } = renderHook(() => usePurchaseRequestId('a'));
    const first = result.current.clientRequestId;

    act(() => result.current.rotate());
    const rotated = result.current.clientRequestId;
    rerender();

    expect(rotated).not.toBe(first);
    expect(result.current.clientRequestId).toBe(rotated);
  });

  it('gives a stable rotate callback', () => {
    const { result, rerender } = renderHook(({ sig }) => usePurchaseRequestId(sig), {
      initialProps: { sig: 'a' },
    });
    const rotate = result.current.rotate;

    rerender({ sig: 'b' });

    expect(result.current.rotate).toBe(rotate);
  });
});
