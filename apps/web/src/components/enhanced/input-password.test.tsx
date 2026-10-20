import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InputPassword } from './input-password';

function renderInput(value: string, showRequirements = true): void {
  render(
    <InputPassword
      label="Password"
      value={value}
      onChange={() => undefined}
      showRequirements={showRequirements}
    />
  );
}

describe('InputPassword requirements', () => {
  it('shows the length rule as unmet below 10 characters', () => {
    renderInput('abcdefghi'); // NOSONAR — test fixture, 9 characters
    expect(screen.getByText('At least 10 characters')).toHaveClass('text-muted-foreground');
  });

  it('shows the length rule as met at 10 characters', () => {
    renderInput('abcdefghij'); // NOSONAR — test fixture, 10 characters
    expect(screen.getByText('At least 10 characters')).toHaveClass('text-success');
  });

  it('shows no strength score, only the passphrase hint', () => {
    renderInput('abcdefghij'); // NOSONAR — test fixture
    expect(screen.getByText(/A few unrelated words make a strong one/)).toBeInTheDocument();
    expect(screen.queryByText(/Strong|Weak|Moderate/)).not.toBeInTheDocument();
  });

  it('renders nothing below the field before the user types', () => {
    renderInput('');
    expect(screen.queryByText('At least 10 characters')).not.toBeInTheDocument();
  });

  it('renders nothing below the field when requirements are off', () => {
    renderInput('abcdefghij', false); // NOSONAR — test fixture
    expect(screen.queryByText('At least 10 characters')).not.toBeInTheDocument();
  });
});
