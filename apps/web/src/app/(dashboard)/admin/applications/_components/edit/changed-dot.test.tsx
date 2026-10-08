import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { ChangedDot } from './changed-dot';

/**
 * The dot is decorative (`aria-hidden`); a visually-hidden label carries its meaning, so it is
 * still announced without claiming image semantics.
 */
describe('ChangedDot', () => {
  it('reads to assistive tech via a visually-hidden label, and hides the dot from it', () => {
    const { container } = render(<ChangedDot />);
    expect(screen.getByText('Changed in this edit')).toHaveClass('sr-only');
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });
});
