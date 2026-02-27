# Layouts & States — Balo

## Page Layout Patterns

### Marketing Pages

```tsx
// Full-width sections with contained content
<main>
  <GlowBackground>
    <section className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">{/* Hero content */}</section>
  </GlowBackground>

  <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
    {/* Features, how it works, etc. */}
  </section>
</main>
```

### App Shell (Dashboard)

Monday.com-inspired: top nav + optional sidebar + main content.

```tsx
// app/(dashboard)/layout.tsx
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-background min-h-screen">
      <TopNav />
      <div className="flex">
        <Sidebar className="border-border hidden w-64 border-r lg:block" />
        <main className="max-w-7xl flex-1 p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
```

### Page Header Pattern

Every dashboard page starts with a consistent header:

```tsx
function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-8 flex items-start justify-between">
      <div>
        <h1 className="text-foreground text-2xl font-semibold">{title}</h1>
        {description && <p className="text-muted-foreground mt-1 text-sm">{description}</p>}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}

// Usage
<PageHeader
  title="My Cases"
  description="Manage your active and past consultations"
  action={<Button>New Case</Button>}
/>;
```

## The Four States

**Every component that loads data MUST handle all four states.** No exceptions. This is enforced by the `/ux` agent.

### 1. Loading State

Use skeleton loaders that match the shape of the content. Never show a blank screen or a centered spinner.

```tsx
// loading.tsx (Next.js file convention)
export default function CasesLoading() {
  return (
    <div className="space-y-4">
      <PageHeader title="My Cases" />
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <CaseCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

function CaseCardSkeleton() {
  return (
    <Card className="p-5">
      <div className="space-y-3">
        <div className="bg-muted h-5 w-3/4 animate-pulse rounded" />
        <div className="bg-muted h-4 w-1/2 animate-pulse rounded" />
        <div className="mt-4 flex gap-2">
          <div className="bg-muted h-6 w-16 animate-pulse rounded-full" />
          <div className="bg-muted h-6 w-20 animate-pulse rounded-full" />
        </div>
      </div>
    </Card>
  );
}
```

### 2. Empty State

Friendly, helpful, with a clear CTA. Never just "No results."

```tsx
import { Inbox } from 'lucide-react';

function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
}: {
  icon?: React.ElementType;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="bg-muted mb-4 rounded-xl p-4">
        <Icon className="text-muted-foreground h-8 w-8" />
      </div>
      <h3 className="text-foreground text-lg font-semibold">{title}</h3>
      <p className="text-muted-foreground mt-1 max-w-sm text-sm">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// Usage
<EmptyState
  icon={MessageSquare}
  title="No cases yet"
  description="Start a consultation with an expert to get help with your Salesforce challenges."
  action={<Button>Find an Expert</Button>}
/>;
```

### 3. Error State

Show what went wrong and how to fix it. Always include a retry action.

```tsx
// error.tsx (Next.js file convention)
'use client';

import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function CasesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="bg-destructive/10 mb-4 rounded-xl p-4">
        <AlertCircle className="text-destructive h-8 w-8" />
      </div>
      <h3 className="text-foreground text-lg font-semibold">Something went wrong</h3>
      <p className="text-muted-foreground mt-1 max-w-sm text-sm">
        We couldn't load your cases. This might be a temporary issue.
      </p>
      <Button onClick={reset} variant="outline" className="mt-4">
        Try again
      </Button>
    </div>
  );
}
```

### 4. Success State

The data is loaded. This is the "normal" state — but don't forget transitions.

```tsx
// Animate content appearing after load
<motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
  <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
    {cases.map((c) => (
      <CaseCard key={c.id} case={c} />
    ))}
  </div>
</motion.div>
```

## Navigation

### Top Navigation (Monday-Inspired)

Clean, spacious, with the Balo logo and primary nav items.

```tsx
function TopNav() {
  return (
    <header className="border-border bg-background/95 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-50 w-full border-b backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center px-4 sm:px-6 lg:px-8">
        <Logo className="mr-8" />
        <nav className="flex items-center gap-6 text-sm font-medium">
          <NavLink href="/dashboard">Dashboard</NavLink>
          <NavLink href="/cases">Cases</NavLink>
          <NavLink href="/experts">Find Experts</NavLink>
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <CreditBalance />
          <ThemeToggle />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
```

### Active Nav Link

```tsx
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const isActive = pathname.startsWith(href);

  return (
    <Link
      href={href}
      className={cn(
        'transition-colors duration-150',
        isActive ? 'text-foreground font-semibold' : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </Link>
  );
}
```

## Data Tables

Use TanStack Table + shadcn DataTable wrapper. Keep them spacious.

```tsx
// Column padding and row height
<Table>
  <TableHeader>
    <TableRow className="hover:bg-transparent">
      <TableHead className="text-muted-foreground py-3 text-xs font-medium tracking-wider uppercase">
        Expert
      </TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    <TableRow className="h-14">
      {' '}
      {/* Generous row height */}
      <TableCell className="py-3">{/* Content */}</TableCell>
    </TableRow>
  </TableBody>
</Table>
```

### Table Rules

- Row height: `h-14` minimum (spacious feel)
- Header: `text-xs uppercase tracking-wider text-muted-foreground`
- Hover: `hover:bg-muted/50` on rows
- Actions: Right-aligned, use `DropdownMenu` for multiple actions
- Pagination at bottom with page size selector
- Empty state when no results (not just an empty table)

## Toasts (Sonner)

```tsx
import { toast } from 'sonner';

// Success
toast.success('Case created successfully');

// Error
toast.error('Failed to create case. Please try again.');

// Promise-based (loading → success/error)
toast.promise(createCase(data), {
  loading: 'Creating case...',
  success: 'Case created!',
  error: 'Failed to create case',
});

// Action toast
toast('Case created', {
  action: {
    label: 'View',
    onClick: () => router.push(`/cases/${id}`),
  },
});
```

### Toast Rules

**Core principle: No silent mutations.** Every user-initiated action that changes data gets explicit feedback. The user should never wonder "did that work?"

#### When to Toast

| Action             | Toast Type        | Example                                                 |
| ------------------ | ----------------- | ------------------------------------------------------- |
| Create something   | `toast.promise`   | "Creating case..." → "Case created!"                    |
| Update/save        | `toast.success`   | "Changes saved"                                         |
| Delete/cancel      | `toast.success`   | "Case cancelled"                                        |
| Payment/financial  | `toast.promise`   | "Processing payment..." → "Payment confirmed — $150.00" |
| Invite/share       | `toast.success`   | "Invitation sent to sarah@example.com"                  |
| Copy to clipboard  | `toast.success`   | "Copied to clipboard"                                   |
| Background action  | `toast` (neutral) | "File uploading..."                                     |
| Error (mutation)   | `toast.error`     | "Failed to save. Please try again."                     |
| Error (permission) | `toast.error`     | "You don't have permission to do that"                  |

#### When NOT to Toast

- Form validation errors — use inline `FormMessage`
- Navigation/filtering — no feedback needed, the UI changed
- Read-only actions (viewing, expanding) — the UI itself is the feedback
- Real-time updates from others — use in-app indicators, not toasts

#### Toast Style

- **Success:** auto-dismiss after 3s, green checkmark
- **Error:** stays until dismissed, red icon, include retry hint when applicable
- **Promise:** shows loading spinner → resolves to success/error
- **Action toast:** include a CTA when the user might want to navigate to the created thing

```tsx
// The standard pattern for Server Actions:
async function handleSubmit(data: FormData) {
  toast.promise(createCase(data), {
    loading: 'Creating case...',
    success: (result) => {
      router.push(`/cases/${result.id}`);
      return 'Case created!';
    },
    error: 'Failed to create case. Please try again.',
  });
}

// For simple updates where you don't navigate:
async function handleSave() {
  try {
    await updateProfile(data);
    toast.success('Profile updated');
  } catch {
    toast.error('Failed to save changes');
  }
}

// For destructive actions — toast AFTER confirmation dialog:
async function handleDelete() {
  try {
    await deleteCase(id);
    toast.success('Case deleted');
    router.push('/cases');
  } catch {
    toast.error('Failed to delete case');
  }
}
```

## Dialog/Modal Pattern

```tsx
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

function ConfirmationDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Confirm',
  isDestructive = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmLabel?: string;
  isDestructive?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={isDestructive ? 'destructive' : 'default'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

### Dialog Rules

- Max width: `sm:max-w-[425px]` for simple confirmations
- Wider (`sm:max-w-[600px]` or `sm:max-w-2xl`) for forms/content
- Always include DialogHeader with Title + Description
- Cancel button is always `outline` variant, always on the left
- Destructive actions use `destructive` variant
- On mobile: consider using Sheet (bottom drawer) instead of Dialog

## Accessibility Checklist

- [ ] All interactive elements reachable via keyboard (Tab)
- [ ] Focus states visible (`focus-visible:ring-2 focus-visible:ring-ring`)
- [ ] All images have `alt` text
- [ ] Form inputs have associated `<label>` elements
- [ ] Color is not the only way to convey information (add icons/text)
- [ ] Minimum contrast ratio 4.5:1 for text, 3:1 for large text
- [ ] aria-label on icon-only buttons
- [ ] Dialog/modal traps focus when open
- [ ] Skip-to-content link for keyboard users
- [ ] Reduced motion: respect `prefers-reduced-motion`

```tsx
// Respect reduced motion preference
<motion.div
  initial={{ opacity: 0, y: 20 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.3 }}
  // Users with motion sensitivity get instant appearance
  style={{ willChange: "transform, opacity" }}
>
```

For Motion specifically, it automatically respects `prefers-reduced-motion` by default — animations are reduced to opacity-only changes.
