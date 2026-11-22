import { describe, expect, it } from 'vitest';
import { render, screen } from '@/test/utils';
import type { TermsSection } from '@/lib/legal/terms';
import { TermsDocument } from './terms-document';

const SECTIONS: readonly TermsSection[] = [
  {
    id: 'one',
    title: 'First',
    intro: ['An intro with **bold words** inside.'],
    clauses: [
      { id: 'a', text: 'Clause *softly* stressed, see clause {{clause:b}}.' },
      { id: 'b', text: 'Second.' },
    ],
  },
  { id: 'two', title: 'Second', clauses: [{ text: 'Only clause.' }] },
];

describe('TermsDocument', () => {
  it('renders bold markers as strong and italic markers as em', () => {
    const { container } = render(
      <TermsDocument sections={SECTIONS} dateLine="*Updated today*" sectionHeadingLevel="h2" />
    );
    expect(screen.getByText('bold words').tagName).toBe('STRONG');
    expect(screen.getByText('softly').tagName).toBe('EM');
    expect(screen.getByText('Updated today').tagName).toBe('EM');
    expect(container.textContent).not.toContain('*');
  });

  it('resolves clause references to their numbers', () => {
    render(<TermsDocument sections={SECTIONS} dateLine="d" sectionHeadingLevel="h2" />);
    expect(screen.getByText(/see clause 1\.2\./)).toBeInTheDocument();
  });

  it('renders the intro before the first clause', () => {
    const { container } = render(
      <TermsDocument sections={SECTIONS} dateLine="d" sectionHeadingLevel="h2" />
    );
    const intro = screen.getByText('bold words').closest('p');
    const firstItem = container.querySelector('li');
    expect(intro).not.toBeNull();
    expect(firstItem).not.toBeNull();
    const position = (intro as Node).compareDocumentPosition(firstItem as Node);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('numbers headings and follows the heading level prop', () => {
    const { rerender } = render(
      <TermsDocument sections={SECTIONS} dateLine="d" sectionHeadingLevel="h2" />
    );
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(2);
    expect(screen.getByRole('heading', { name: '1. First' })).toBeInTheDocument();
    rerender(<TermsDocument sections={SECTIONS} dateLine="d" sectionHeadingLevel="h3" />);
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(2);
    expect(screen.queryAllByRole('heading', { level: 2 })).toHaveLength(0);
  });

  it('renders the preamble above the sections', () => {
    render(
      <TermsDocument
        sections={SECTIONS}
        preamble={['A preamble paragraph.']}
        dateLine="d"
        sectionHeadingLevel="h2"
      />
    );
    expect(screen.getByText('A preamble paragraph.')).toBeInTheDocument();
  });
});
