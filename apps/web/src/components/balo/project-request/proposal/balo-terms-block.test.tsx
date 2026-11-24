import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import { axe } from '@/test/axe';
import { BaloTermsBlock } from './balo-terms-block';
import {
  BALO_TERMS_ADDITIVE_SENTENCE,
  BALO_TERMS_PRECEDENCE_SENTENCE,
  STANDARD_TERMS,
} from './proposal-standard-terms';

const FIXED_RULE =
  'This is a fixed-price project. Any increase in cost is only charged if Northwind approves it.';
const TM_RULE =
  "This is a time and materials project. Northwind is billed for the hours logged each billing period. If a milestone goes over its estimate, Northwind is told, and raising an estimate needs Northwind's approval.";

describe('BaloTermsBlock', () => {
  it.each([
    ['fixed', FIXED_RULE],
    ['tm', TM_RULE],
  ] as const)('states the %s pricing rule with the company name', (method, rule) => {
    render(
      <BaloTermsBlock
        pricingMethod={method}
        companyName="Northwind"
        where="composer"
        lens="expert"
      />
    );
    expect(screen.getByText(rule)).toBeInTheDocument();
  });

  it('frames the composer for the expert and offers no summary toggle', () => {
    render(
      <BaloTermsBlock
        pricingMethod="fixed"
        companyName="Northwind"
        where="composer"
        lens="expert"
      />
    );
    expect(screen.getByText('Balo Project T&Cs apply')).toBeInTheDocument();
    expect(
      screen.getByText('They cover every project on Balo and can’t be changed for one project.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('frames the proposal for the client and carries the In short toggle', () => {
    render(
      <BaloTermsBlock
        pricingMethod="fixed"
        companyName="Northwind"
        where="proposal"
        lens="client"
      />
    );
    expect(screen.getByText('Balo Project T&Cs apply')).toBeInTheDocument();
    expect(screen.getByText('The same terms for every project on Balo.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'In short' })).toBeInTheDocument();
  });

  it('shortens the title and drops the subline in the accept dialog', () => {
    render(
      <BaloTermsBlock pricingMethod="fixed" companyName="Northwind" where="accept" lens="client" />
    );
    expect(screen.getByText('Balo Project T&Cs')).toBeInTheDocument();
    expect(screen.queryByText('Balo Project T&Cs apply')).not.toBeInTheDocument();
    expect(screen.queryByText(/every project on Balo/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('toggles the summary under In short / Hide summary', async () => {
    const user = userEvent.setup();
    render(
      <BaloTermsBlock
        pricingMethod="fixed"
        companyName="Northwind"
        where="proposal"
        lens="client"
      />
    );
    const toggle = screen.getByRole('button', { name: 'In short' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveClass('min-h-11');
    for (const term of STANDARD_TERMS) {
      expect(screen.queryByText(term)).not.toBeInTheDocument();
    }

    await user.click(toggle);
    const hide = screen.getByRole('button', { name: 'Hide summary' });
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    for (const term of STANDARD_TERMS) {
      expect(screen.getByText(term)).toBeInTheDocument();
    }

    await user.click(hide);
    expect(screen.getByRole('button', { name: 'In short' })).toBeInTheDocument();
    expect(screen.queryByText(STANDARD_TERMS[0] ?? '')).not.toBeInTheDocument();
  });

  it.each(['composer', 'proposal', 'shared', 'accept', 'delivery'] as const)(
    'never renders the precedence or additive sentence (%s)',
    async (where) => {
      const user = userEvent.setup();
      render(
        <BaloTermsBlock pricingMethod="tm" companyName="Northwind" where={where} lens="client" />
      );
      const toggle = screen.queryByRole('button', { name: 'In short' });
      if (toggle !== null) await user.click(toggle);
      expect(screen.queryByText(BALO_TERMS_PRECEDENCE_SENTENCE)).not.toBeInTheDocument();
      expect(screen.queryByText(BALO_TERMS_ADDITIVE_SENTENCE)).not.toBeInTheDocument();
    }
  );

  it('has no axe violations when expanded', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <BaloTermsBlock
        pricingMethod="fixed"
        companyName="Northwind"
        where="proposal"
        lens="client"
      />
    );
    await user.click(screen.getByRole('button', { name: 'In short' }));
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each([
    ['composer', 'expert', 'composer'],
    ['proposal', 'client', 'proposal'],
    ['shared', 'anonymous', 'shared'],
    ['accept', 'client', 'accept_dialog'],
    ['delivery', 'admin', 'delivery'],
  ] as const)(
    'links the terms page on the %s surface and tracks the open',
    async (where, lens, surface) => {
      const user = userEvent.setup();
      vi.mocked(track).mockClear();
      render(
        <BaloTermsBlock pricingMethod="fixed" companyName="Northwind" where={where} lens={lens} />
      );
      const link = screen.getByRole('link', { name: /Read the Project T&Cs/ });
      expect(link).toHaveAttribute('href', '/legal/project-terms');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link).toHaveClass('min-h-11');
      expect(link).toHaveTextContent('(opens in a new tab)');

      await user.click(link);
      expect(track).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_TERMS_OPENED, { surface, lens });
    }
  );

  it.each([
    ['proposal', 'proposal'],
    ['shared', 'shared'],
    ['delivery', 'delivery'],
  ] as const)('replaces the page link with the accepted PDF on %s', async (where, surface) => {
    const user = userEvent.setup();
    vi.mocked(track).mockClear();
    render(
      <BaloTermsBlock
        pricingMethod="fixed"
        companyName="Northwind"
        where={where}
        lens="client"
        acceptance={{ termsVersion: '2025-07-23' }}
      />
    );
    const link = screen.getByRole('link', { name: /Agreement dated 23 July 2025 \(PDF\)/ });
    expect(link).toHaveAttribute('href', '/legal/balo-projects-msa-2025-07-23.pdf');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.queryByRole('link', { name: /Read the Project T&Cs/ })).not.toBeInTheDocument();

    await user.click(link);
    expect(track).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_TERMS_PDF_DOWNLOADED, {
      version: '2025-07-23',
      surface,
    });
  });

  it.each([
    ['null version', null],
    ['unlisted version', '1999-01-01'],
  ])('keeps the page link when acceptance has a %s', (_label, termsVersion) => {
    render(
      <BaloTermsBlock
        pricingMethod="fixed"
        companyName="Northwind"
        where="proposal"
        lens="client"
        acceptance={{ termsVersion }}
      />
    );
    expect(screen.getByRole('link', { name: /Read the Project T&Cs/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Agreement dated/ })).not.toBeInTheDocument();
  });

  it('keeps the page link on the accept dialog even with an accepted version', () => {
    render(
      <BaloTermsBlock
        pricingMethod="fixed"
        companyName="Northwind"
        where="accept"
        lens="client"
        acceptance={{ termsVersion: '2025-07-23' }}
      />
    );
    expect(screen.getByRole('link', { name: /Read the Project T&Cs/ })).toBeInTheDocument();
  });
});
