import { describe, it, expect } from 'vitest';
import { render, screen } from '../test/utils';
import { Button } from '@repo/ui/button';

describe('Button', () => {
  it('renders with text', () => {
    render(<Button appName="test">Click me</Button>);
    expect(screen.getByRole('button', { name: /click me/i })).toBeInTheDocument();
  });

  it('applies custom className', () => {
    render(
      <Button appName="test" className="custom-class">
        Styled
      </Button>
    );
    expect(screen.getByRole('button')).toHaveClass('custom-class');
  });
});
