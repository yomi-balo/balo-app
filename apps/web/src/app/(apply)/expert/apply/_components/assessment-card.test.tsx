import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from '@/test/axe';
import { AssessmentCard } from './assessment-card';

vi.mock('motion/react', () => ({
  motion: new Proxy(
    {},
    {
      get:
        () =>
        ({ children, className }: { children?: React.ReactNode; className?: string }) => (
          <div className={className}>{children}</div>
        ),
    }
  ),
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useReducedMotion: () => true,
}));

const DIMENSIONS = [
  { supportTypeId: 'st1', name: 'Technical Fix', slug: 'technical-fix', proficiency: 7 },
  { supportTypeId: 'st2', name: 'Strategy', slug: 'strategy', proficiency: 0 },
];

function renderCard(onChange = vi.fn()): ReturnType<typeof render> {
  return render(
    <AssessmentCard
      productId="p1"
      productName="CPQ"
      dimensions={DIMENSIONS}
      onChange={onChange}
      isComplete={false}
      expanded
      onToggle={vi.fn()}
      onDone={vi.fn()}
      showRatingHint={false}
      registerHeaderButton={vi.fn()}
    />
  );
}

describe('AssessmentCard', () => {
  it('shows one slider per dimension with the title and description beside the value', () => {
    renderCard();
    expect(screen.getAllByRole('slider')).toHaveLength(2);
    expect(screen.getByText('Advanced')).toBeInTheDocument();
    expect(
      screen.getByText(
        'You handle complex work on your own, and teammates come to you for help with it.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText("You haven't worked with this.")).toBeInTheDocument();
  });

  it('names the slider and exposes title and description as its value text', () => {
    renderCard();
    const slider = screen.getByRole('slider', { name: 'Technical Fix proficiency for CPQ' });
    expect(slider).toHaveAttribute(
      'aria-valuetext',
      '7, Advanced: You handle complex work on your own, and teammates come to you for help with it.'
    );
  });

  it('moves up one level with ArrowRight', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderCard(onChange);
    screen.getByRole('slider', { name: 'Technical Fix proficiency for CPQ' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('p1', 'st1', 8);
  });

  it('has no axe violations', async () => {
    const { container } = renderCard();
    expect(await axe(container)).toHaveNoViolations();
  });
});
