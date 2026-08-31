import { describe, it, expect, vi } from 'vitest';
import { axe } from 'jest-axe';
import { render, screen } from '@/test/utils';
import { Building2 } from 'lucide-react';

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

import { TabPlaceholder } from './tab-placeholder';

describe('TabPlaceholder', () => {
  it('renders the title, description, and icon', () => {
    render(
      <TabPlaceholder
        icon={Building2}
        iconColor="#2563EB"
        title="Your company profile"
        description="Keep your company details up to date."
      />
    );
    expect(screen.getByText('Your company profile')).toBeInTheDocument();
    expect(screen.getByText('Keep your company details up to date.')).toBeInTheDocument();
  });

  it('omits the task chip when task is not supplied', () => {
    render(
      <TabPlaceholder
        icon={Building2}
        iconColor="#2563EB"
        title="Your company profile"
        description="Keep your company details up to date."
      />
    );
    expect(screen.queryByText(/BAL-/)).not.toBeInTheDocument();
  });

  it('renders the task chip when task is supplied', () => {
    render(
      <TabPlaceholder
        icon={Building2}
        iconColor="#2563EB"
        title="Your company profile"
        description="Keep your company details up to date."
        task="BAL-503"
      />
    );
    expect(screen.getByText('BAL-503')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <TabPlaceholder
        icon={Building2}
        iconColor="#2563EB"
        title="Your company profile"
        description="Keep your company details up to date."
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
