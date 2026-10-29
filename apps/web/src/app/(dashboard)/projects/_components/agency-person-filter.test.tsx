import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { AgencyPersonFilter, EVERYONE, type AgencyPerson } from './agency-person-filter';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

function people(n: number): AgencyPerson[] {
  return Array.from({ length: n }, (_, i) => ({
    expertProfileId: `p${String(i).padStart(2, '0')}`,
    label: `Expert ${String.fromCodePoint(65 + (i % 26))}${String(i).padStart(2, '0')}`,
    isViewer: false,
    count: i === 0 ? 0 : 1,
  }));
}

describe('AgencyPersonFilter', () => {
  it('reads Everyone with the total when nobody is picked', () => {
    render(<AgencyPersonFilter people={people(3)} active={EVERYONE} total={7} onPick={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Delivered by: Everyone' })).toHaveTextContent(
      'Delivered byEveryone7'
    );
  });

  it('reads the picked person and their count', () => {
    render(<AgencyPersonFilter people={people(3)} active="p01" total={7} onPick={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: /Delivered by: Expert B01/ })).toBeInTheDocument();
  });

  it('uses a searchable list above 30 people and picks from it', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<AgencyPersonFilter people={people(31)} active={EVERYONE} total={40} onPick={onPick} />);

    await user.click(screen.getByRole('combobox', { name: /delivered by/i }));
    await user.type(screen.getByPlaceholderText('Search experts'), 'Expert B01');
    await user.click(await screen.findByText('Expert B01'));

    expect(onPick).toHaveBeenCalledWith('p01');
  });

  it('can pick Everyone from the searchable list', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<AgencyPersonFilter people={people(31)} active="p01" total={40} onPick={onPick} />);

    await user.click(screen.getByRole('combobox', { name: /delivered by/i }));
    await user.click(await screen.findByText('Everyone'));

    expect(onPick).toHaveBeenCalledWith(EVERYONE);
  });
});
