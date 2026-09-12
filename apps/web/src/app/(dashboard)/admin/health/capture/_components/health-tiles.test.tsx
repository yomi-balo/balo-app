import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { HealthTiles } from './health-tiles';

const COUNTS = { recording: 2, transcription: 1, recap: 0, healthy: 5 };

describe('HealthTiles', () => {
  it('renders all four tiles with their counts', () => {
    render(<HealthTiles counts={COUNTS} active={null} windowParams={{}} />);
    expect(screen.getByText('Recording issues')).toBeInTheDocument();
    expect(screen.getByText('Transcription issues')).toBeInTheDocument();
    expect(screen.getByText('Recap issues')).toBeInTheDocument();
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('the active tile carries aria-current="page" and links back to the unfiltered view', () => {
    render(<HealthTiles counts={COUNTS} active="recording" windowParams={{}} />);
    const active = screen.getByTitle('Recording issues');
    expect(active).toHaveAttribute('aria-current', 'page');
    expect(active).toHaveAttribute('href', '?');
  });

  it('an inactive tile links to ?category=<key>, preserving window params', () => {
    render(
      <HealthTiles
        counts={COUNTS}
        active={null}
        windowParams={{ from: '2026-08-01', to: '2026-08-31' }}
      />
    );
    const link = screen.getByTitle('Transcription issues');
    const href = link.getAttribute('href') ?? '';
    expect(href).toContain('category=transcription');
    expect(href).toContain('from=2026-08-01');
    expect(href).toContain('to=2026-08-31');
  });
});
