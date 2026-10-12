import { describe, expect, it } from 'vitest';
import { render, screen } from '@/test/utils';
import { ExpertTermsDocument } from './expert-terms-document';

describe('ExpertTermsDocument', () => {
  it('renders one level-3 heading per section, numbered in order', () => {
    render(<ExpertTermsDocument />);
    const headings = screen.getAllByRole('heading', { level: 3 });
    expect(headings).toHaveLength(25);
    expect(headings[0]).toHaveTextContent('1. Acceptance of these Terms');
    expect(headings[11]).toHaveTextContent('12. Recording, Transcription and AI');
  });

  it('shows the last updated date', () => {
    render(<ExpertTermsDocument />);
    expect(screen.getByText('Last updated 12 October 2026')).toBeInTheDocument();
  });

  it('resolves clause references to the clause number', () => {
    render(<ExpertTermsDocument />);
    const [clause316] = screen
      .getAllByText('3.16')
      .map((label) => label.closest('li'))
      .filter((item) => item !== null);
    expect(clause316).toHaveTextContent('prohibited by clause 3.15');
  });

  it('nests sub-clauses inside their parent clause', () => {
    render(<ExpertTermsDocument />);
    const [label] = screen.getAllByText('3.7.1');
    const nested = label?.closest('li');
    const parent = nested?.parentElement?.closest('li');
    expect(parent).not.toBeNull();
    expect(parent?.firstElementChild?.textContent).toBe('3.7');
  });

  it('renders a trailing paragraph after the sub-clauses', () => {
    render(<ExpertTermsDocument />);
    const after = screen.getByText(/In absence of the provision of this/);
    expect(after.tagName).toBe('P');
    expect(after.previousElementSibling?.tagName).toBe('OL');
  });

  it('does not turn sections into landmarks', () => {
    render(<ExpertTermsDocument />);
    expect(screen.queryAllByRole('region')).toHaveLength(0);
  });
});
