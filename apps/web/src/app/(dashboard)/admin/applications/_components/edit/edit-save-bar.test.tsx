import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { EditSaveBar } from './edit-save-bar';

describe('EditSaveBar', () => {
  it('shows "No changes yet" and disables Save at zero changes', () => {
    render(
      <EditSaveBar
        changes={[]}
        saving={false}
        live={false}
        firstName="Priya"
        open={false}
        onToggle={vi.fn()}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />
    );
    expect(screen.getByText('No changes yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('pluralises the change count', () => {
    const { rerender } = render(
      <EditSaveBar
        changes={[{ section: 'Experience', text: 'Year started 2018 → 2016' }]}
        saving={false}
        live={false}
        firstName="Priya"
        open={false}
        onToggle={vi.fn()}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /1 change$/ })).toBeInTheDocument();

    rerender(
      <EditSaveBar
        changes={[
          { section: 'Experience', text: 'Year started 2018 → 2016' },
          { section: 'Industries', text: 'Added Healthcare' },
        ]}
        saving={false}
        live={false}
        firstName="Priya"
        open={false}
        onToggle={vi.fn()}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /2 changes$/ })).toBeInTheDocument();
  });

  it('shows the live info line only when live', () => {
    const { rerender } = render(
      <EditSaveBar
        changes={[{ section: 'Experience', text: 'x' }]}
        saving={false}
        live={false}
        firstName="Priya"
        open={false}
        onToggle={vi.fn()}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />
    );
    expect(screen.queryByText(/is live on Balo/)).not.toBeInTheDocument();

    rerender(
      <EditSaveBar
        changes={[{ section: 'Experience', text: 'x' }]}
        saving={false}
        live
        firstName="Priya"
        open={false}
        onToggle={vi.fn()}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />
    );
    expect(screen.getByText(/Priya is live on Balo/)).toBeInTheDocument();
  });

  it('toggles the disclosure and lists changes grouped by section when open', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { rerender } = render(
      <EditSaveBar
        changes={[{ section: 'Experience', text: 'Year started 2018 → 2016' }]}
        saving={false}
        live={false}
        firstName="Priya"
        open={false}
        onToggle={onToggle}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />
    );
    const toggle = screen.getByRole('button', { name: /1 change$/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(
      <EditSaveBar
        changes={[{ section: 'Experience', text: 'Year started 2018 → 2016' }]}
        saving={false}
        live={false}
        firstName="Priya"
        open
        onToggle={onToggle}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />
    );
    expect(screen.getByText('Year started 2018 → 2016')).toBeInTheDocument();
  });

  it('shows the spinner and "Saving…" while saving, and disables both buttons', () => {
    render(
      <EditSaveBar
        changes={[{ section: 'Experience', text: 'x' }]}
        saving
        live={false}
        firstName="Priya"
        open={false}
        onToggle={vi.fn()}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });
});
