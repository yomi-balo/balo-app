import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { AgencyEmptyState } from './agency-empty-state';

describe('AgencyEmptyState', () => {
  it('invites rather than reporting an absence, and offers no button', () => {
    render(<AgencyEmptyState agencyName="Cloudline Partners" />);
    expect(
      screen.getByRole('heading', { name: "Cloudline Partners's projects will gather here" })
    ).toBeInTheDocument();
    expect(screen.getByText(/step in on delivery/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
