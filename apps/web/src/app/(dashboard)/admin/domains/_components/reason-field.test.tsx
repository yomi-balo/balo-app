import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@/test/utils';
import { axe } from 'jest-axe';
import { ReasonField } from './reason-field';

describe('ReasonField', () => {
  it('labels the textarea, describes it with the hint, and reports changes', () => {
    const onChange = vi.fn();
    render(<ReasonField id="r" value="" onChange={onChange} error={null} />);

    const box = screen.getByLabelText('Reason');
    expect(box).toHaveAttribute('aria-describedby', 'r-hint');
    expect(box).toHaveAttribute('aria-invalid', 'false');
    expect(box).toHaveAttribute('aria-required', 'true');
    expect(screen.getByText(/customers never see it/i)).toHaveAttribute('id', 'r-hint');

    fireEvent.change(box, { target: { value: 'Asked by CFO' } });
    expect(onChange).toHaveBeenCalledWith('Asked by CFO');
  });

  it('wires the error into aria-describedby and announces it', () => {
    render(<ReasonField id="r" value="" onChange={vi.fn()} error="Add a reason." />);

    const box = screen.getByLabelText('Reason');
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(box).toHaveAttribute('aria-describedby', 'r-hint r-error');
    expect(screen.getByRole('alert')).toHaveTextContent('Add a reason.');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<ReasonField id="r" value="x" onChange={vi.fn()} error="bad" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
