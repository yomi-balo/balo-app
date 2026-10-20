import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';

const push = vi.fn();
const replace = vi.fn();
const PATHNAME = '/projects/req-1/proposal/rel-1';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => PATHNAME,
}));

import { ProposalSent } from './proposal-sent';

const REQUEST_ID = '11111111-1111-1111-1111-111111111111';

function renderSent(reviseMode: boolean, version: number): void {
  render(
    <ProposalSent
      requestId={REQUEST_ID}
      companyName="Northwind"
      clientName="Dana"
      reviseMode={reviseMode}
      version={version}
    />
  );
}

describe('ProposalSent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('congratulates a first send and attributes the client as Name @ Company', () => {
    renderSent(false, 1);

    expect(
      screen.getByRole('heading', { name: 'Nice work. Your proposal is with Northwind' })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Dana @ Northwind has an email and a notification/)
    ).toBeInTheDocument();
  });

  it('names the version in revise mode', () => {
    renderSent(true, 3);
    expect(
      screen.getByRole('heading', { name: 'Version 3 is with Northwind' })
    ).toBeInTheDocument();
  });

  it('View proposal drops the ?sent param so the page renders the submitted view', async () => {
    const user = userEvent.setup();
    renderSent(false, 1);

    await user.click(screen.getByRole('button', { name: 'View proposal' }));

    expect(replace).toHaveBeenCalledWith(PATHNAME);
    expect(push).not.toHaveBeenCalled();
  });

  it('Back to project navigates to the request', async () => {
    const user = userEvent.setup();
    renderSent(false, 1);

    await user.click(screen.getByRole('button', { name: 'Back to project' }));

    expect(push).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
  });

  it('moves focus to the headline on mount', () => {
    renderSent(false, 1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
  });
});
