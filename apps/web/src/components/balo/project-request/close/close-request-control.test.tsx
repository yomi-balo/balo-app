import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/close-request', () => ({
  closeRequestAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/close-request-as-admin', () => ({
  closeRequestAsAdminAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import { CloseRequestControl } from './close-request-control';

describe('CloseRequestControl', () => {
  it('opens the CloseRequestSheet when clicked', async () => {
    const user = userEvent.setup();
    render(
      <CloseRequestControl
        requestId="req-1"
        requestTitle="CPQ implementation"
        companyName="Northwind Industrial"
        variant="client"
        liveTracks={[]}
      />
    );
    expect(screen.queryByText('Close this request?')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /close request/i }));
    expect(await screen.findByText('Close this request?')).toBeInTheDocument();
  });
});
