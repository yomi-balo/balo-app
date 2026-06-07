import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import type { ApplicationCompetencyWithRelations } from '@balo/db';
import { ExpertiseTab } from './expertise-tab';

// ── Fixtures ─────────────────────────────────────────────────────

// Two competency rows for the same product across two support types — exercises
// the `groupCompetencies` aggregation (grouping by productId, collecting support types).
const competencies = [
  {
    id: 'c1',
    productId: 'skill-cpq',
    proficiency: 8,
    product: { id: 'skill-cpq', name: 'CPQ' },
    supportType: { id: 'st-fix', name: 'Technical Fix', slug: 'technical-fix' },
  },
  {
    id: 'c2',
    productId: 'skill-cpq',
    proficiency: 5,
    product: { id: 'skill-cpq', name: 'CPQ' },
    supportType: { id: 'st-arch', name: 'Architecture', slug: 'architecture' },
  },
  {
    id: 'c3',
    productId: 'skill-cases',
    proficiency: 6,
    product: { id: 'skill-cases', name: 'Case Mgmt' },
    supportType: { id: 'st-fix', name: 'Technical Fix', slug: 'technical-fix' },
  },
] as unknown as ApplicationCompetencyWithRelations[];

// ── Tests ────────────────────────────────────────────────────────

describe('ExpertiseTab', () => {
  it('groups competencies by skill and renders a card per skill', () => {
    render(<ExpertiseTab competencies={competencies} skillsLocked={false} />);
    expect(screen.getByText('CPQ')).toBeInTheDocument();
    expect(screen.getByText('Case Mgmt')).toBeInTheDocument();
    // Both support types for CPQ are rendered.
    expect(screen.getAllByText('Technical Fix').length).toBeGreaterThan(0);
    expect(screen.getByText('Architecture')).toBeInTheDocument();
  });

  it('renders proficiency values for each support type', () => {
    render(<ExpertiseTab competencies={competencies} skillsLocked={false} />);
    expect(screen.getByText('8/10')).toBeInTheDocument();
    expect(screen.getByText('5/10')).toBeInTheDocument();
  });

  it('shows the locked banner when skills are locked', () => {
    render(<ExpertiseTab competencies={competencies} skillsLocked />);
    expect(screen.getByText(/expertise is locked after approval/i)).toBeInTheDocument();
    expect(screen.getAllByText(/locked/i).length).toBeGreaterThan(0);
  });

  it('renders the empty state when there are no skills', () => {
    render(<ExpertiseTab competencies={[]} skillsLocked={false} />);
    expect(screen.getByText(/no skills have been assessed yet/i)).toBeInTheDocument();
  });
});
