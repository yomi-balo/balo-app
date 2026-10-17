import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SupportBlock } from './support-block';

describe('SupportBlock', () => {
  it('offers a mailto link to support', () => {
    render(<SupportBlock />);

    expect(screen.getByRole('heading', { name: 'Still stuck?' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Email support' })).toHaveAttribute(
      'href',
      'mailto:support@getbalo.com'
    );
  });
});
