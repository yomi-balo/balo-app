import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemberJoinNotice } from './member-join-notice';
import {
  JOIN_UNAVAILABLE_BODY,
  JOIN_UNAVAILABLE_TITLE,
  MEMBER_JOIN_NOT_OPEN_BODY,
  MEMBER_JOIN_NOT_OPEN_TITLE,
  MEMBER_JOIN_SETTING_UP_BODY,
  MEMBER_JOIN_SETTING_UP_TITLE,
  MEMBER_JOIN_UNAVAILABLE_BODY,
  MEMBER_JOIN_UNAVAILABLE_TITLE,
} from '@/lib/meetings/lobby';

describe('MemberJoinNotice — each reason renders its own title/body', () => {
  it('not_provisioned', () => {
    render(<MemberJoinNotice reason="not_provisioned" />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      MEMBER_JOIN_SETTING_UP_TITLE
    );
    expect(screen.getByText(MEMBER_JOIN_SETTING_UP_BODY)).toBeInTheDocument();
  });

  it('not_open', () => {
    render(<MemberJoinNotice reason="not_open" />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(MEMBER_JOIN_NOT_OPEN_TITLE);
    expect(screen.getByText(MEMBER_JOIN_NOT_OPEN_BODY)).toBeInTheDocument();
  });

  it('unavailable', () => {
    render(<MemberJoinNotice reason="unavailable" />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      MEMBER_JOIN_UNAVAILABLE_TITLE
    );
    expect(screen.getByText(MEMBER_JOIN_UNAVAILABLE_BODY)).toBeInTheDocument();
  });

  it('⚠⚠ never renders the guest "whoever shared" copy, on any reason', () => {
    for (const reason of ['not_provisioned', 'not_open', 'unavailable'] as const) {
      const { container, unmount } = render(<MemberJoinNotice reason={reason} />);
      const text = container.textContent ?? '';

      expect(text).not.toContain(JOIN_UNAVAILABLE_TITLE);
      expect(text).not.toContain(JOIN_UNAVAILABLE_BODY);
      expect(text).not.toMatch(/shared it with you/i);
      unmount();
    }
  });
});

describe('MemberJoinNotice — retry', () => {
  it('renders "Try again" only when onRetry is given, for not_provisioned', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    const { unmount } = render(<MemberJoinNotice reason="not_provisioned" onRetry={onRetry} />);

    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    unmount();

    render(<MemberJoinNotice reason="not_provisioned" />);
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it("⚠ the component is a dumb renderer — WHICH reasons get onRetry is the caller's policy", () => {
    // `MemberJoinNotice` renders the button whenever `onRetry` is given, on any reason.
    // `call-client.tsx` only ever passes `onRetry` for `not_provisioned`
    // (`isRetryableMemberJoinFailure`); that policy is pinned in `call-client.test.tsx`, not here.
    render(<MemberJoinNotice reason="not_open" onRetry={vi.fn()} />);

    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

describe('MemberJoinNotice — focus target', () => {
  it('exposes its heading as a focus target for the state transition', () => {
    const ref = createRef<HTMLHeadingElement>();
    render(<MemberJoinNotice reason="unavailable" headingRef={ref} />);

    expect(ref.current).not.toBeNull();
    expect(ref.current?.getAttribute('tabindex')).toBe('-1');
  });
});

describe('MemberJoinNotice — accessibility', () => {
  it('has no violations on each reason', async () => {
    for (const reason of ['not_provisioned', 'not_open', 'unavailable'] as const) {
      const { container, unmount } = render(
        <MemberJoinNotice
          reason={reason}
          onRetry={reason === 'not_provisioned' ? vi.fn() : undefined}
        />
      );
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});
