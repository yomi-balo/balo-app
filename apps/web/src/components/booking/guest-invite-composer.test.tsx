import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import {
  GuestInviteComposer,
  type GuestAccessScope,
  type GuestDraft,
} from './guest-invite-composer';

function renderComposer(
  over: {
    guests?: readonly GuestDraft[];
    otherParticipantCount?: number;
    viewerEmailDomain?: string | null;
    clientCompanyName?: string | null;
    accessScope?: GuestAccessScope;
    showPricingNote?: boolean;
    onChange?: (g: readonly GuestDraft[]) => void;
  } = {}
) {
  const onChange = over.onChange ?? vi.fn();
  const utils = render(
    <GuestInviteComposer
      guests={over.guests ?? []}
      onChange={onChange}
      otherParticipantCount={over.otherParticipantCount ?? 2}
      viewerEmailDomain={over.viewerEmailDomain ?? 'acme.com'}
      clientCompanyName={over.clientCompanyName ?? 'Acme'}
      accessScope={over.accessScope}
      showPricingNote={over.showPricingNote}
    />
  );
  return { ...utils, onChange };
}

describe('GuestInviteComposer', () => {
  it('shows the same-domain disclosure for a matching non-freemail address', async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.type(screen.getByLabelText('Guest email address'), 'dana@acme.com');
    expect(
      screen.getByText(/Same company as you — they’ll see this whole case/)
    ).toBeInTheDocument();
  });

  it('shows the outside/personal disclosure for a different domain', async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.type(screen.getByLabelText('Guest email address'), 'dana@othercorp.com');
    expect(screen.getByText(/Outside Acme, or a personal email address/)).toBeInTheDocument();
  });

  it('always shows the outside/personal disclosure for a freemail address, even same-domain-looking', async () => {
    const user = userEvent.setup();
    renderComposer({ viewerEmailDomain: 'gmail.com' });
    await user.type(screen.getByLabelText('Guest email address'), 'dana@gmail.com');
    expect(screen.getByText(/Outside Acme, or a personal email address/)).toBeInTheDocument();
  });

  it('adds a guest on Add and clears the input', async () => {
    const user = userEvent.setup();
    const { onChange } = renderComposer();
    await user.type(screen.getByLabelText('Guest email address'), 'dana@acme.com');
    await user.click(screen.getByRole('button', { name: 'Add guest' }));
    expect(onChange).toHaveBeenCalledWith([{ email: 'dana@acme.com' }]);
  });

  it('removes an added guest', async () => {
    const user = userEvent.setup();
    const { onChange } = renderComposer({ guests: [{ email: 'dana@acme.com' }] });
    await user.click(screen.getByRole('button', { name: 'Remove dana@acme.com' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('disables Add on an invalid email', async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.type(screen.getByLabelText('Guest email address'), 'not-an-email');
    expect(screen.getByRole('button', { name: 'Add guest' })).toBeDisabled();
  });

  it('shows the footer counter — total of 10, guests do not change pay', () => {
    renderComposer({ guests: [{ email: 'a@acme.com' }], otherParticipantCount: 2 });
    expect(screen.getByText("3 of 10 · guests don't change what you pay")).toBeInTheDocument();
  });

  it('disables the input and Add once the 10-participant cap is reached', () => {
    const eightGuests = Array.from({ length: 8 }, (_, i) => ({ email: `g${i}@acme.com` }));
    renderComposer({ guests: eightGuests, otherParticipantCount: 2 });
    expect(
      screen.getByText("You've reached the 10-person limit for this call.")
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Guest email address')).toBeDisabled();
  });

  /**
   * BAL-283 round-1 C3/C4 — the two OPT-OUT props, for a PRE-ENGAGEMENT, UNBILLED surface.
   * Both default to BAL-400's original behaviour, so every existing call site is unchanged.
   */
  describe('showPricingNote={false} — a surface where nothing is paid (C3)', () => {
    it('drops the pricing clause from the counter, keeping the count', () => {
      renderComposer({
        guests: [{ email: 'a@acme.com' }],
        otherParticipantCount: 2,
        showPricingNote: false,
      });
      expect(screen.getByText('3 of 10')).toBeInTheDocument();
      expect(screen.queryByText(/what you pay/i)).not.toBeInTheDocument();
    });

    it('the cap message is unchanged — it never mentioned money', () => {
      const eightGuests = Array.from({ length: 8 }, (_, i) => ({ email: `g${i}@acme.com` }));
      renderComposer({ guests: eightGuests, otherParticipantCount: 2, showPricingNote: false });
      expect(
        screen.getByText("You've reached the 10-person limit for this call.")
      ).toBeInTheDocument();
    });
  });

  describe('accessScope="call" — pre-engagement, so there is no case (C4)', () => {
    it('the LIVE same-domain disclosure names the CALL, never "this whole case"', async () => {
      const user = userEvent.setup();
      renderComposer({ accessScope: 'call' });
      await user.type(screen.getByLabelText('Guest email address'), 'dana@acme.com');
      expect(
        screen.getByText('Same company as you — they’ll only see this intro call and its recap.')
      ).toBeInTheDocument();
      expect(screen.queryByText(/whole case/i)).not.toBeInTheDocument();
    });

    it('the SUMMARY for one added same-domain guest names the CALL', () => {
      renderComposer({ accessScope: 'call', guests: [{ email: 'dana@acme.com' }] });
      expect(
        screen.getByText('dana@acme.com will only see this intro call and its recap.')
      ).toBeInTheDocument();
      expect(screen.queryByText(/every consultation in this case/i)).not.toBeInTheDocument();
    });

    it('the SUMMARY pluralises without ever mentioning a case', () => {
      renderComposer({
        accessScope: 'call',
        guests: [{ email: 'dana@acme.com' }, { email: 'sam@acme.com' }],
      });
      expect(
        screen.getByText('2 people will only see this intro call and its recap.')
      ).toBeInTheDocument();
    });

    it('an OUTSIDE address keeps its own (already call-scoped) disclosure', async () => {
      const user = userEvent.setup();
      renderComposer({ accessScope: 'call' });
      await user.type(screen.getByLabelText('Guest email address'), 'dana@othercorp.com');
      expect(screen.getByText(/Outside Acme, or a personal email address/)).toBeInTheDocument();
    });

    it('defaults to the CASE copy when the prop is omitted — BAL-400 is unchanged', async () => {
      const user = userEvent.setup();
      renderComposer();
      await user.type(screen.getByLabelText('Guest email address'), 'dana@acme.com');
      expect(
        screen.getByText(/Same company as you — they’ll see this whole case/)
      ).toBeInTheDocument();
    });
  });
});
