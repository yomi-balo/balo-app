import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const { mockProjectAction, mockCaseAction, mockRefresh } = vi.hoisted(() => ({
  mockProjectAction: vi.fn(),
  mockCaseAction: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock('@/app/(dashboard)/engagements/[id]/_actions/set-action-item-status', () => ({
  setActionItemStatusAction: mockProjectAction,
}));
vi.mock('@/app/(dashboard)/cases/[engagementId]/_actions/set-case-action-item-status', () => ({
  setCaseActionItemStatusAction: mockCaseAction,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from 'sonner';
import { useSetActionItemStatus } from './use-set-action-item-status';

beforeEach(() => {
  vi.clearAllMocks();
  mockProjectAction.mockResolvedValue({ success: true, actionItemId: 'ai-1' });
  mockCaseAction.mockResolvedValue({ success: true, actionItemId: 'ai-1' });
});

describe('useSetActionItemStatus', () => {
  it('routes the case grain to the case action, never the project one', async () => {
    const { result } = renderHook(() => useSetActionItemStatus('eng-1', 'case'));
    await result.current('ai-1', 'done');
    expect(mockCaseAction).toHaveBeenCalledWith({
      engagementId: 'eng-1',
      actionItemId: 'ai-1',
      status: 'done',
    });
    expect(mockProjectAction).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Marked done');
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('routes the project grain to the project action', async () => {
    const { result } = renderHook(() => useSetActionItemStatus('eng-1', 'project'));
    await result.current('ai-1', 'open');
    expect(mockProjectAction).toHaveBeenCalledWith({
      engagementId: 'eng-1',
      actionItemId: 'ai-1',
      status: 'open',
    });
    expect(mockCaseAction).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Reopened');
  });

  it('toasts the returned error verbatim and still refreshes to server truth', async () => {
    mockCaseAction.mockResolvedValue({ success: false, error: 'This case is closed.' });
    const { result } = renderHook(() => useSetActionItemStatus('eng-1', 'case'));
    await result.current('ai-1', 'done');
    expect(toast.error).toHaveBeenCalledWith('This case is closed.');
    expect(toast.success).not.toHaveBeenCalled();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});
