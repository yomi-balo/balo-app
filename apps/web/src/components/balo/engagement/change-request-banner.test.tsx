import { describe, it, expect } from 'vitest';

import { render, screen } from '@/test/utils';
import type { ChangeRequestBannerView } from '@/lib/engagement/engagement-view';

import { ChangeRequestBanner } from './change-request-banner';

const expertLens: ChangeRequestBannerView = {
  attribution: 'Dana @ Northwind Industrial',
  note: 'The dashboard needs the pipeline widget before we sign off.',
  expertNudge: 'fix it up and mark the project complete again when ready.',
};

describe('ChangeRequestBanner', () => {
  it('renders the attribution and note', () => {
    render(<ChangeRequestBanner banner={expertLens} />);
    expect(
      screen.getByText('Dana @ Northwind Industrial requested changes before accepting:')
    ).toBeInTheDocument();
    expect(screen.getByText(/pipeline widget/)).toBeInTheDocument();
  });

  it('appends the expert nudge when present', () => {
    render(<ChangeRequestBanner banner={expertLens} />);
    expect(screen.getByText(/fix it up and mark the project complete/)).toBeInTheDocument();
  });

  it('omits the nudge for the admin lens (expertNudge null)', () => {
    render(<ChangeRequestBanner banner={{ ...expertLens, expertNudge: null }} />);
    expect(screen.queryByText(/fix it up/)).not.toBeInTheDocument();
    expect(screen.getByText(/pipeline widget/)).toBeInTheDocument();
  });

  it('renders no action buttons (read-only)', () => {
    render(<ChangeRequestBanner banner={expertLens} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
