import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GuideRows } from './guide-rows';

describe('GuideRows', () => {
  it('renders a linked row per guide using hrefFor', () => {
    render(
      <GuideRows
        items={[
          { slug: 'a', title: 'Guide A', summary: 'About A', audience: ['client'] },
          { slug: 'b', title: 'Guide B', summary: 'About B', audience: ['expert'] },
        ]}
        hrefFor={(slug) => `/help/${slug}?src=x`}
      />
    );

    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('link', { name: /Guide A/ })).toHaveAttribute('href', '/help/a?src=x');
    expect(screen.getByText('About B')).toBeInTheDocument();
  });
});
