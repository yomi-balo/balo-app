import { describe, expect, it } from 'vitest';
import { render } from '@/test/utils';
import { CaseClosedGlyph } from './case-closed-glyph';

describe('CaseClosedGlyph', () => {
  it('renders as decorative (aria-hidden), never announced on its own', () => {
    const { container } = render(<CaseClosedGlyph />);
    const glyph = container.firstElementChild;
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
  });

  it('forwards the caller-supplied sizing classes', () => {
    const { container } = render(<CaseClosedGlyph className="h-7 w-7" />);
    const classAttr = container.firstElementChild?.getAttribute('class');
    expect(classAttr).toMatch(/h-7/);
    expect(classAttr).toMatch(/w-7/);
  });

  it('renders with no className without throwing', () => {
    const { container } = render(<CaseClosedGlyph />);
    expect(container.firstElementChild).not.toBeNull();
  });
});
