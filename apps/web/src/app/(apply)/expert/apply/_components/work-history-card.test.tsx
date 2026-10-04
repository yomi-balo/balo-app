import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

import { WorkHistoryCard } from './work-history-card';

const ENTRY = {
  role: 'Senior Consultant',
  company: 'Acme Corp',
  startedAt: '2020-01-01',
  endedAt: '2023-06-01',
  isCurrent: false,
};

function renderCard(responsibilities?: string): ReturnType<typeof render> {
  return render(
    <WorkHistoryCard entry={{ ...ENTRY, responsibilities }} onEdit={vi.fn()} onDelete={vi.fn()} />
  );
}

describe('WorkHistoryCard — responsibilities preview', () => {
  it('previews rich text as its visible words, never as markup', () => {
    const { container } = renderCard('<ul><li><strong>Led</strong> delivery</li></ul>');
    expect(screen.getByText('Led delivery')).toBeInTheDocument();
    expect(container.textContent).not.toContain('<');
  });

  it('previews a legacy plain-text entry as written', () => {
    renderCard('Led delivery for 25 clients');
    expect(screen.getByText('Led delivery for 25 clients')).toBeInTheDocument();
  });

  it("renders no preview for the editor's empty document", () => {
    const { container } = renderCard('<p></p>');
    expect(container.querySelector('.line-clamp-2')).toBeNull();
  });
});
