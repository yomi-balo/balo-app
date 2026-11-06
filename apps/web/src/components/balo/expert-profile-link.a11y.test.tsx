import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from '@/test/axe';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  EXPERT_PROFILE_ROW,
  ExpertProfileAvatarLink,
  ExpertProfileLink,
} from './expert-profile-link';

const HREF = '/experts/amara-okafor';

function IdentityRow({ href }: Readonly<{ href: string | null }>): React.JSX.Element {
  return (
    <div className={EXPERT_PROFILE_ROW}>
      <ExpertProfileAvatarLink href={href} surface="case_party_card">
        <Avatar size="lg">
          <AvatarImage src="https://example.com/a.png" alt="" />
          <AvatarFallback>AO</AvatarFallback>
        </Avatar>
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

describe('ExpertProfileLink accessibility', () => {
  it('has no violations as an inline link inside a meta line', async () => {
    const { container } = render(
      <main>
        <p>
          Delivered by{' '}
          <ExpertProfileLink href={HREF} surface="delivery_header">
            Amara Okafor
          </ExpertProfileLink>{' '}
          — Salesforce architect
        </p>
      </main>
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations as an avatar link + name link row, aria-hidden-focus included', async () => {
    const { container } = render(
      <main>
        <IdentityRow href={HREF} />
      </main>
    );
    const results = await axe(container, {
      runOnly: { type: 'rule', values: ['aria-hidden-focus'] },
    });
    expect(results.passes.map((rule) => rule.id)).toContain('aria-hidden-focus');
    expect(results).toHaveNoViolations();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations when the profile does not resolve', async () => {
    const { container } = render(
      <main>
        <IdentityRow href={null} />
        <p>
          Delivered by{' '}
          <ExpertProfileLink href={null} surface="delivery_header">
            Amara Okafor
          </ExpertProfileLink>
        </p>
      </main>
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
