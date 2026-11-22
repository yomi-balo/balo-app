import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
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
  'This is a time and materials project. Any increase in cost is only charged if Northwind approves it.';

describe('BaloTermsBlock', () => {
  it.each([
    ['fixed', FIXED_RULE],
    ['tm', TM_RULE],
  ] as const)('states the %s pricing rule with the company name', (method, rule) => {
    render(<BaloTermsBlock pricingMethod={method} companyName="Northwind" where="composer" />);
    expect(screen.getByText(rule)).toBeInTheDocument();
  });

  it('frames the composer for the expert and offers no summary toggle', () => {
    render(<BaloTermsBlock pricingMethod="fixed" companyName="Northwind" where="composer" />);
    expect(screen.getByText('Balo Project T&Cs apply')).toBeInTheDocument();
    expect(
      screen.getByText('They cover every project on Balo and can’t be changed for one project.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('frames the proposal for the client and carries the In short toggle', () => {
    render(<BaloTermsBlock pricingMethod="fixed" companyName="Northwind" where="proposal" />);
    expect(screen.getByText('Balo Project T&Cs apply')).toBeInTheDocument();
    expect(screen.getByText('The same terms for every project on Balo.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'In short' })).toBeInTheDocument();
  });

  it('shortens the title and drops the subline in the accept dialog', () => {
    render(<BaloTermsBlock pricingMethod="fixed" companyName="Northwind" where="accept" />);
    expect(screen.getByText('Balo Project T&Cs')).toBeInTheDocument();
    expect(screen.queryByText('Balo Project T&Cs apply')).not.toBeInTheDocument();
    expect(screen.queryByText(/every project on Balo/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('toggles the summary under In short / Hide summary', async () => {
    const user = userEvent.setup();
    render(<BaloTermsBlock pricingMethod="fixed" companyName="Northwind" where="proposal" />);
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

  it.each(['composer', 'proposal', 'accept'] as const)(
    'never renders the precedence or additive sentence (%s)',
    async (where) => {
      const user = userEvent.setup();
      render(<BaloTermsBlock pricingMethod="tm" companyName="Northwind" where={where} />);
      const toggle = screen.queryByRole('button', { name: 'In short' });
      if (toggle !== null) await user.click(toggle);
      expect(screen.queryByText(BALO_TERMS_PRECEDENCE_SENTENCE)).not.toBeInTheDocument();
      expect(screen.queryByText(BALO_TERMS_ADDITIVE_SENTENCE)).not.toBeInTheDocument();
    }
  );

  it('has no axe violations when expanded', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <BaloTermsBlock pricingMethod="fixed" companyName="Northwind" where="proposal" />
    );
    await user.click(screen.getByRole('button', { name: 'In short' }));
    expect(await axe(container)).toHaveNoViolations();
  });
});
