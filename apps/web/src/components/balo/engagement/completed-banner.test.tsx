import { describe, it, expect } from 'vitest';

import { render, screen } from '@/test/utils';
import type { CompletedBannerView } from '@/lib/engagement/engagement-view';

import { CompletedBanner } from './completed-banner';

const clientAccepted: CompletedBannerView = {
  title: 'Project completed',
  body: 'You accepted the project on 4 Jul 2026. Balo will be in touch about the final invoice.',
  readyToInvoice: false,
};

const adminAuto: CompletedBannerView = {
  title: 'Project completed',
  body: 'Project accepted automatically on 4 Jul 2026 after the 7-day review window — 5 milestones delivered.',
  readyToInvoice: true,
};

describe('CompletedBanner', () => {
  it('renders the terminal title and body', () => {
    render(<CompletedBanner banner={clientAccepted} />);
    expect(screen.getByText('Project completed')).toBeInTheDocument();
    expect(screen.getByText(/You accepted the project on 4 Jul 2026/)).toBeInTheDocument();
  });

  it('renders the auto-accepted acceptance attribution when supplied', () => {
    render(<CompletedBanner banner={adminAuto} />);
    expect(screen.getByText(/accepted automatically on 4 Jul 2026/)).toBeInTheDocument();
  });

  it('renders the Ready to invoice flag only when readyToInvoice is true', () => {
    render(<CompletedBanner banner={adminAuto} />);
    expect(screen.getByText('Ready to invoice: final installment')).toBeInTheDocument();
  });

  it('omits the invoice flag when readyToInvoice is false', () => {
    render(<CompletedBanner banner={clientAccepted} />);
    expect(screen.queryByText(/Ready to invoice/)).not.toBeInTheDocument();
  });

  it('renders no action buttons (no CTA row, read-only)', () => {
    render(<CompletedBanner banner={adminAuto} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
