import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';

import { OverEstimateBanner } from './over-estimate-banner';

describe('OverEstimateBanner', () => {
  it('states the headline and the explanation in a status region', () => {
    render(
      <OverEstimateBanner
        banner={{
          title: 'Discovery workshop has gone over estimate.',
          body: 'If the scope has grown, CloudPeak can propose a change.',
        }}
      />
    );
    const region = screen.getByRole('status');
    expect(region).toHaveTextContent('Discovery workshop has gone over estimate.');
    expect(region).toHaveTextContent('CloudPeak can propose a change.');
    expect(region).toHaveClass('bg-warning/10');
  });
});
