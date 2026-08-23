import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { CaseChoiceSection, type CaseChoiceSectionProps } from './case-choice-section';
import type { OpenCaseForExpert } from './types';

function makeCase(overrides: Partial<OpenCaseForExpert> = {}): OpenCaseForExpert {
  return {
    engagementId: 'e-1',
    title: 'Flow interview loop',
    createdAt: '2026-05-01T00:00:00.000Z',
    lastActivityAt: '2026-06-01T00:00:00.000Z',
    consultationCount: 2,
    ...overrides,
  };
}

function renderSection(over: Partial<CaseChoiceSectionProps> = {}) {
  const onSelect = vi.fn();
  const props: CaseChoiceSectionProps = {
    openCases: [],
    selectedEngagementId: null,
    onSelect,
    expertFirstName: 'Amara',
    ...over,
  };
  const utils = render(<CaseChoiceSection {...props} />);
  return { ...utils, onSelect };
}

describe('CaseChoiceSection', () => {
  it('always shows "Start a new case" first, default-selected', () => {
    renderSection({ openCases: [makeCase()] });
    const newCaseRadio = screen.getByRole('radio', { name: /Start a new case/i });
    expect(newCaseRadio).toHaveAttribute('aria-checked', 'true');
  });

  it('renders exactly 2 cards with 1 open case', () => {
    renderSection({ openCases: [makeCase()] });
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('caps display at 4 existing cases + "Show N more"', () => {
    const cases = Array.from({ length: 6 }, (_, i) =>
      makeCase({ engagementId: `e-${i}`, title: `Case ${i}` })
    );
    renderSection({ openCases: cases });
    // 1 (new) + 4 visible existing = 5 radios initially.
    expect(screen.getAllByRole('radio')).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Show 2 more' })).toBeInTheDocument();
  });

  it('expands the rest on "Show N more"', async () => {
    const user = userEvent.setup();
    const cases = Array.from({ length: 6 }, (_, i) =>
      makeCase({ engagementId: `e-${i}`, title: `Case ${i}` })
    );
    renderSection({ openCases: cases });
    await user.click(screen.getByRole('button', { name: 'Show 2 more' }));
    expect(screen.getAllByRole('radio')).toHaveLength(7);
    expect(screen.queryByRole('button', { name: /Show \d+ more/ })).not.toBeInTheDocument();
  });

  it('calls onSelect(null) for the new-case card and onSelect(engagementId) for an existing one', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderSection({ openCases: [makeCase({ engagementId: 'e-9' })] });
    await user.click(screen.getByRole('radio', { name: /Case 9|Flow interview loop/i }));
    expect(onSelect).toHaveBeenCalledWith('e-9');
    await user.click(screen.getByRole('radio', { name: /Start a new case/i }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('marks the matching existing card selected via selectedEngagementId', () => {
    renderSection({ openCases: [makeCase({ engagementId: 'e-5' })], selectedEngagementId: 'e-5' });
    expect(screen.getByRole('radio', { name: /Flow interview loop/i })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('radio', { name: /Start a new case/i })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });
});

// UX-5 (BAL-400 round 2) — the cards are real `role="radio"` in a `role="radiogroup"`, which
// promises the WAI-ARIA APG roving-tabindex + arrow-key pattern. Before this fix, EVERY card
// was independently Tab-focusable and no arrow key did anything — a conformance mismatch
// between the announced role and the actual behavior.
describe('CaseChoiceSection — roving tabindex + arrow-key navigation (UX-5)', () => {
  it('puts ONLY the selected card in the Tab order', () => {
    renderSection({
      openCases: [makeCase({ engagementId: 'e-1' }), makeCase({ engagementId: 'e-2' })],
      selectedEngagementId: 'e-2',
    });
    const radios = screen.getAllByRole('radio');
    for (const radio of radios) {
      expect(radio).toHaveAttribute(
        'tabIndex',
        radio.getAttribute('aria-checked') === 'true' ? '0' : '-1'
      );
    }
  });

  it('ArrowDown moves selection AND focus from "Start a new case" to the next card', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderSection({ openCases: [makeCase({ engagementId: 'e-1' })] });
    const newCaseRadio = screen.getByRole('radio', { name: /Start a new case/i });
    newCaseRadio.focus();
    await user.keyboard('{ArrowDown}');
    expect(onSelect).toHaveBeenCalledWith('e-1');
  });

  it('ArrowUp from the first card wraps to the LAST visible card', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderSection({
      openCases: [makeCase({ engagementId: 'e-1' }), makeCase({ engagementId: 'e-2' })],
    });
    const newCaseRadio = screen.getByRole('radio', { name: /Start a new case/i });
    newCaseRadio.focus();
    await user.keyboard('{ArrowUp}');
    expect(onSelect).toHaveBeenCalledWith('e-2');
  });

  it('ArrowRight/ArrowLeft behave the same as Down/Up', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderSection({ openCases: [makeCase({ engagementId: 'e-1' })] });
    const newCaseRadio = screen.getByRole('radio', { name: /Start a new case/i });
    newCaseRadio.focus();
    await user.keyboard('{ArrowRight}');
    expect(onSelect).toHaveBeenCalledWith('e-1');
  });

  it('End jumps to the last card, Home jumps back to "Start a new case"', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderSection({
      openCases: [
        makeCase({ engagementId: 'e-1', title: 'Case one' }),
        makeCase({ engagementId: 'e-2', title: 'Case two' }),
      ],
      selectedEngagementId: 'e-1',
    });
    screen.getByRole('radio', { name: /Case one/i }).focus();
    await user.keyboard('{End}');
    expect(onSelect).toHaveBeenLastCalledWith('e-2');
    await user.keyboard('{Home}');
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });
});
