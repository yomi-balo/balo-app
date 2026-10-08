import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import { ExperienceEditSection } from './experience-edit-section';
import type { StaffEditModel } from '../../_lib/staff-edit-model';

/**
 * The inline experience error is computed by the workspace
 * (`staffEditExperienceError`) and passed down as a plain string, never recomputed here.
 */

function model(overrides: Partial<StaffEditModel['experience']> = {}): StaffEditModel {
  return {
    experience: {
      yearStartedSalesforce: 2018,
      projectCountMin: 10,
      projectLeadCountMin: 1,
      isSalesforceMvp: false,
      isSalesforceCta: false,
      isCertifiedTrainer: false,
      ...overrides,
    },
    languages: [],
    industryIds: [],
    products: [],
    ratings: {},
    certificationIds: [],
  };
}

describe('ExperienceEditSection', () => {
  it('renders no error text and a valid lead trigger when error is null', () => {
    render(
      <ExperienceEditSection
        draft={model()}
        initial={model()}
        update={vi.fn()}
        disabled={false}
        error={null}
      />
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('combobox', { name: /projects as lead/i })).toHaveAttribute(
      'aria-invalid',
      'false'
    );
  });

  it('renders the inline error message, marking the lead trigger invalid and described by it', () => {
    const message = "Projects led can't be more than total projects.";
    render(
      <ExperienceEditSection
        draft={model({ projectCountMin: 1, projectLeadCountMin: 10 })}
        initial={model()}
        update={vi.fn()}
        disabled={false}
        error={message}
      />
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(message);
    const leadTrigger = screen.getByRole('combobox', { name: /projects as lead/i });
    expect(leadTrigger).toHaveAttribute('aria-invalid', 'true');
    expect(leadTrigger).toHaveAttribute('aria-describedby', alert.id);
  });
});
