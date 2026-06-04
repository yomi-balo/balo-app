import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

const { mockUseIsMobile } = vi.hoisted(() => ({ mockUseIsMobile: vi.fn(() => false) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mockUseIsMobile() }));

import { Drawer, DrawerHeader, DrawerBody, DrawerFooter } from './drawer';

describe('Drawer', () => {
  beforeEach(() => {
    mockUseIsMobile.mockReturnValue(false);
  });

  it('renders content when open and hides it when closed', () => {
    const { rerender } = render(
      <Drawer open={false} onOpenChange={vi.fn()} title="Booking">
        <DrawerBody>Drawer contents</DrawerBody>
      </Drawer>
    );
    expect(screen.queryByText('Drawer contents')).not.toBeInTheDocument();

    rerender(
      <Drawer open onOpenChange={vi.fn()} title="Booking">
        <DrawerBody>Drawer contents</DrawerBody>
      </Drawer>
    );
    expect(screen.getByText('Drawer contents')).toBeInTheDocument();
  });

  it('renders into a portal (content lands on document.body, outside the React root)', () => {
    const { container } = render(
      <Drawer open onOpenChange={vi.fn()} title="Booking">
        <DrawerBody>Portaled body</DrawerBody>
      </Drawer>
    );
    const body = screen.getByText('Portaled body');
    // The content is portaled — it is NOT inside the component's own container.
    expect(container.contains(body)).toBe(false);
    expect(document.body.contains(body)).toBe(true);
  });

  it('exposes an accessible title via the (visually-hidden) SheetTitle', () => {
    render(
      <Drawer open onOpenChange={vi.fn()} title="Book a consultation">
        <DrawerBody>Body</DrawerBody>
      </Drawer>
    );
    // The title is a heading; querying by role disambiguates it from the
    // sr-only description fallback that mirrors the title.
    expect(screen.getByRole('heading', { name: 'Book a consultation' })).toBeInTheDocument();
  });

  it('DrawerHeader close button calls onClose (wired to onOpenChange(false))', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Drawer open onOpenChange={onOpenChange} title="Booking">
        <DrawerHeader onClose={() => onOpenChange(false)}>
          <span>Step 1</span>
        </DrawerHeader>
        <DrawerBody>Body</DrawerBody>
      </Drawer>
    );

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders header / body / footer slots together', () => {
    render(
      <Drawer open onOpenChange={vi.fn()} title="Booking">
        <DrawerHeader onClose={vi.fn()}>Header slot</DrawerHeader>
        <DrawerBody>Body slot</DrawerBody>
        <DrawerFooter>Footer slot</DrawerFooter>
      </Drawer>
    );
    expect(screen.getByText('Header slot')).toBeInTheDocument();
    expect(screen.getByText('Body slot')).toBeInTheDocument();
    expect(screen.getByText('Footer slot')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { baseElement } = render(
      <Drawer open onOpenChange={vi.fn()} title="Booking" description="Book a consultation">
        <DrawerHeader onClose={vi.fn()}>Step 1</DrawerHeader>
        <DrawerBody>Body</DrawerBody>
      </Drawer>
    );
    // axe over baseElement (document.body) so the portaled content is included.
    expect(await axe(baseElement)).toHaveNoViolations();
  });
});
