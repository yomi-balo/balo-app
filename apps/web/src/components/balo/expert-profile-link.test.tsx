import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { ExpertProfileLink } from './expert-profile-link';

const HREF = '/experts/amara-okafor';

function Initials(): React.JSX.Element {
  return <span data-testid="avatar">AO</span>;
}

describe('ExpertProfileLink', () => {
  describe('inline (no avatar)', () => {
    it('links the name to the profile', () => {
      render(
        <p>
          Delivered by <ExpertProfileLink href={HREF}>Amara Okafor</ExpertProfileLink>
        </p>
      );
      const link = screen.getByRole('link', { name: 'Amara Okafor' });
      expect(link).toHaveAttribute('href', HREF);
    });

    it('renders the name bare when the profile does not resolve', () => {
      const { container } = render(
        <p>
          Delivered by <ExpertProfileLink href={null}>Amara Okafor</ExpertProfileLink>
        </p>
      );
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(container.querySelector('p')?.innerHTML).toBe('Delivered by Amara Okafor');
    });

    it('inherits the text colour and shows the hover and focus affordances', () => {
      render(<ExpertProfileLink href={HREF}>Amara Okafor</ExpertProfileLink>);
      const link = screen.getByRole('link');
      expect(link.className).not.toMatch(/(^|\s)text-(?!\[)/);
      expect(link).toHaveClass('hover:underline', 'underline-offset-2');
      expect(link).toHaveClass('focus-visible:ring-2', 'focus-visible:ring-ring');
    });

    it('merges the caller className onto the link', () => {
      render(
        <ExpertProfileLink href={HREF} className="font-semibold">
          Amara Okafor
        </ExpertProfileLink>
      );
      expect(screen.getByRole('link')).toHaveClass('font-semibold', 'hover:underline');
    });

    it('is one keyboard tab stop', async () => {
      const user = userEvent.setup();
      render(<ExpertProfileLink href={HREF}>Amara Okafor</ExpertProfileLink>);
      await user.tab();
      expect(screen.getByRole('link', { name: 'Amara Okafor' })).toHaveFocus();
    });
  });

  describe('with an avatar', () => {
    it('wraps avatar and name in ONE link named by the person only', () => {
      render(
        <ExpertProfileLink href={HREF} avatar={<Initials />}>
          Amara Okafor
        </ExpertProfileLink>
      );
      const links = screen.getAllByRole('link');
      expect(links).toHaveLength(1);
      const [link] = links;
      expect(link).toHaveAccessibleName('Amara Okafor');
      expect(link).toContainElement(screen.getByTestId('avatar'));
      expect(screen.getByTestId('avatar').parentElement).toHaveAttribute('aria-hidden', 'true');
    });

    it('underlines only the name on hover of the whole row', () => {
      render(
        <ExpertProfileLink href={HREF} avatar={<Initials />}>
          Amara Okafor
        </ExpertProfileLink>
      );
      const link = screen.getByRole('link');
      expect(link).toHaveClass('group/expert-profile-link', 'focus-visible:ring-2');
      expect(link).not.toHaveClass('hover:underline');
      expect(screen.getByText('Amara Okafor')).toHaveClass(
        'group-hover/expert-profile-link:underline'
      );
    });

    it('is a single tab stop for avatar and name', async () => {
      const user = userEvent.setup();
      render(
        <>
          <ExpertProfileLink href={HREF} avatar={<Initials />}>
            Amara Okafor
          </ExpertProfileLink>
          <button type="button">next</button>
        </>
      );
      await user.tab();
      expect(screen.getByRole('link')).toHaveFocus();
      await user.tab();
      expect(screen.getByRole('button', { name: 'next' })).toHaveFocus();
    });

    it('keeps the avatar row unlinked when the profile does not resolve', () => {
      render(
        <ExpertProfileLink href={null} avatar={<Initials />} className="gap-2">
          Amara Okafor
        </ExpertProfileLink>
      );
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      const avatar = screen.getByTestId('avatar');
      expect(avatar.parentElement).toHaveAttribute('aria-hidden', 'true');
      const block = avatar.parentElement?.parentElement;
      expect(block?.tagName).toBe('SPAN');
      expect(block).toHaveClass('block', 'w-fit', 'max-w-full', 'gap-2');
      expect(screen.getByText('Amara Okafor')).not.toHaveClass(
        'group-hover/expert-profile-link:underline'
      );
    });

    it('places the avatar out of flow so detail lines stack beside it, top-aligned by default', () => {
      render(
        <ExpertProfileLink href={HREF} avatar={<Initials />}>
          Amara Okafor
        </ExpertProfileLink>
      );
      const avatarBox = screen.getByTestId('avatar').parentElement;
      expect(avatarBox).toHaveClass('absolute', 'left-0', 'top-0');
      expect(avatarBox).not.toHaveClass('top-1/2');
      // The link itself is not the positioned ancestor: the caller's identity column is.
      expect(screen.getByRole('link')).not.toHaveClass('relative');
      expect(screen.getByRole('link')).toHaveClass('block', 'w-fit', 'max-w-full');
    });

    it('centres the avatar vertically for an items-center header', () => {
      render(
        <ExpertProfileLink href={null} avatar={<Initials />} avatarAlign="center">
          Amara Okafor
        </ExpertProfileLink>
      );
      expect(screen.getByTestId('avatar').parentElement).toHaveClass(
        'absolute',
        'top-1/2',
        '-translate-y-1/2'
      );
    });
  });
});
