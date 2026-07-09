import { describe, it, expect } from 'vitest';

import { render, screen } from '@/test/utils';
import type { CompletedBannerView } from '@/lib/engagement/engagement-view';

import { CompletedBanner } from './completed-banner';

const clientAccepted: CompletedBannerView = {
  title: 'Project completed',
  body: 'You accepted the project on 4 Jul 2026. Balo will be in touch about the final invoice.',
  readyToInvoice: false,
  clientCta: {
    nextProjectHref: '/experts',
    messageHref: '/projects/req-1',
    messagePersonLabel: 'Priya Sharma',
  },
};

const clientRetainer: CompletedBannerView = {
  ...clientAccepted,
  clientCta: { nextProjectHref: '/experts', messageHref: null, messagePersonLabel: 'Priya Sharma' },
};

const adminAuto: CompletedBannerView = {
  title: 'Project completed',
  body: 'Project accepted automatically on 4 Jul 2026 after the 7-day review window — 5 milestones delivered.',
  readyToInvoice: true,
  clientCta: null,
};

describe('CompletedBanner', () => {
  it('renders the terminal title and body', () => {
    render(<CompletedBanner banner={clientAccepted} engagementId="eng-1" />);
    expect(screen.getByText('Project completed')).toBeInTheDocument();
    expect(screen.getByText(/You accepted the project on 4 Jul 2026/)).toBeInTheDocument();
  });

  it('renders the auto-accepted acceptance attribution when supplied', () => {
    render(<CompletedBanner banner={adminAuto} engagementId="eng-1" />);
    expect(screen.getByText(/accepted automatically on 4 Jul 2026/)).toBeInTheDocument();
  });

  it('renders the Ready to invoice flag only when readyToInvoice is true', () => {
    render(<CompletedBanner banner={adminAuto} engagementId="eng-1" />);
    expect(screen.getByText('Ready to invoice: final installment')).toBeInTheDocument();
  });

  it('omits the invoice flag when readyToInvoice is false', () => {
    render(<CompletedBanner banner={clientAccepted} engagementId="eng-1" />);
    expect(screen.queryByText(/Ready to invoice/)).not.toBeInTheDocument();
  });

  it('renders the client next-step CTAs linking to the real destinations', () => {
    render(<CompletedBanner banner={clientAccepted} engagementId="eng-1" />);
    expect(screen.getByRole('link', { name: /Start your next project/i })).toHaveAttribute(
      'href',
      '/experts'
    );
    expect(screen.getByRole('link', { name: /Message Priya Sharma/i })).toHaveAttribute(
      'href',
      '/projects/req-1'
    );
  });

  it('omits the Message CTA for a retainer (no source request)', () => {
    render(<CompletedBanner banner={clientRetainer} engagementId="eng-1" />);
    expect(screen.getByRole('link', { name: /Start your next project/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Message/i })).not.toBeInTheDocument();
  });

  it('renders no CTA row for the admin/expert lens (clientCta null)', () => {
    render(<CompletedBanner banner={adminAuto} engagementId="eng-1" />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
