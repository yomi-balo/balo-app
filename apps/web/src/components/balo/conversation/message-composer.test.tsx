import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { MessageComposer } from './message-composer';
import { MESSAGE_MAX_TEXT } from '@/lib/project-request/conversation-view-types';

type ComposerProps = React.ComponentProps<typeof MessageComposer>;

/**
 * The composer is CONTROLLED (the stage owns per-thread drafts) — this harness
 * plays the stage's role: holds the draft and clears it when a send succeeds.
 */
function Harness({
  initialValue = '',
  onSend,
  ...overrides
}: Readonly<
  Partial<Omit<ComposerProps, 'value' | 'onChange'>> & {
    initialValue?: string;
    onSend?: ComposerProps['onSend'];
  }
>): React.JSX.Element {
  const [value, setValue] = useState(initialValue);
  const send: ComposerProps['onSend'] =
    onSend ??
    (() => {
      setValue('');
      return Promise.resolve(true);
    });
  return (
    <MessageComposer
      expertFirstName="Priya"
      sending={false}
      uploading={null}
      value={value}
      onChange={setValue}
      onSend={(text) =>
        send(text).then((sent) => {
          if (sent) setValue('');
          return sent;
        })
      }
      onAttach={vi.fn()}
      {...overrides}
    />
  );
}

function renderComposer(
  overrides: Partial<Omit<ComposerProps, 'value' | 'onChange'>> & { initialValue?: string } = {}
): {
  onSend: ReturnType<typeof vi.fn>;
  onAttach: ReturnType<typeof vi.fn>;
} {
  const onSend = vi.fn().mockResolvedValue(true);
  const onAttach = vi.fn();
  render(<Harness onSend={onSend} onAttach={onAttach} {...overrides} />);
  return { onSend, onAttach };
}

/** The composer with both typing hooks wired to spies. */
function renderTypingComposer(
  overrides: Partial<Omit<ComposerProps, 'value' | 'onChange'>> & { initialValue?: string } = {}
): {
  onSend: ReturnType<typeof vi.fn>;
  onTyping: ReturnType<typeof vi.fn>;
  onTypingStopped: ReturnType<typeof vi.fn>;
  textarea: HTMLElement;
} {
  const onTyping = vi.fn();
  const onTypingStopped = vi.fn();
  const { onSend } = renderComposer({ onTyping, onTypingStopped, ...overrides });
  return {
    onSend,
    onTyping,
    onTypingStopped,
    textarea: screen.getByRole('textbox', { name: 'Message Priya' }),
  };
}

describe('MessageComposer', () => {
  it('labels the textarea for the active thread', () => {
    renderComposer();
    expect(screen.getByRole('textbox', { name: 'Message Priya' })).toHaveAttribute(
      'placeholder',
      'Message Priya…'
    );
  });

  it('prefers the nudge-driven placeholder when provided', () => {
    renderComposer({ placeholder: 'Reply to Priya…' });
    expect(screen.getByRole('textbox', { name: 'Message Priya' })).toHaveAttribute(
      'placeholder',
      'Reply to Priya…'
    );
  });

  it('Enter sends the trimmed draft and clears it on success', async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer();
    const textarea = screen.getByRole('textbox', { name: 'Message Priya' });
    await user.type(textarea, '  Hello there  {Enter}');
    expect(onSend).toHaveBeenCalledWith('Hello there');
    await waitFor(() => expect(textarea).toHaveValue(''));
  });

  it('keeps focus in the textarea after a successful send', async () => {
    const user = userEvent.setup();
    renderComposer();
    const textarea = screen.getByRole('textbox', { name: 'Message Priya' });
    await user.type(textarea, 'Hello{Enter}');
    await waitFor(() => expect(textarea).toHaveValue(''));
    expect(textarea).toHaveFocus();
  });

  it('Shift+Enter inserts a newline without sending', async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer();
    const textarea = screen.getByRole('textbox', { name: 'Message Priya' });
    await user.type(textarea, 'line one{Shift>}{Enter}{/Shift}line two');
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('line one\nline two');
  });

  it('keeps the draft when send resolves false', async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer();
    onSend.mockResolvedValue(false);
    const textarea = screen.getByRole('textbox', { name: 'Message Priya' });
    await user.type(textarea, 'Important draft{Enter}');
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(textarea).toHaveValue('Important draft');
  });

  it('keeps the draft when send REJECTS (stage owns the toast)', async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer();
    onSend.mockRejectedValue(new Error('boom'));
    const textarea = screen.getByRole('textbox', { name: 'Message Priya' });
    await user.type(textarea, 'Still here{Enter}');
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(textarea).toHaveValue('Still here');
  });

  it('never sends an empty/whitespace draft', async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer();
    const textarea = screen.getByRole('textbox', { name: 'Message Priya' });
    await user.type(textarea, '   {Enter}');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('keeps the textarea FOCUSABLE while sending (readOnly, not disabled)', () => {
    renderComposer({ sending: true, initialValue: 'mid-flight' });
    const textarea = screen.getByRole('textbox', { name: 'Message Priya' });
    expect(textarea).not.toBeDisabled();
    expect(textarea).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('blocks an over-limit draft inline without calling onSend', async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer({ initialValue: 'x'.repeat(MESSAGE_MAX_TEXT + 1) });
    expect(
      screen.getByText(
        `Keep your message under ${MESSAGE_MAX_TEXT.toLocaleString('en-US')} characters.`
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Message Priya' }), '{Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('shows the subtle counter when approaching the limit (hidden when far below)', () => {
    const nearLimit = MESSAGE_MAX_TEXT - 100;
    renderComposer({ initialValue: 'y'.repeat(nearLimit) });
    expect(
      screen.getByText(
        `${nearLimit.toLocaleString('en-US')}/${MESSAGE_MAX_TEXT.toLocaleString('en-US')}`
      )
    ).toBeInTheDocument();
  });

  it('hides the counter for short drafts', () => {
    renderComposer({ initialValue: 'short draft' });
    expect(screen.queryByText(/\/4,000/)).not.toBeInTheDocument();
  });

  it('shows upload progress and blocks a second attach while uploading', () => {
    renderComposer({ uploading: { fileName: 'scope.pdf', progress: 42 } });
    expect(screen.getByText('Sharing scope.pdf…')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Attach a file' })).toBeDisabled();
  });

  it('forwards a picked file to onAttach', async () => {
    const user = userEvent.setup();
    const { onAttach } = renderComposer();
    const file = new File(['x'], 'scope.pdf', { type: 'application/pdf' });
    const input = document.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    await user.upload(input as HTMLInputElement, file);
    expect(onAttach).toHaveBeenCalledWith(file);
  });

  /**
   * BAL-431 (OSD-2) — `onAttach` became OPTIONAL so the project-request stage, which retired its
   * in-thread file affordance, can render a composer with no attach control at all. The CASE
   * surface still passes it and every case above still covers that arm; this pair pins the new
   * one from both sides, because the failure it guards against is silent: a live paperclip wired
   * to nothing swallows the user's file with no error.
   */
  it('renders NO attach button and NO file input when `onAttach` is omitted', () => {
    render(
      <MessageComposer
        expertFirstName="Priya"
        sending={false}
        uploading={null}
        value=""
        onChange={vi.fn()}
        onSend={vi.fn().mockResolvedValue(true)}
      />
    );
    expect(screen.queryByRole('button', { name: 'Attach a file' })).not.toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    // Messaging itself is untouched — this removes ONLY the file affordance.
    expect(screen.getByRole('textbox', { name: 'Message Priya' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument();
  });

  it('still renders the attach button when `onAttach` IS supplied (the case surface)', () => {
    renderComposer();
    expect(screen.getByRole('button', { name: 'Attach a file' })).toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).not.toBeNull();
  });

  it('reports focus changes (mobile rail hides while typing)', async () => {
    const user = userEvent.setup();
    const onFocusChange = vi.fn();
    renderComposer({ onFocusChange });
    await user.click(screen.getByRole('textbox', { name: 'Message Priya' }));
    expect(onFocusChange).toHaveBeenCalledWith(true);
    await user.tab();
    expect(onFocusChange).toHaveBeenCalledWith(false);
  });

  it('renders the disabled empty-state contract (default client copy)', () => {
    renderComposer({ disabled: true });
    expect(screen.getByRole('textbox', { name: 'Message Priya' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Message Priya' })).toHaveAttribute(
      'placeholder',
      'Messaging opens once an expert expresses interest…'
    );
    expect(screen.getByRole('button', { name: 'Attach a file' })).toBeDisabled();
  });

  it('uses the lens-aware disabled placeholder when provided', () => {
    renderComposer({
      disabled: true,
      disabledPlaceholder: 'Messaging opens once you express interest…',
    });
    expect(screen.getByRole('textbox', { name: 'Message Priya' })).toHaveAttribute(
      'placeholder',
      'Messaging opens once you express interest…'
    );
  });

  /**
   * The "typing…" hooks. The composer reports RAW edits — the caller's typing machine throttles
   * — so these pin exactly which interaction maps to which hook, and that a composer without
   * them behaves exactly as before.
   */
  describe('typing signal hooks', () => {
    it('reports onTyping on every edit that leaves real text — and no stop', async () => {
      const user = userEvent.setup();
      const { onTyping, onTypingStopped, textarea } = renderTypingComposer();

      await user.type(textarea, 'Hi!');

      expect(onTyping).toHaveBeenCalledTimes(3);
      expect(onTypingStopped).not.toHaveBeenCalled();
    });

    it('treats whitespace-only edits as NOT typing', async () => {
      const user = userEvent.setup();
      const { onTyping, onTypingStopped, textarea } = renderTypingComposer();

      await user.type(textarea, '  ');

      expect(onTyping).not.toHaveBeenCalled();
      expect(onTypingStopped).toHaveBeenCalledTimes(2);
    });

    it('reports onTypingStopped once the input is cleared', async () => {
      const user = userEvent.setup();
      const { onTyping, onTypingStopped, textarea } = renderTypingComposer();

      await user.type(textarea, 'ok');
      await user.type(textarea, '{Backspace}');
      // One character left — still typing.
      expect(onTyping).toHaveBeenCalledTimes(3);
      expect(onTypingStopped).not.toHaveBeenCalled();

      await user.type(textarea, '{Backspace}');
      expect(textarea).toHaveValue('');
      expect(onTypingStopped).toHaveBeenCalledTimes(1);
      expect(onTyping).toHaveBeenCalledTimes(3);
    });

    it('reports onTypingStopped when Enter sends — AFTER the send is dispatched', async () => {
      const user = userEvent.setup();
      const { onSend, onTypingStopped, textarea } = renderTypingComposer();

      await user.type(textarea, 'Hello{Enter}');

      expect(onSend).toHaveBeenCalledWith('Hello');
      // Enter keeps focus, so this stop can only have come from the send itself.
      expect(textarea).toHaveFocus();
      expect(onTypingStopped).toHaveBeenCalledTimes(1);
      const [stopOrder] = onTypingStopped.mock.invocationCallOrder;
      const [sendOrder] = onSend.mock.invocationCallOrder;
      // ⚠ Next runs a page's Server Actions one at a time: the message must not queue behind
      // the typing stop.
      expect(sendOrder).toBeLessThan(stopOrder ?? 0);
    });

    it('⚠⚠ a REAL click on Send keeps focus in the box — the send is dispatched BEFORE the stop', async () => {
      const user = userEvent.setup();
      const { onSend, onTypingStopped, textarea } = renderTypingComposer();

      await user.type(textarea, 'Hello');
      // `user.click` moves focus on mousedown, exactly as a browser does — unlike `fireEvent`.
      await user.click(screen.getByRole('button', { name: 'Send message' }));

      await waitFor(() => expect(onSend).toHaveBeenCalledWith('Hello'));
      expect(textarea).toHaveFocus();
      // No blur stop ahead of the send: exactly one stop, and it follows the send.
      expect(onTypingStopped).toHaveBeenCalledTimes(1);
      const [sendOrder] = onSend.mock.invocationCallOrder;
      const [stopOrder] = onTypingStopped.mock.invocationCallOrder;
      expect(sendOrder).toBeLessThan(stopOrder ?? 0);
    });

    it('reports onTypingStopped when the send BUTTON sends', async () => {
      const { onSend, onTypingStopped } = renderTypingComposer({ initialValue: 'Hello' });

      // `fireEvent` moves no focus, so no blur can stand in for the send path here.
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

      await waitFor(() => expect(onSend).toHaveBeenCalledWith('Hello'));
      expect(onTypingStopped).toHaveBeenCalledTimes(1);
    });

    it('does NOT report a stop for a blocked (over-limit) Enter — the writer is still composing', async () => {
      const { onSend, onTypingStopped, textarea } = renderTypingComposer({
        initialValue: 'x'.repeat(MESSAGE_MAX_TEXT + 1),
      });

      fireEvent.keyDown(textarea, { key: 'Enter' });

      expect(onSend).not.toHaveBeenCalled();
      expect(onTypingStopped).not.toHaveBeenCalled();
    });

    it('reports onTypingStopped on blur', async () => {
      const user = userEvent.setup();
      const onFocusChange = vi.fn();
      const { onTypingStopped, textarea } = renderTypingComposer({ onFocusChange });

      await user.type(textarea, 'Draft');
      expect(onTypingStopped).not.toHaveBeenCalled();
      await user.tab();

      expect(onTypingStopped).toHaveBeenCalledTimes(1);
      // The existing focus hook still fires alongside it.
      expect(onFocusChange).toHaveBeenLastCalledWith(false);
    });

    it('changes nothing when the hooks are absent — typing, clearing, sending and blur all work', async () => {
      const user = userEvent.setup();
      const { onSend } = renderComposer();
      const textarea = screen.getByRole('textbox', { name: 'Message Priya' });

      await user.type(textarea, 'ab{Backspace}{Backspace}');
      expect(textarea).toHaveValue('');
      await user.type(textarea, 'Sent anyway{Enter}');
      await user.tab();

      expect(onSend).toHaveBeenCalledWith('Sent anyway');
      await waitFor(() => expect(textarea).toHaveValue(''));
    });
  });
});
