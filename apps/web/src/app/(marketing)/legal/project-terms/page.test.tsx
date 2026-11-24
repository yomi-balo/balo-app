import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@/test/utils';

const mockVersions = vi.hoisted(() => ({
  list: [{ version: '2025-07-23', sha256: 'a' }] as { version: string; sha256: string }[],
}));

vi.mock('@/lib/legal/project-terms-versions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/legal/project-terms-versions')>();
  return {
    ...actual,
    get PROJECT_TERMS_VERSIONS() {
      return mockVersions.list;
    },
    projectTermsPdfHref: (version: string) =>
      mockVersions.list.some((entry) => entry.version === version)
        ? `/legal/${actual.projectTermsPdfFileName(version)}`
        : null,
  };
});

import ProjectTermsPage, { metadata } from './page';

describe('ProjectTermsPage', () => {
  it('titles the page with the agreement name', () => {
    render(<ProjectTermsPage />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Balo Projects - Master Services Agreement' })
    ).toBeInTheDocument();
    expect(metadata.title).toBe('Balo Projects - Master Services Agreement — Balo');
  });

  it('links the current version PDF for download', () => {
    render(<ProjectTermsPage />);
    expect(screen.getByRole('link', { name: 'Download PDF' })).toHaveAttribute(
      'href',
      '/legal/balo-projects-msa-2025-07-23.pdf'
    );
  });

  it('hides "Earlier versions" while only the current version exists', () => {
    mockVersions.list = [{ version: '2025-07-23', sha256: 'a' }];
    render(<ProjectTermsPage />);
    expect(screen.queryByRole('heading', { name: 'Earlier versions' })).not.toBeInTheDocument();
  });

  it('lists only the older versions, newest first, once there is more than one', () => {
    mockVersions.list = [
      { version: '2024-01-05', sha256: 'o' },
      { version: '2024-09-01', sha256: 'p' },
      { version: '2025-07-23', sha256: 'a' },
    ];
    render(<ProjectTermsPage />);
    expect(screen.getByRole('heading', { level: 2, name: 'Earlier versions' })).toBeInTheDocument();
    const links = screen
      .getAllByRole('link')
      .filter((link) => link.textContent?.startsWith('Agreement dated'));
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/legal/balo-projects-msa-2024-09-01.pdf',
      '/legal/balo-projects-msa-2024-01-05.pdf',
    ]);
    expect(links[0]).toHaveTextContent('Agreement dated 1 September 2024 (PDF)');
  });
});
