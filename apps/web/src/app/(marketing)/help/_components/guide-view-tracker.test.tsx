import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { track, HELP_EVENTS } from '@/lib/analytics';
import { GuideViewTracker } from './guide-view-tracker';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GuideViewTracker', () => {
  it('tracks the guide view once with the side and source', () => {
    const { rerender, container } = render(
      <GuideViewTracker slug="booking" audience="client" source="index" />
    );
    rerender(<GuideViewTracker slug="booking" audience="client" source="index" />);

    expect(container).toBeEmptyDOMElement();
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(HELP_EVENTS.ARTICLE_VIEWED, {
      slug: 'booking',
      audience: 'client',
      source: 'index',
    });
  });

  it('tracks again when the slug changes', () => {
    const { rerender } = render(<GuideViewTracker slug="a" audience="client" source="related" />);
    rerender(<GuideViewTracker slug="b" audience="client" source="related" />);

    expect(track).toHaveBeenCalledTimes(2);
  });
});
