import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CompanyWorkspace } from '@balo/shared/workspaces';
import { EXPERT_WORKSPACE } from '@balo/shared/workspaces';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import { toast } from 'sonner';
import {
  WORKSPACE_SWITCH_THREW_MESSAGE,
  switchedWorkspaceLabel,
  toastWorkspaceSwitchOutcome,
  toastWorkspaceSwitchThrew,
} from './workspace-switch-feedback';

const COMPANY_A: CompanyWorkspace = {
  type: 'company',
  key: 'company:11111111-1111-4111-8111-111111111111',
  companyId: '11111111-1111-4111-8111-111111111111',
  name: 'Northwind Industrial',
  via: 'membership',
  isPersonal: false,
  role: 'owner',
};

describe('workspace-switch-feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('switchedWorkspaceLabel', () => {
    it('expert workspace → "your expert workspace"', () => {
      expect(switchedWorkspaceLabel(EXPERT_WORKSPACE)).toBe('your expert workspace');
    });

    it('company workspace → the workspace name', () => {
      expect(switchedWorkspaceLabel(COMPANY_A)).toBe('Northwind Industrial');
    });
  });

  describe('toastWorkspaceSwitchOutcome', () => {
    it('success + expert workspace → toasts "Switched to your expert workspace"', () => {
      toastWorkspaceSwitchOutcome({ success: true, data: { workspace: EXPERT_WORKSPACE } });
      expect(toast.success).toHaveBeenCalledWith('Switched to your expert workspace');
    });

    it('success + company workspace → toasts "Switched to Northwind Industrial"', () => {
      toastWorkspaceSwitchOutcome({ success: true, data: { workspace: COMPANY_A } });
      expect(toast.success).toHaveBeenCalledWith('Switched to Northwind Industrial');
    });

    it('success with data undefined → toasts "Switched to workspace"', () => {
      toastWorkspaceSwitchOutcome({ success: true, data: undefined });
      expect(toast.success).toHaveBeenCalledWith('Switched to workspace');
    });

    it('failure → toasts the exact server error string', () => {
      toastWorkspaceSwitchOutcome({
        success: false,
        error: 'Could not switch workspace. Please try again.',
      });
      expect(toast.error).toHaveBeenCalledWith('Could not switch workspace. Please try again.');
    });
  });

  describe('toastWorkspaceSwitchThrew', () => {
    it('toasts the generic thrown-error message', () => {
      toastWorkspaceSwitchThrew();
      expect(toast.error).toHaveBeenCalledWith(WORKSPACE_SWITCH_THREW_MESSAGE);
    });
  });
});
