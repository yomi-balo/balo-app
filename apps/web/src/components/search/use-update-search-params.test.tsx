import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { mockReplace, mockPush, mockUseSearchParams } = vi.hoisted(() => ({
  mockReplace: vi.fn(),
  mockPush: vi.fn(),
  mockUseSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
  usePathname: () => '/experts',
  useSearchParams: () => mockUseSearchParams(),
}));

import { useUpdateSearchParams } from './use-update-search-params';

beforeEach(() => {
  vi.clearAllMocks();
  mockUseSearchParams.mockReturnValue(new URLSearchParams());
  window.scrollTo = vi.fn();
});

describe('useUpdateSearchParams', () => {
  it('setParam writes the param via replace and drops page', () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('page=3'));
    const { result } = renderHook(() => useUpdateSearchParams());
    act(() => result.current.setParam('sort', 'soonest'));
    expect(mockReplace).toHaveBeenCalledWith('/experts?sort=soonest', { scroll: false });
  });

  it('setChromeParam (layout) preserves the current page', () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('page=3'));
    const { result } = renderHook(() => useUpdateSearchParams());
    act(() => result.current.setChromeParam('layout', 'list'));
    const url = mockReplace.mock.calls[0]![0] as string;
    expect(url).toContain('layout=list');
    expect(url).toContain('page=3');
  });

  it('setChromeParam with null/empty removes the param but keeps page', () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('layout=list&page=3'));
    const { result } = renderHook(() => useUpdateSearchParams());
    act(() => result.current.setChromeParam('layout', null));
    const url = mockReplace.mock.calls[0]![0] as string;
    expect(url).not.toContain('layout');
    expect(url).toContain('page=3');
  });

  it('changing a filter (setParam) still resets page to 1', () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('page=3'));
    const { result } = renderHook(() => useUpdateSearchParams());
    act(() => result.current.setParam('sort', 'soonest'));
    const url = mockReplace.mock.calls[0]![0] as string;
    expect(url).toContain('sort=soonest');
    expect(url).not.toContain('page');
  });

  it('setParam with null/empty removes the param', () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('timeframe=week'));
    const { result } = renderHook(() => useUpdateSearchParams());
    act(() => result.current.setParam('timeframe', null));
    expect(mockReplace).toHaveBeenCalledWith('/experts', { scroll: false });
  });

  it('addValueToArray appends without duplicating and resets page', () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('products=p1&page=2'));
    const { result } = renderHook(() => useUpdateSearchParams());
    act(() => result.current.addValueToArray('products', 'p2'));
    const url = mockReplace.mock.calls[0]![0] as string;
    expect(url).toContain('products=p1');
    expect(url).toContain('products=p2');
    expect(url).not.toContain('page=2');
  });

  it('addValueToArray does not duplicate an existing value', () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('products=p1'));
    const { result } = renderHook(() => useUpdateSearchParams());
    act(() => result.current.addValueToArray('products', 'p1'));
    expect(mockReplace).toHaveBeenCalledWith('/experts?products=p1', { scroll: false });
  });

  it('removeValueFromArray removes just that value', () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('products=p1&products=p2'));
    const { result } = renderHook(() => useUpdateSearchParams());
    act(() => result.current.removeValueFromArray('products', 'p1'));
    expect(mockReplace).toHaveBeenCalledWith('/experts?products=p2', { scroll: false });
  });

  it('clearAll navigates to the bare pathname', () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('products=p1&q=x'));
    const { result } = renderHook(() => useUpdateSearchParams());
    act(() => result.current.clearAll());
    expect(mockReplace).toHaveBeenCalledWith('/experts', { scroll: false });
  });

  it('setPage uses push (history) and does not reset page', () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('sort=soonest'));
    const { result } = renderHook(() => useUpdateSearchParams());
    act(() => result.current.setPage(3));
    const url = mockPush.mock.calls[0]![0] as string;
    expect(url).toContain('page=3');
    expect(url).toContain('sort=soonest');
  });

  it('setPage to 1 omits the page param', () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('page=4'));
    const { result } = renderHook(() => useUpdateSearchParams());
    act(() => result.current.setPage(1));
    expect(mockPush).toHaveBeenCalledWith('/experts', { scroll: false });
  });

  it('setParams pushes the provided params', () => {
    const { result } = renderHook(() => useUpdateSearchParams());
    act(() => result.current.setParams(new URLSearchParams('products=p1&timeframe=today')));
    expect(mockPush).toHaveBeenCalledWith('/experts?products=p1&timeframe=today', {
      scroll: false,
    });
  });

  it('getFilters parses the current URL', () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('q=flows&sort=lowest_rate'));
    const { result } = renderHook(() => useUpdateSearchParams());
    const filters = result.current.getFilters();
    expect(filters.q).toBe('flows');
    expect(filters.sort).toBe('lowest_rate');
  });
});
