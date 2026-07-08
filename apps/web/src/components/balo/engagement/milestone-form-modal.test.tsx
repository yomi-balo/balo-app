import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

import { MilestoneFormModal, type MilestoneFormInitial } from './milestone-form-modal';

function renderModal(props: Partial<React.ComponentProps<typeof MilestoneFormModal>> = {}): {
  onConfirm: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
} {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <MilestoneFormModal
      open
      mode="add"
      initial={null}
      clientCompanyName="Northwind Industrial"
      pending={false}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />
  );
  return { onConfirm, onCancel };
}

describe('MilestoneFormModal', () => {
  it('renders the add-mode title and CTA', () => {
    renderModal({ mode: 'add' });
    expect(screen.getByRole('heading', { name: /add milestone/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add milestone/i })).toBeInTheDocument();
  });

  it('renders the edit-mode title, CTA, and prefilled fields', () => {
    const initial: MilestoneFormInitial = {
      title: 'Data migration dry-run',
      descriptionText: 'Trial the migration end to end.',
      acceptanceCriteria: 'Zero row-count drift.',
    };
    renderModal({ mode: 'edit', initial });
    expect(screen.getByRole('heading', { name: /edit milestone/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('Data migration dry-run');
    expect(screen.getByLabelText('Description (optional)')).toHaveValue(
      'Trial the migration end to end.'
    );
    expect(screen.getByLabelText(/Done when/i)).toHaveValue('Zero row-count drift.');
  });

  it('shows the price-lock notice', () => {
    renderModal();
    expect(screen.getByText(/is notified of plan changes/i)).toBeInTheDocument();
    expect(screen.getByText(/pricing changes go through a new proposal/i)).toBeInTheDocument();
  });

  it('disables the CTA until the title is non-empty', async () => {
    const user = userEvent.setup();
    renderModal({ mode: 'add' });
    const cta = screen.getByRole('button', { name: /add milestone/i });
    expect(cta).toBeDisabled();
    await user.type(screen.getByLabelText('Title'), 'Discovery');
    expect(cta).toBeEnabled();
  });

  it('passes the typed values to onConfirm', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderModal({ mode: 'add' });
    await user.type(screen.getByLabelText('Title'), 'Discovery');
    await user.type(screen.getByLabelText('Description (optional)'), 'Workshops.');
    await user.type(screen.getByLabelText(/Done when/i), 'Signed off.');
    await user.click(screen.getByRole('button', { name: /add milestone/i }));
    expect(onConfirm).toHaveBeenCalledWith({
      title: 'Discovery',
      descriptionText: 'Workshops.',
      acceptanceCriteria: 'Signed off.',
    });
  });

  it('disables the fields and CTA and shows a spinner while pending', () => {
    renderModal({
      mode: 'edit',
      initial: { title: 'X', descriptionText: null, acceptanceCriteria: null },
      pending: true,
    });
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
    expect(screen.getByLabelText('Title')).toBeDisabled();
    expect(document.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { baseElement } = render(
      <MilestoneFormModal
        open
        mode="add"
        initial={null}
        clientCompanyName="Northwind Industrial"
        pending={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(await axe(baseElement)).toHaveNoViolations();
  });
});
