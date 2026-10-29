import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@/test/utils';
import { axe } from '@/test/axe';

const { mockRefresh, mockSetIndustry, mockSetHidden, mockToastSuccess, mockToastError } =
  vi.hoisted(() => ({
    mockRefresh: vi.fn(),
    mockSetIndustry: vi.fn(),
    mockSetHidden: vi.fn(),
    mockToastSuccess: vi.fn(),
    mockToastError: vi.fn(),
  }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));
vi.mock('../_actions/set-company-industry', () => ({
  setCompanyIndustryAction: (...a: unknown[]) => mockSetIndustry(...a),
}));
vi.mock('../_actions/set-company-review-name-hidden', () => ({
  setCompanyReviewNameHiddenAction: (...a: unknown[]) => mockSetHidden(...a),
}));
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => mockToastSuccess(...a),
    error: (...a: unknown[]) => mockToastError(...a),
  },
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { CompanyDetailsWorkspace } from './company-details-workspace';
import type { CompanyDetailsDto, IndustryOptionDto } from '../_lib/company-details-types';

const COMPANY: CompanyDetailsDto = {
  id: 'co-1',
  name: 'Acme',
  isPersonal: false,
  industryId: 'ind-1',
  industryName: 'Logistics',
  industryIsActive: true,
  reviewNameHiddenAt: null,
};
const INDUSTRIES: IndustryOptionDto[] = [
  { id: 'ind-1', name: 'Logistics' },
  { id: 'ind-2', name: 'Retail' },
];

beforeEach(() => vi.clearAllMocks());

describe('CompanyDetailsWorkspace', () => {
  it('renders the header, back link, current industry and an on switch for a manager', () => {
    render(<CompanyDetailsWorkspace company={COMPANY} industries={INDUSTRIES} canManage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Acme details' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to lookup/i })).toHaveAttribute(
      'href',
      '/admin/lookup'
    );
    expect(screen.getByRole('combobox', { name: 'Industry' })).toHaveTextContent('Logistics');
    expect(screen.getByRole('switch', { name: /show this company/i })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Clear industry' })).toBeEnabled();
    expect(
      screen.queryByText(/needs the Edit company details permission/i)
    ).not.toBeInTheDocument();
  });

  it('shows the switch off when the name is hidden', () => {
    render(
      <CompanyDetailsWorkspace
        company={{ ...COMPANY, reviewNameHiddenAt: '2026-10-03T08:00:00.000Z' }}
        industries={INDUSTRIES}
        canManage
      />
    );
    expect(screen.getByRole('switch', { name: /show this company/i })).not.toBeChecked();
  });

  it('disables every control and explains why without the capability', () => {
    render(<CompanyDetailsWorkspace company={COMPANY} industries={INDUSTRIES} canManage={false} />);

    expect(screen.getByRole('combobox', { name: 'Industry' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear industry' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: /show this company/i })).toBeDisabled();
    expect(screen.getByText(/needs the Edit company details permission/i)).toBeInTheDocument();
  });

  it('disables the switch and explains it for a personal workspace, leaving industry editable', () => {
    render(
      <CompanyDetailsWorkspace
        company={{ ...COMPANY, isPersonal: true }}
        industries={INDUSTRIES}
        canManage
      />
    );

    expect(screen.getByRole('switch', { name: /show this company/i })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Industry' })).toBeEnabled();
    expect(screen.getByText(/personal workspace, so its name never appears/i)).toBeInTheDocument();
  });

  it('shows no Clear button when no industry is set', () => {
    render(
      <CompanyDetailsWorkspace
        company={{ ...COMPANY, industryId: null, industryName: null, industryIsActive: null }}
        industries={INDUSTRIES}
        canManage
      />
    );
    expect(screen.queryByRole('button', { name: 'Clear industry' })).not.toBeInTheDocument();
  });

  it('shows the industry error state, with a retry that refreshes', () => {
    render(<CompanyDetailsWorkspace company={COMPANY} industries={null} canManage />);

    expect(screen.getByText(/couldn't load the industries/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('switch', { name: /show this company/i })).toBeEnabled();
  });

  it('clears the industry, toasts the message and refreshes', async () => {
    mockSetIndustry.mockResolvedValue({ success: true, message: "Acme's industry was cleared." });
    render(<CompanyDetailsWorkspace company={COMPANY} industries={INDUSTRIES} canManage />);

    fireEvent.click(screen.getByRole('button', { name: 'Clear industry' }));

    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith("Acme's industry was cleared.")
    );
    expect(mockSetIndustry).toHaveBeenCalledWith({ companyId: 'co-1', industryId: null });
    expect(mockRefresh).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Clear industry' })).not.toBeInTheDocument()
    );
  });

  it('turns the name off through the action and toasts', async () => {
    mockSetHidden.mockResolvedValue({ success: true, message: 'Done.' });
    render(<CompanyDetailsWorkspace company={COMPANY} industries={INDUSTRIES} canManage />);

    fireEvent.click(screen.getByRole('switch', { name: /show this company/i }));

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Done.'));
    expect(mockSetHidden).toHaveBeenCalledWith({ companyId: 'co-1', hidden: true });
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: /show this company/i })).not.toBeChecked()
    );
  });

  it('toasts the error and keeps the switch where it was on a failed save', async () => {
    mockSetHidden.mockResolvedValue({ success: false, error: 'Nope.', code: 'denied' });
    mockRefresh.mockClear();
    render(<CompanyDetailsWorkspace company={COMPANY} industries={INDUSTRIES} canManage />);

    fireEvent.click(screen.getByRole('switch', { name: /show this company/i }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Nope.'));
    expect(mockRefresh).toHaveBeenCalled();
    expect(screen.getByRole('switch', { name: /show this company/i })).toBeChecked();
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: /show this company/i })).toBeEnabled()
    );
  });

  it('toasts a generic error when the action throws, and re-enables the control', async () => {
    mockSetHidden.mockRejectedValue(new Error('network'));
    render(<CompanyDetailsWorkspace company={COMPANY} industries={INDUSTRIES} canManage />);

    fireEvent.click(screen.getByRole('switch', { name: /show this company/i }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        'Something went wrong. Check the details before trying again.'
      )
    );
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: /show this company/i })).toBeEnabled()
    );
  });

  it('moves the Switch and the Select when new company props arrive', () => {
    const { rerender } = render(
      <CompanyDetailsWorkspace company={COMPANY} industries={INDUSTRIES} canManage />
    );

    rerender(
      <CompanyDetailsWorkspace
        company={{
          ...COMPANY,
          industryId: 'ind-2',
          industryName: 'Retail',
          reviewNameHiddenAt: '2026-10-03T08:00:00.000Z',
        }}
        industries={INDUSTRIES}
        canManage
      />
    );

    expect(screen.getByRole('combobox', { name: 'Industry' })).toHaveTextContent('Retail');
    expect(screen.getByRole('switch', { name: /show this company/i })).not.toBeChecked();
  });

  it('lists a retired current industry as a disabled "(retired)" option', async () => {
    render(
      <CompanyDetailsWorkspace
        company={{
          ...COMPANY,
          industryId: 'ind-old',
          industryName: 'Telegraphs',
          industryIsActive: false,
        }}
        industries={INDUSTRIES}
        canManage
      />
    );

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Industry' }), { key: 'ArrowDown' });

    const option = await screen.findByRole('option', { name: 'Telegraphs (retired)' });
    expect(option).toHaveAttribute('aria-disabled', 'true');
  });

  it('wires the helper text to the controls and labels Clear', () => {
    render(<CompanyDetailsWorkspace company={COMPANY} industries={INDUSTRIES} canManage />);

    expect(screen.getByRole('combobox', { name: 'Industry' })).toHaveAccessibleDescription(
      /shown on a review/i
    );
    expect(screen.getByRole('switch', { name: /show this company/i })).toHaveAccessibleDescription(
      /will appear with it again/i
    );
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <CompanyDetailsWorkspace company={COMPANY} industries={INDUSTRIES} canManage />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
