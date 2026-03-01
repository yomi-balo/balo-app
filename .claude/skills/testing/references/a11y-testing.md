# Accessibility Testing — Balo Platform

## Why A11y Matters for Balo

Balo is a B2B marketplace. Enterprise clients often have accessibility compliance requirements (Section 508, WCAG 2.1 AA). Building a11y testing into the workflow from the start prevents expensive retrofitting later.

## Tools

### Component-Level: jest-axe

```bash
pnpm --filter web add -D jest-axe @types/jest-axe
```

```typescript
import { axe, toHaveNoViolations } from 'jest-axe';
expect.extend(toHaveNoViolations);

it('has no a11y violations', async () => {
  const { container } = render(<MyComponent />);
  expect(await axe(container)).toHaveNoViolations();
});
```

### E2E-Level: @axe-core/playwright

```bash
pnpm add -D @axe-core/playwright
```

```typescript
import AxeBuilder from '@axe-core/playwright';

test('page meets WCAG AA', async ({ page }) => {
  await page.goto('/experts');
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations).toEqual([]);
});
```

## What to Test

### Always a11y-test these components:

- Auth modal (forms, error messages, focus management)
- Search/filter interfaces (comboboxes, checkboxes, range sliders)
- Booking wizard (multi-step form, progress indicator)
- Chat interface (live region for new messages, keyboard nav)
- Dashboard tables (sortable headers, row actions)

### Skip a11y tests for:

- Internal admin-only pages (lower priority)
- Components that are pure shadcn/ui with no customization

## Common Issues in Marketplace UIs

### Modal Focus Trapping

Auth modal must trap focus inside when open. Radix Dialog handles this, but verify:

```typescript
it('traps focus within modal', async () => {
  const user = userEvent.setup();
  render(<AuthModal open onOpenChange={vi.fn()} />);

  // Tab should cycle within modal, not escape to background
  await user.tab();
  expect(document.activeElement).toBeInTheDocument();
  // activeElement should be inside the dialog
});
```

### Live Regions for Chat

Case chat messages must announce to screen readers:

```html
<div role="log" aria-live="polite" aria-label="Case messages">
  <!-- messages render here -->
</div>
```

### Error Announcements

Form validation errors should use `role="alert"`:

```html
<p role="alert" aria-live="assertive">Email is required</p>
```

## CI Reporting

When a11y violations fail in CI, the axe output includes:

- Rule ID (e.g., `color-contrast`)
- Impact level (critical, serious, moderate, minor)
- Affected elements with CSS selectors
- Fix suggestions

Log these clearly for fast debugging:

```typescript
if (results.violations.length > 0) {
  console.error('A11y violations:');
  results.violations.forEach((v) => {
    console.error(`  [${v.impact}] ${v.id}: ${v.description}`);
    v.nodes.forEach((n) => console.error(`    → ${n.target.join(', ')}`));
  });
}
```
