import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { track, EXPERT_PROFILE_EVENTS } from '@/lib/analytics';
import {
  EXPERT_PROFILE_ROW,
  ExpertProfileAvatarLink,
  ExpertProfileLink,
} from './expert-profile-link';

const HREF = '/experts/amara-okafor';
const NAME_HOVER_FROM_AVATAR =
  'group-has-[[data-expert-profile-avatar]:hover]/expert-profile:underline';

function Row({ href }: Readonly<{ href: string | null }>): React.JSX.Element {
  return (
    <div className={EXPERT_PROFILE_ROW} data-testid="row">
      <ExpertProfileAvatarLink href={href} surface="case_party_card">
        <span data-testid="avatar">AO</span>
      </ExpertProfileAvatarLink>
      <div>
        <p>
          <ExpertProfileLink href={href} surface="case_party_card">
            Amara Okafor
          </ExpertProfileLink>
        </p>
        <p>Salesforce architect</p>
      </div>
    </div>
  );
}

beforeEach(() => {
  vi.mocked(track).mockClear();
});

describe('ExpertProfileLink — the name', () => {
  it('links the name to the profile', () => {
    render(
      <p>
        Delivered by{' '}
        <ExpertProfileLink href={HREF} surface="delivery_header">
          Amara Okafor
        </ExpertProfileLink>
      </p>
    );
    expect(screen.getByRole('link', { name: 'Amara Okafor' })).toHaveAttribute('href', HREF);
  });

  it('renders the name bare when the profile does not resolve', () => {
    const { container } = render(
      <p>
        Delivered by{' '}
        <ExpertProfileLink href={null} surface="delivery_header">
          Amara Okafor
        </ExpertProfileLink>
      </p>
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(container.querySelector('p')?.innerHTML).toBe('Delivered by Amara Okafor');
  });

  it('inherits the text colour and shows the hover and focus affordances', () => {
    render(
      <ExpertProfileLink href={HREF} surface="delivery_header">
        Amara Okafor
      </ExpertProfileLink>
    );
    const link = screen.getByRole('link');
    expect(link.className).not.toMatch(/(^|\s)text-(?!\[)/);
    expect(link).toHaveClass('hover:underline', 'underline-offset-2');
    expect(link).toHaveClass('focus-visible:ring-2', 'focus-visible:ring-ring');
  });

  it('draws the focus ring inset, so a truncating ancestor cannot clip it', () => {
    render(
      <p className="truncate">
        <ExpertProfileLink href={HREF} surface="recap_party_card">
          Amara Okafor
        </ExpertProfileLink>
      </p>
    );
    expect(screen.getByRole('link')).toHaveClass('focus-visible:ring-inset');
  });

  it('merges the caller className onto the link', () => {
    render(
      <ExpertProfileLink href={HREF} surface="case_header" className="truncate">
        Amara Okafor
      </ExpertProfileLink>
    );
    expect(screen.getByRole('link')).toHaveClass('truncate', 'hover:underline');
  });

  it('reports the click with its surface', async () => {
    const user = userEvent.setup();
    render(
      <ExpertProfileLink href={HREF} surface="delivery_header">
        Amara Okafor
      </ExpertProfileLink>
    );
    await user.click(screen.getByRole('link', { name: 'Amara Okafor' }));
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(EXPERT_PROFILE_EVENTS.PROFILE_LINK_CLICKED, {
      surface: 'delivery_header',
    });
  });
});

describe('ExpertProfileAvatarLink + ExpertProfileLink — an identity row', () => {
  it('links the avatar and the name to the same profile', () => {
    const { container } = render(<Row href={HREF} />);
    const anchors = [...container.querySelectorAll('a')];
    expect(anchors).toHaveLength(2);
    const [avatarAnchor, nameAnchor] = anchors;
    expect(avatarAnchor).toHaveAttribute('href', HREF);
    expect(nameAnchor).toHaveAttribute('href', HREF);
    expect(avatarAnchor).toContainElement(screen.getByTestId('avatar'));
    expect(nameAnchor).toHaveTextContent('Amara Okafor');
  });

  it('keeps the avatar link out of the tab order and the accessibility tree', () => {
    const { container } = render(<Row href={HREF} />);
    const avatarLink = container.querySelector('a[data-expert-profile-avatar]');
    expect(avatarLink).toHaveAttribute('tabindex', '-1');
    expect(avatarLink).toHaveAttribute('aria-hidden', 'true');
    expect(avatarLink).toContainElement(screen.getByTestId('avatar'));
  });

  it('exposes exactly one link, named by the person alone', () => {
    render(<Row href={HREF} />);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    const [link] = links;
    expect(link).toHaveAccessibleName('Amara Okafor');
    expect(link).not.toContainElement(screen.getByText('Salesforce architect'));
  });

  it('is one keyboard tab stop', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Row href={HREF} />
        <button type="button">next</button>
      </>
    );
    await user.tab();
    expect(screen.getByRole('link', { name: 'Amara Okafor' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'next' })).toHaveFocus();
  });

  it('underlines the name while the avatar link in the same row is hovered', () => {
    render(<Row href={HREF} />);
    expect(screen.getByTestId('row')).toHaveClass('group/expert-profile');
    expect(screen.getByRole('link', { name: 'Amara Okafor' })).toHaveClass(
      'hover:underline',
      NAME_HOVER_FROM_AVATAR
    );
  });

  it('reports an avatar click with its surface', async () => {
    const user = userEvent.setup();
    render(<Row href={HREF} />);
    await user.click(screen.getByTestId('avatar'));
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(EXPERT_PROFILE_EVENTS.PROFILE_LINK_CLICKED, {
      surface: 'case_party_card',
    });
  });

  it('renders no links at all, and the avatar bare, when the profile does not resolve', () => {
    const { container } = render(<Row href={null} />);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(screen.getByTestId('avatar').parentElement).toBe(screen.getByTestId('row'));
    expect(screen.getByText('Amara Okafor').tagName).toBe('P');
  });
});
