import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { RatingRowEdit } from './rating-row';

const SUPPORT_TYPE = { id: 'st1', name: 'Technical Fix', slug: 'technical-fix' };

describe('RatingRowEdit', () => {
  it('calls onChange with the new value when the slider moves', () => {
    const onChange = vi.fn();
    render(
      <RatingRowEdit
        productName="Sales Cloud"
        supportType={SUPPORT_TYPE}
        rating={{ balo: 5, self: 7 }}
        original={5}
        onChange={onChange}
      />
    );

    const [slider] = screen.getAllByRole('slider', {
      name: 'Balo’s Technical Fix rating for Sales Cloud',
    });
    if (slider === undefined) throw new Error('slider not found');
    slider.focus();
    fireEvent.keyDown(slider, { key: 'ArrowRight' });

    expect(onChange).toHaveBeenCalledWith(6);
  });

  it('shows Undo once the value changed, and restores the original on click', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <RatingRowEdit
        productName="Sales Cloud"
        supportType={SUPPORT_TYPE}
        rating={{ balo: 9, self: 7 }}
        original={5}
        onChange={onChange}
      />
    );

    const [undoButton] = screen.getAllByRole('button', {
      name: 'Undo change to Technical Fix for Sales Cloud',
    });
    expect(undoButton).toBeDefined();
    await user.click(undoButton as HTMLElement);

    expect(onChange).toHaveBeenCalledWith(5);
  });

  it('renders no Undo when the value matches the original', () => {
    render(
      <RatingRowEdit
        productName="Sales Cloud"
        supportType={SUPPORT_TYPE}
        rating={{ balo: 5, self: 5 }}
        original={5}
        onChange={vi.fn()}
      />
    );

    expect(
      screen.queryByRole('button', { name: 'Undo change to Technical Fix for Sales Cloud' })
    ).not.toBeInTheDocument();
  });

  it('shows "—" for a null self-rating (a Balo-added product)', () => {
    render(
      <RatingRowEdit
        productName="Flow"
        supportType={SUPPORT_TYPE}
        rating={{ balo: 0, self: null }}
        original={null}
        onChange={vi.fn()}
      />
    );

    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('renders a missing cell read-only as "Not rated" and never calls onChange', () => {
    const onChange = vi.fn();
    render(
      <RatingRowEdit
        productName="Sales Cloud"
        supportType={SUPPORT_TYPE}
        rating={{ balo: 0, self: null, missing: true }}
        original={null}
        onChange={onChange}
      />
    );

    expect(screen.getAllByText('Not rated').length).toBeGreaterThan(0);
    const [slider] = screen.getAllByRole('slider', {
      name: 'Balo’s Technical Fix rating for Sales Cloud',
    });
    if (slider === undefined) throw new Error('slider not found');
    expect(slider).toHaveAttribute('data-disabled');
    slider.focus();
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Undo change to Technical Fix for Sales Cloud' })
    ).not.toBeInTheDocument();
  });
});
