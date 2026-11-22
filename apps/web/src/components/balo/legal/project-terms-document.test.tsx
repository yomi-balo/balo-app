import { describe, expect, it } from 'vitest';
import { render, screen } from '@/test/utils';
import { ProjectTermsDocument } from './project-terms-document';

describe('ProjectTermsDocument', () => {
  it('renders one level-2 heading per section, numbered in order', () => {
    render(<ProjectTermsDocument />);
    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings).toHaveLength(19);
    expect(headings[0]).toHaveTextContent('1. Definitions and Interpretation');
  });

  it('renders the last-updated line as emphasis without its markers', () => {
    render(<ProjectTermsDocument />);
    const line = screen.getByText('Last Updated: 23rd July 2025');
    expect(line.tagName).toBe('EM');
  });

  it('renders bold markers in the text as strong', () => {
    render(<ProjectTermsDocument />);
    const [balo] = screen.getAllByText('Balo Technologies');
    expect(balo?.tagName).toBe('STRONG');
  });
});
