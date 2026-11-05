import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from '@/test/axe';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ExpertProfileLink } from './expert-profile-link';

const HREF = '/experts/amara-okafor';

function PersonAvatar(): React.JSX.Element {
  return (
    <Avatar size="lg">
      <AvatarImage src="https://example.com/a.png" alt="" />
      <AvatarFallback>AO</AvatarFallback>
    </Avatar>
  );
}

describe('ExpertProfileLink accessibility', () => {
  it('has no violations as an inline link inside a meta line', async () => {
    const { container } = render(
      <main>
        <p>
          Delivered by <ExpertProfileLink href={HREF}>Amara Okafor</ExpertProfileLink> — Salesforce
          architect
        </p>
      </main>
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations as an avatar + name link', async () => {
    const { container } = render(
      <main>
        <ExpertProfileLink href={HREF} avatar={<PersonAvatar />}>
          Amara Okafor
        </ExpertProfileLink>
      </main>
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations when the profile does not resolve', async () => {
    const { container } = render(
      <main>
        <ExpertProfileLink href={null} avatar={<PersonAvatar />}>
          Amara Okafor
        </ExpertProfileLink>
        <p>
          Delivered by <ExpertProfileLink href={null}>Amara Okafor</ExpertProfileLink>
        </p>
      </main>
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
