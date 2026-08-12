import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { Globe, Lock, Sparkles } from 'lucide-react';
import {
  SectionCard,
  SectionHead,
  SectionSkeleton,
  SectionEmpty,
  SectionError,
  InfoNote,
} from './section-states';

describe('SectionCard', () => {
  it('renders the title, description, header-right slot, and children', () => {
    render(
      <SectionCard title="Domains" description="Manage domains" headerRight={<span>chip</span>}>
        <p>body content</p>
      </SectionCard>
    );
    expect(screen.getByRole('heading', { name: /^Domains$/ })).toBeInTheDocument();
    expect(screen.getByText(/Manage domains/)).toBeInTheDocument();
    expect(screen.getByText(/chip/)).toBeInTheDocument();
    expect(screen.getByText(/body content/)).toBeInTheDocument();
  });
});

describe('SectionHead', () => {
  it('renders the title as a heading and the optional meta', () => {
    render(<SectionHead icon={Sparkles} title="Summary" meta="AI-generated" />);
    expect(screen.getByRole('heading', { name: /^Summary$/ })).toBeInTheDocument();
    expect(screen.getByText(/AI-generated/)).toBeInTheDocument();
  });

  it('omits the meta slot entirely when no meta is given', () => {
    render(<SectionHead icon={Sparkles} title="Transcript" />);
    expect(screen.getByRole('heading', { name: /^Transcript$/ })).toBeInTheDocument();
    expect(screen.queryByText(/AI-generated/)).not.toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<SectionHead icon={Sparkles} title="Files" meta="3" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('SectionSkeleton', () => {
  it('renders a labelled loading status', () => {
    render(<SectionSkeleton rows={2} />);
    expect(screen.getByRole('status', { name: /loading/i })).toBeInTheDocument();
  });
});

describe('SectionEmpty', () => {
  it('renders the icon, title, body, and optional children', () => {
    render(
      <SectionEmpty icon={Globe} title="No domains yet" body="Add one to get started">
        <button type="button">Do it</button>
      </SectionEmpty>
    );
    expect(screen.getByRole('heading', { name: /No domains yet/ })).toBeInTheDocument();
    expect(screen.getByText(/Add one to get started/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Do it/ })).toBeInTheDocument();
  });
});

describe('SectionError', () => {
  it('renders an alert and fires onRetry when Try again is clicked', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(<SectionError label="your domains" onRetry={onRetry} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/We couldn.t load your domains/);
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('keeps the settings-shaped reassurance line when no body override is given', () => {
    render(<SectionError label="your domains" onRetry={vi.fn()} />);
    expect(screen.getByText(/your settings are safe/i)).toBeInTheDocument();
  });

  it('renders a caller-supplied body instead of the default (BAL-388 recap copy)', () => {
    render(
      <SectionError
        label="this recap"
        onRetry={vi.fn()}
        body="Nothing else was affected — your files are still here."
      />
    );
    expect(screen.getByText(/Nothing else was affected/i)).toBeInTheDocument();
    expect(screen.queryByText(/your settings are safe/i)).not.toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<SectionError label="the queue" onRetry={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('InfoNote', () => {
  it('renders its children with a custom icon', () => {
    render(<InfoNote icon={Lock}>Agencies decide membership by verified email.</InfoNote>);
    expect(screen.getByText(/agencies decide membership by verified email/i)).toBeInTheDocument();
  });
});
