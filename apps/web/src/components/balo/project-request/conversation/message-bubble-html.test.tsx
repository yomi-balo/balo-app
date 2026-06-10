import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { MessageBubbleHtml } from './message-bubble-html';

describe('MessageBubbleHtml', () => {
  it('renders ingest-sanitised paragraph/br HTML', () => {
    render(<MessageBubbleHtml html="<p>first line<br />second line</p><p>new para</p>" />);
    expect(screen.getByText(/first line/)).toBeInTheDocument();
    expect(screen.getByText('new para')).toBeInTheDocument();
  });

  it('renders escaped entities as text — no live markup from message bodies', () => {
    // NB: a JS string, not a JSX attribute literal (JSX decodes entities).
    const { container } = render(
      <MessageBubbleHtml html={'<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'} />
    );
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
  });
});
