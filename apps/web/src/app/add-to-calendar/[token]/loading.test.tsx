import { describe, expect, it } from 'vitest';
import { render, screen } from '@/test/utils';
import AddToCalendarLoading from './loading';

describe('AddToCalendarLoading', () => {
  it('announces itself, with aria-busy on the decorative skeleton only', () => {
    const { container } = render(<AddToCalendarLoading />);
    const region = screen.getByRole('status');
    expect(region.tagName).toBe('OUTPUT');
    expect(region).toHaveTextContent('Loading your calendar options');
    expect(region.getAttribute('aria-busy')).toBeNull();
    expect(container.querySelector('div[aria-busy="true"]')).not.toBeNull();
  });
});
