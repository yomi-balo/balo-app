import { beforeAll, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { CaseChoiceSection, type CaseChoiceSectionProps } from './case-choice-section';
import type { OpenCaseForExpert } from './types';

// Radix Select drives the open/select interaction through Pointer Capture APIs jsdom doesn't
// implement — stub them so the listbox can open (established pattern, `company-picker.test.tsx`).
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn();
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

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

const TEN_CASES = Array.from({ length: 10 }, (_, i) =>
  makeCase({ engagementId: `e-${i + 1}`, title: `Case ${i + 1}` })
);

describe('CaseChoiceSection', () => {
  it('is one labelled dropdown showing "Start a new case" when nothing is selected', () => {
    renderSection({ openCases: [makeCase()] });
    const trigger = screen.getByRole('combobox', { name: 'Which case is this for?' });
    expect(trigger).toHaveTextContent('Start a new case');
    expect(trigger).toHaveTextContent('For a new issue with Amara.');
  });

  it('shows the selected case in full in the closed dropdown', () => {
    renderSection({ openCases: [makeCase()], selectedEngagementId: 'e-1' });
    const trigger = screen.getByRole('combobox', { name: 'Which case is this for?' });
    expect(trigger).toHaveTextContent('Flow interview loop');
    expect(trigger).toHaveTextContent('2 consultations');
    expect(trigger).not.toHaveTextContent('Start a new case');
  });

  it('stays one control however many cases are open — nothing listed until it is opened', () => {
    renderSection({ openCases: TEN_CASES });
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
    expect(screen.queryByText('Case 7')).not.toBeInTheDocument();
  });

  it('lists "Start a new case" first, then every open case', async () => {
    const user = userEvent.setup();
    renderSection({ openCases: TEN_CASES });
    await user.click(screen.getByRole('combobox'));
    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(11);
    expect(options[0]).toHaveTextContent('Start a new case');
    expect(options[10]).toHaveTextContent('Case 10');
  });

  it('calls onSelect(engagementId) for an existing case', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderSection({ openCases: TEN_CASES });
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: /Case 3/ }));
    expect(onSelect).toHaveBeenCalledWith('e-3');
  });

  it('calls onSelect(null) for "Start a new case"', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderSection({ openCases: TEN_CASES, selectedEngagementId: 'e-2' });
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: /Start a new case/ }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});
